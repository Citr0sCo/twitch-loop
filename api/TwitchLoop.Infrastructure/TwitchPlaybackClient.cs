using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace TwitchLoop.Infrastructure;

public sealed record PlaybackVariant(string Quality, string Uri, bool AdFree, string MediaLine, string StreamLine);
public sealed record PlaybackMaster(IReadOnlyList<PlaybackVariant> Variants);
public sealed record PlaybackToken(string Value, string Signature);

public sealed class TwitchPlaybackClient(HttpClient httpClient, ILogger<TwitchPlaybackClient> logger)
{
    private const string WebClientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";
    private const string AccessTokenQuery = """
        query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {
          streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
            value
            signature
            authorization { isForbidden forbiddenReasonCode }
          }
          videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
            value
            signature
          }
        }
        """;
    private static readonly Regex ChannelPattern = new("^[A-Za-z0-9_]{1,25}$", RegexOptions.Compiled);

    public static bool IsValidLogin(string login) => ChannelPattern.IsMatch(login);

    public async Task<PlaybackMaster?> GetMasterAsync(string login, CancellationToken cancellationToken)
    {
        if (!IsValidLogin(login)) return null;
        login = login.ToLowerInvariant();

        var siteTokenTask = GetTokenAsync(login, "ios", "site", cancellationToken);
        var autoplayTokenTask = GetTokenAsync(login, "android", "autoplay", cancellationToken);
        await Task.WhenAll(siteTokenTask, autoplayTokenTask);

        var siteToken = await siteTokenTask;
        var autoplayToken = await autoplayTokenTask;
        if (siteToken is null && autoplayToken is null) return null;

        var sitePlaylistTask = siteToken is null
            ? Task.FromResult<string?>(null)
            : FetchMasterAsync(login, siteToken, cancellationToken);
        var autoplayPlaylistTask = autoplayToken is null
            ? Task.FromResult<string?>(null)
            : FetchMasterAsync(login, autoplayToken, cancellationToken);
        await Task.WhenAll(sitePlaylistTask, autoplayPlaylistTask);

        var sitePlaylist = await sitePlaylistTask;
        var autoplayPlaylist = await autoplayPlaylistTask;

        var siteVariants = string.IsNullOrWhiteSpace(sitePlaylist)
            ? Array.Empty<PlaybackVariant>()
            : TwitchPlaylistParser.ParseMaster(sitePlaylist);
        IReadOnlyList<PlaybackVariant> autoplayVariants = string.IsNullOrWhiteSpace(autoplayPlaylist)
            ? Array.Empty<PlaybackVariant>()
            : TwitchPlaylistParser.ParseMaster(autoplayPlaylist);

        var merged = siteVariants.Count > 0
            ? TwitchPlaylistParser.Merge(siteVariants, autoplayVariants)
            : autoplayVariants.Select(variant => variant with { AdFree = true }).ToList();
        return merged.Count == 0 ? null : new PlaybackMaster(merged);
    }

