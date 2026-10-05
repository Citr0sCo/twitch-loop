using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace TwitchLoop.Infrastructure;

public sealed record TwitchStream(string Id, string UserId, string UserLogin, string UserName, DateTimeOffset StartedAt, string Language, string GameName);
public sealed record TwitchFollow(string BroadcasterId, string BroadcasterLogin, string BroadcasterName, DateTimeOffset FollowedAt);
public sealed record TwitchApiResult<T>(IReadOnlyList<T> Data, bool Complete, string? Error = null);

public sealed class TwitchApiClient(HttpClient httpClient, IConfiguration configuration, ILogger<TwitchApiClient> logger)
{
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
                using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/streams");
                foreach (var login in batch) request.Headers.Add("user_login", login);
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
        string? cursor = null;
        try
        {
            for (var page = 0; page < 100; page++)
            {
                var query = $"https://api.twitch.tv/helix/channels/followed?user_id={Uri.EscapeDataString(userId)}&first=100";
                if (!string.IsNullOrWhiteSpace(cursor)) query += $"&after={Uri.EscapeDataString(cursor)}";
                using var request = new HttpRequestMessage(HttpMethod.Get, query);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                request.Headers.Add("Client-Id", clientId);
                using var response = await httpClient.SendAsync(request, cancellationToken);
                if (!response.IsSuccessStatusCode)
                {
                    logger.LogWarning("Twitch followed channels request returned {StatusCode}", response.StatusCode);
                    return new([], false, $"http_{(int)response.StatusCode}");
                }
                var payload = await response.Content.ReadFromJsonAsync<FollowsResponse>(cancellationToken: cancellationToken);
                if (payload is null) return new([], false, "invalid_response");
                follows.AddRange(payload.Data);
                cursor = payload.Pagination?.GetValueOrDefault("cursor");
                if (string.IsNullOrWhiteSpace(cursor)) return new(follows, true);
            }
            return new([], false, "pagination_limit");
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch followed channels request failed");
            return new([], false, "network_error");
        }
    }

    private sealed record FollowsResponse(
        [property: JsonPropertyName("data")] List<TwitchFollow> Data,
        [property: JsonPropertyName("pagination")] Dictionary<string, string>? Pagination);

    private sealed record StreamsResponse([property: JsonPropertyName("data")] List<TwitchStream> Data);
}
