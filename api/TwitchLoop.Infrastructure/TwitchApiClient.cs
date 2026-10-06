using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace TwitchLoop.Infrastructure;

public sealed record TwitchStream(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("user_id")] string UserId,
    [property: JsonPropertyName("user_login")] string UserLogin,
    [property: JsonPropertyName("user_name")] string UserName,
    [property: JsonPropertyName("started_at")] DateTimeOffset StartedAt,
    [property: JsonPropertyName("language")] string Language,
    [property: JsonPropertyName("game_name")] string GameName);
public sealed record TwitchFollow(
    [property: JsonPropertyName("broadcaster_id")] string BroadcasterId,
    [property: JsonPropertyName("broadcaster_login")] string BroadcasterLogin,
    [property: JsonPropertyName("broadcaster_name")] string BroadcasterName,
    [property: JsonPropertyName("followed_at")] DateTimeOffset FollowedAt);
public sealed record TwitchIdentity(string Id, string Login, string DisplayName, string ProfileImageUrl);
public sealed record TwitchApiResult<T>(IReadOnlyList<T> Data, bool Complete, string? Error = null);
public sealed record TwitchTokenRefresh(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt);
public sealed record TwitchTokenRefreshResult(TwitchTokenRefresh? Tokens, int? FailureStatusCode);