    private async Task<PlaybackToken?> GetTokenAsync(string login, string platform, string playerType, CancellationToken cancellationToken)
    {
        try
        {
            var body = new
            {
                operationName = "PlaybackAccessToken_Template",
                query = AccessTokenQuery,
                variables = new { isLive = true, login, isVod = false, vodID = "", platform, playerType }
            };
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://gql.twitch.tv/gql")
            {
                Content = JsonContent.Create(body)
            };
            request.Headers.Add("Client-ID", WebClientId);
            request.Headers.UserAgent.ParseAdd("TwitchLoop/1.0");
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Twitch playback token request returned {StatusCode}", (int)response.StatusCode);
                return null;
            }

            var payload = await response.Content.ReadFromJsonAsync<GqlResponse>(cancellationToken: cancellationToken);
            var token = payload?.Data?.StreamPlaybackAccessToken;
            if (token is null || token.Authorization?.IsForbidden == true) return null;
            if (string.IsNullOrWhiteSpace(token.Value) || string.IsNullOrWhiteSpace(token.Signature)) return null;
            return new PlaybackToken(token.Value, token.Signature);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or JsonException)
        {
            logger.LogWarning(exception, "Twitch playback token request failed");
            return null;
        }
    }

    private async Task<string?> FetchMasterAsync(string login, PlaybackToken token, CancellationToken cancellationToken)
    {
        var url = $"https://usher.ttvnw.net/api/channel/hls/{Uri.EscapeDataString(login)}.m3u8" +
                  $"?client_id={WebClientId}&token={Uri.EscapeDataString(token.Value)}&sig={Uri.EscapeDataString(token.Signature)}" +
                  "&allow_source=true&allow_audio_only=true";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.UserAgent.ParseAdd("TwitchLoop/1.0");
            using var response = await httpClient.SendAsync(request, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogInformation("Twitch HLS master request for {Login} returned {StatusCode}", login, (int)response.StatusCode);
                return null;
            }
            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning(exception, "Twitch HLS master request failed for {Login}", login);
            return null;
        }
    }

    private sealed record GqlResponse([property: JsonPropertyName("data")] GqlData? Data);
    private sealed record GqlData([property: JsonPropertyName("streamPlaybackAccessToken")] GqlToken? StreamPlaybackAccessToken);
    private sealed record GqlToken(
        [property: JsonPropertyName("value")] string? Value,
        [property: JsonPropertyName("signature")] string? Signature,
        [property: JsonPropertyName("authorization")] GqlAuthorization? Authorization);
    private sealed record GqlAuthorization(
        [property: JsonPropertyName("isForbidden")] bool IsForbidden,
        [property: JsonPropertyName("forbiddenReasonCode")] string? ForbiddenReasonCode);
}

public static class TwitchPlaylistParser
{
    private static readonly Regex NameQuality = new(@"(?<quality>\d+p|audio_only)", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex AttributePattern = new(@"(?<name>[A-Za-z0-9-]+)=(?:""(?<value>[^""]*)""|(?<value>[^,]*))", RegexOptions.Compiled);
    private static readonly Regex UriAttribute = new(@"(?<![A-Za-z0-9-])URI=""(?<uri>[^""]+)""", RegexOptions.Compiled);

    public static IReadOnlyList<PlaybackVariant> ParseMaster(string playlist)
    {
        var variants = new List<PlaybackVariant>();
        var media = new Dictionary<string, (string Line, string Quality)>(StringComparer.OrdinalIgnoreCase);
        string? pendingMediaLine = null;
        string? pendingStreamLine = null;

        foreach (var raw in playlist.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;

            if (line.StartsWith("#EXT-X-MEDIA:", StringComparison.Ordinal))
            {
                if (Attribute(line, "TYPE")?.Equals("VIDEO", StringComparison.OrdinalIgnoreCase) != true) continue;
                var group = Attribute(line, "GROUP-ID");
                if (string.IsNullOrWhiteSpace(group)) continue;
                media[group] = (line, QualityFromName(Attribute(line, "NAME")));
                continue;
            }

            if (line.StartsWith("#EXT-X-STREAM-INF:", StringComparison.Ordinal))
            {
                pendingStreamLine = line;
                pendingMediaLine = null;
                var group = Attribute(line, "VIDEO");
                if (!string.IsNullOrWhiteSpace(group) && media.TryGetValue(group, out var entry)) pendingMediaLine = entry.Line;
                continue;
            }

            if (line.StartsWith("#", StringComparison.Ordinal) || pendingStreamLine is null) continue;

            variants.Add(new PlaybackVariant(
                QualityFromStream(pendingMediaLine, pendingStreamLine),
                line,
                false,
                pendingMediaLine ?? "",
                pendingStreamLine));
            pendingStreamLine = null;
            pendingMediaLine = null;
        }

        return variants;
    }

    public static IReadOnlyList<PlaybackVariant> Merge(IReadOnlyList<PlaybackVariant> site, IReadOnlyList<PlaybackVariant> autoplay)
    {
        var adFree = autoplay
            .Where(variant => !string.IsNullOrWhiteSpace(variant.Quality))
            .GroupBy(variant => variant.Quality, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);

        var merged = new List<PlaybackVariant>(site.Count);
        foreach (var variant in site)
        {
            merged.Add(adFree.TryGetValue(variant.Quality, out var adFreeVariant)
                ? variant with { Uri = adFreeVariant.Uri, AdFree = true }
                : variant with { AdFree = false });
        }

        foreach (var variant in adFree.Values)
        {
            if (!merged.Any(existing => existing.Quality.Equals(variant.Quality, StringComparison.OrdinalIgnoreCase)))
                merged.Add(variant with { AdFree = true });
        }

        return merged;
    }

    public static string RewriteMaster(IReadOnlyList<PlaybackVariant> variants, Func<string, string> proxyUrl)
    {
        var builder = new StringBuilder();
        builder.AppendLine("#EXTM3U");
        builder.AppendLine("#EXT-X-VERSION:3");
        builder.AppendLine("#EXT-X-INDEPENDENT-SEGMENTS");

        foreach (var variant in variants)
        {
            if (!string.IsNullOrWhiteSpace(variant.MediaLine)) builder.AppendLine(variant.MediaLine);
            var streamLine = variant.StreamLine.TrimEnd();
            var extra = $"X-TWITCH-LOOP-AD-FREE={(variant.AdFree ? "YES" : "NO")},X-TWITCH-LOOP-QUALITY=\"{variant.Quality}\"";
            builder.AppendLine(streamLine.EndsWith(',') ? streamLine + extra : streamLine + "," + extra);
            builder.AppendLine(proxyUrl(variant.Uri));
        }

        return builder.ToString();
    }

    public static string RewriteMedia(string playlist, Uri baseUri, Func<string, string> proxyUrl)
    {
        var builder = new StringBuilder(playlist.Length + 1024);

        foreach (var raw in playlist.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0)
            {
                builder.AppendLine();
                continue;
            }

            if (line[0] == '#')
            {
                if (line.Contains("URI=\"", StringComparison.Ordinal))
                {
                    line = UriAttribute.Replace(line, match =>
                    {
                        var value = match.Groups["uri"].Value;
                        return Uri.TryCreate(baseUri, value, out var resolved)
                            ? $"URI=\"{proxyUrl(resolved.ToString())}\""
                            : match.Value;
                    });
                }
                builder.AppendLine(line);
                continue;
            }

            if (Uri.TryCreate(baseUri, line, out var segment)) builder.AppendLine(proxyUrl(segment.ToString()));
            else builder.AppendLine(line);
        }

        return builder.ToString();
    }

