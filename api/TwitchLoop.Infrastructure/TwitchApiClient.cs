using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace TwitchLoop.Infrastructure;

public sealed record TwitchStream(string Id, string UserId, string UserLogin, string UserName, DateTimeOffset StartedAt, string Language, string GameName);
public sealed record TwitchApiResult<T>(IReadOnlyList<T> Data, bool Complete, string? Error = null);

public sealed class TwitchApiClient(HttpClient httpClient, IConfiguration configuration, ILogger<TwitchApiClient> logger)
{
    public async Task<TwitchApiResult<TwitchStream>> GetStreamsAsync(IEnumerable<string> userLogins, string? accessToken, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken)) return new([], false, "not_connected");
        var clientId = configuration["TWITCH_CLIENT_ID"];
        if (string.IsNullOrWhiteSpace(clientId)) return new([], false, "setup_required");
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/streams");
        foreach (var login in userLogins.Distinct(StringComparer.OrdinalIgnoreCase).Take(100)) request.Headers.Add("user_login", login);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Add("Client-Id", clientId);
        try
        {
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Twitch stream request returned {StatusCode}", response.StatusCode);
                return new([], false, $"http_{(int)response.StatusCode}");
            }
            var payload = await response.Content.ReadFromJsonAsync<StreamsResponse>(cancellationToken: cancellationToken);
            return new(payload?.Data ?? [], true);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Twitch stream request failed");
            return new([], false, "network_error");
        }
    }

    private sealed record StreamsResponse([property: JsonPropertyName("data")] List<TwitchStream> Data);
}