public sealed class TwitchApiClient(HttpClient httpClient, IConfiguration configuration, ILogger<TwitchApiClient> logger)
{
    public async Task<TwitchIdentity?> GetCurrentUserAsync(string? accessToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken) || string.IsNullOrWhiteSpace(configuration["TWITCH_CLIENT_ID"])) return null;
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/users");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Add("Client-Id", configuration["TWITCH_CLIENT_ID"]);
        try
        {
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode) return null;
            var payload = await response.Content.ReadFromJsonAsync<UsersResponse>(cancellationToken: cancellationToken);
            var user = payload?.Data.FirstOrDefault();
            return user is null ? null : new TwitchIdentity(user.Id, user.Login, user.DisplayName, user.ProfileImageUrl);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch identity request failed");
            return null;
        }
    }

    public async Task<TwitchTokenRefreshResult> RefreshAccessTokenAsync(string? refreshToken, CancellationToken cancellationToken)
    {
        var clientId = configuration["TWITCH_CLIENT_ID"];
        var clientSecret = configuration["TWITCH_CLIENT_SECRET"];
        if (string.IsNullOrWhiteSpace(refreshToken) || string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        {
            logger.LogWarning("Twitch access token refresh is unavailable because a refresh token or OAuth client configuration is missing");
            return new(null, null);
        }

        try
        {
            using var response = await httpClient.PostAsync("https://id.twitch.tv/oauth2/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["client_secret"] = clientSecret,
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = refreshToken
            }), cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Twitch token refresh returned {StatusCode}", (int)response.StatusCode);
                return new(null, (int)response.StatusCode);
            }

            var payload = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken: cancellationToken);
            if (payload is null || string.IsNullOrWhiteSpace(payload.AccessToken) || payload.ExpiresIn <= 0)
            {
                logger.LogWarning("Twitch token refresh returned an incomplete response");
                return new(null, null);
            }

            return new(new TwitchTokenRefresh(
                payload.AccessToken,
                string.IsNullOrWhiteSpace(payload.RefreshToken) ? refreshToken : payload.RefreshToken,
                DateTimeOffset.UtcNow.AddSeconds(payload.ExpiresIn)), null);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch token refresh request failed");
            return new(null, null);
        }
        catch (System.Text.Json.JsonException exception)
        {
            logger.LogWarning(exception, "Twitch token refresh response could not be parsed");
            return new(null, null);
        }
    }

    public async Task<TwitchApiResult<TwitchStream>> GetStreamsAsync(IEnumerable<string> userLogins, string? accessToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken)) return new([], false, "not_connected");
        var clientId = configuration["TWITCH_CLIENT_ID"];
        if (string.IsNullOrWhiteSpace(clientId)) return new([], false, "setup_required");
        var logins = userLogins.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var batches = logins.Length == 0 ? [Array.Empty<string>()] : logins.Chunk(100);
        var streams = new List<TwitchStream>();
        try
        {
            foreach (var batch in batches)
            {
                var query = string.Join("&", batch.Select(login => $"user_login={Uri.EscapeDataString(login)}"));
                var uri = "https://api.twitch.tv/helix/streams?first=100" + (query.Length == 0 ? "" : $"&{query}");
                using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Add("Client-Id", clientId);
                using var response = await httpClient.SendAsync(request, cancellationToken);
                if (!response.IsSuccessStatusCode)
                {
                    logger.LogWarning("Twitch stream request returned {StatusCode}", response.StatusCode);
                    return new([], false, $"http_{(int)response.StatusCode}");
                }
                var payload = await response.Content.ReadFromJsonAsync<StreamsResponse>(cancellationToken: cancellationToken);
                if (payload is null) return new([], false, "invalid_response");
                streams.AddRange(payload.Data);
            }
            return new(streams, true);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch stream request failed");
            return new([], false, "network_error");
        }
    }

    public async Task<TwitchApiResult<TwitchFollow>> GetFollowedChannelsAsync(string userId, string? accessToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken)) return new([], false, "not_connected");
        var clientId = configuration["TWITCH_CLIENT_ID"];
        if (string.IsNullOrWhiteSpace(clientId)) return new([], false, "setup_required");
        var follows = new List<TwitchFollow>();
        var stopwatch = Stopwatch.StartNew();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        string? cursor = null;
        var pagesRetrieved = 0;
        try
        {
            for (var page = 0; page < 100; page++)
            {
                var query = $"https://api.twitch.tv/helix/channels/followed?user_id={Uri.EscapeDataString(userId)}&first=100";
                if (!string.IsNullOrWhiteSpace(cursor)) query += $"&after={Uri.EscapeDataString(cursor)}";
                using var request = new HttpRequestMessage(HttpMethod.Get, query);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Add("Client-Id", clientId);
                using var response = await httpClient.SendAsync(request, timeout.Token);
                if (!response.IsSuccessStatusCode)
                {
                    logger.LogWarning("Twitch followed channels request returned {StatusCode} on page {Page} after {ElapsedMilliseconds} ms", response.StatusCode, page + 1, stopwatch.ElapsedMilliseconds);
                    return new([], false, $"http_{(int)response.StatusCode}");
                }
                var payload = await response.Content.ReadFromJsonAsync<FollowsResponse>(cancellationToken: timeout.Token);
                if (payload is null) return new([], false, "invalid_response");
                follows.AddRange(payload.Data);
                pagesRetrieved++;
                cursor = payload.Pagination?.GetValueOrDefault("cursor");
                if (string.IsNullOrWhiteSpace(cursor)) return new(follows, true);
            }
            return new([], false, "pagination_limit");
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "Twitch followed channels request timed out after {ElapsedMilliseconds} ms with {PagesRetrieved} pages retrieved", stopwatch.ElapsedMilliseconds, pagesRetrieved);
            return new([], false, "timeout");
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch followed channels request failed after {ElapsedMilliseconds} ms with {PagesRetrieved} pages retrieved", stopwatch.ElapsedMilliseconds, pagesRetrieved);
            return new([], false, "network_error");
        }
    }

    private sealed record FollowsResponse(
        [property: JsonPropertyName("data")] List<TwitchFollow> Data,
        [property: JsonPropertyName("pagination")] Dictionary<string, string>? Pagination);

    private sealed record TokenResponse(
        [property: JsonPropertyName("access_token")] string? AccessToken,
        [property: JsonPropertyName("refresh_token")] string? RefreshToken,
        [property: JsonPropertyName("expires_in")] int ExpiresIn);

    private sealed record UsersResponse([property: JsonPropertyName("data")] List<TwitchUser> Data);
    private sealed record TwitchUser(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("login")] string Login,
        [property: JsonPropertyName("display_name")] string DisplayName,
        [property: JsonPropertyName("profile_image_url")] string ProfileImageUrl);
    private sealed record StreamsResponse([property: JsonPropertyName("data")] List<TwitchStream> Data);
}