    public static bool IsAllowedHost(Uri uri)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme != Uri.UriSchemeHttps) return false;
        var host = uri.Host;
        return host.Equals("ttvnw.net", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".ttvnw.net", StringComparison.OrdinalIgnoreCase)
            || host.Equals("live-video.net", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".live-video.net", StringComparison.OrdinalIgnoreCase);
    }

    private static string QualityFromName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "";
        var match = NameQuality.Match(name);
        return match.Success ? match.Groups["quality"].Value.ToLowerInvariant() : "";
    }

    private static string QualityFromStream(string? mediaLine, string streamLine)
    {
        var quality = QualityFromName(Attribute(mediaLine ?? "", "NAME"));
        if (string.IsNullOrWhiteSpace(quality))
        {
            var resolution = Attribute(streamLine, "RESOLUTION");
            if (!string.IsNullOrWhiteSpace(resolution))
            {
                var height = resolution.Split('x').LastOrDefault()?.Split('.').FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(height)) quality = height + "p";
            }
        }

        if (quality.Length > 0 && !quality.Equals("audio_only", StringComparison.OrdinalIgnoreCase))
        {
            var frameRate = Attribute(streamLine, "FRAME-RATE");
            if (double.TryParse(frameRate, NumberStyles.Float, CultureInfo.InvariantCulture, out var fps) && fps > 0)
                quality += ((int)Math.Round(fps)).ToString(CultureInfo.InvariantCulture);
        }

        return quality;
    }

    private static string? Attribute(string line, string name)
    {
        foreach (Match match in AttributePattern.Matches(line))
        {
            if (match.Groups["name"].Value.Equals(name, StringComparison.OrdinalIgnoreCase))
                return match.Groups["value"].Value;
        }
        return null;
    }
}
