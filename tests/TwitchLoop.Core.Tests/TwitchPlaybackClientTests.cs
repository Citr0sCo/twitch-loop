using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using NUnit.Framework;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Core.Tests;

public sealed class TwitchPlaybackClientTests
{
    private const string SiteMaster = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
        #EXT-X-STREAM-INF:BANDWIDTH=6938721,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
        https://euw12.playlist.ttvnw.net/1080.m3u8
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES
        #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000
        https://euw12.playlist.ttvnw.net/360.m3u8
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
        #EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
        https://euw12.playlist.ttvnw.net/audio.m3u8
        """;

    private const string AutoplayMaster = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="360p30",NAME="360p",AUTOSELECT=YES,DEFAULT=YES
        #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="360p30",FRAME-RATE=30.000
        https://euw11.playlist.ttvnw.net/360.m3u8
        #EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
        #EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
        https://euw11.playlist.ttvnw.net/audio.m3u8
        """;

    [Test]
    public void ParseMasterExtractsQualityAndStreamLines()
    {
        var variants = TwitchPlaylistParser.ParseMaster(SiteMaster);

        Assert.That(variants.Select(variant => variant.Quality), Is.EqualTo(new[] { "1080p60", "360p30", "audio_only" }));
        Assert.That(variants[0].Uri, Is.EqualTo("https://euw12.playlist.ttvnw.net/1080.m3u8"));
        Assert.That(variants[0].MediaLine, Does.Contain("NAME=\"1080p60 (source)\""));
        Assert.That(variants[0].StreamLine, Does.Contain("RESOLUTION=1920x1080"));
    }

    [Test]
    public void MergeUsesAutoplayUriForMatchingQualitiesOnly()
    {
        var merged = TwitchPlaylistParser.Merge(
            TwitchPlaylistParser.ParseMaster(SiteMaster),
            TwitchPlaylistParser.ParseMaster(AutoplayMaster));

        Assert.That(merged, Has.Count.EqualTo(3));
        var high = merged.Single(variant => variant.Quality == "1080p60");
        var low = merged.Single(variant => variant.Quality == "360p30");
        var audio = merged.Single(variant => variant.Quality == "audio_only");

        Assert.That(high.AdFree, Is.False);
        Assert.That(high.Uri, Is.EqualTo("https://euw12.playlist.ttvnw.net/1080.m3u8"));
        Assert.That(low.AdFree, Is.True);
        Assert.That(low.Uri, Is.EqualTo("https://euw11.playlist.ttvnw.net/360.m3u8"));
        Assert.That(audio.AdFree, Is.True);
        Assert.That(audio.Uri, Is.EqualTo("https://euw11.playlist.ttvnw.net/audio.m3u8"));
    }

    [Test]
    public void RewriteMasterAddsAdFreeMetadataAndProxyUrls()
    {
        var merged = TwitchPlaylistParser.Merge(
            TwitchPlaylistParser.ParseMaster(SiteMaster),
            TwitchPlaylistParser.ParseMaster(AutoplayMaster));

        var rewritten = TwitchPlaylistParser.RewriteMaster(merged, url => "/api/playback/manifest.m3u8?u=" + Uri.EscapeDataString(url));

        Assert.That(rewritten, Does.Contain("X-TWITCH-LOOP-AD-FREE=NO"));
        Assert.That(rewritten, Does.Contain("X-TWITCH-LOOP-AD-FREE=YES"));
        Assert.That(rewritten, Does.Contain("/api/playback/manifest.m3u8?u=https%3A%2F%2Feuw12.playlist.ttvnw.net%2F1080.m3u8"));
    }

    [Test]
    public void RewriteMediaProxiesSegmentsAndUriAttributesButKeepsAdRanges()
    {
        const string playlist = """
            #EXTM3U
            #EXT-X-DATERANGE:ID="stitched-ad-123",CLASS="twitch-stitched-ad",START-DATE="2026-10-20T10:00:00.000Z",DURATION=30.0
            #EXT-X-MAP:URI="init.mp4"
            #EXTINF:6.0,
            segment-1.ts
            #EXTINF:6.0,
            https://video-weaver.euw12.hls.ttvnw.net/segment-2.ts
            """;

        var rewritten = TwitchPlaylistParser.RewriteMedia(
            playlist,
            new Uri("https://euw12.playlist.ttvnw.net/live.m3u8"),
            url => "/api/playback/segment?u=" + Uri.EscapeDataString(url));

        Assert.That(rewritten, Does.Contain("#EXT-X-DATERANGE:ID=\"stitched-ad-123\""));
        Assert.That(rewritten, Does.Contain("/api/playback/segment?u=" + Uri.EscapeDataString("https://euw12.playlist.ttvnw.net/init.mp4")));
        Assert.That(rewritten, Does.Contain("/api/playback/segment?u=" + Uri.EscapeDataString("https://euw12.playlist.ttvnw.net/segment-1.ts")));
        Assert.That(rewritten, Does.Contain("/api/playback/segment?u=" + Uri.EscapeDataString("https://video-weaver.euw12.hls.ttvnw.net/segment-2.ts")));
    }

    [TestCase("https://euw12.playlist.ttvnw.net/live.m3u8", true)]
    [TestCase("https://video-weaver.euw12.hls.ttvnw.net/segment.ts", true)]
    [TestCase("https://885544.rufio.hls.live-video.net/segment.ts", true)]
    [TestCase("http://euw12.playlist.ttvnw.net/live.m3u8", false)]
    [TestCase("https://ttvnw.net.evil.example/live.m3u8", false)]
    [TestCase("https://evil.example/live.m3u8", false)]
    public void AllowedHostsAreRestrictedToTwitchCdn(string value, bool expected)
    {
        Assert.That(TwitchPlaylistParser.IsAllowedHost(new Uri(value)), Is.EqualTo(expected));
    }

    [Test]
    public async Task GetMasterRequestsBothTokensAndPrefersAutoplayVariants()
    {
        var handler = new PlaybackHandler();
        using var httpClient = new HttpClient(handler);
        var client = new TwitchPlaybackClient(httpClient, NullLogger<TwitchPlaybackClient>.Instance);

        var master = await client.GetMasterAsync("streamer", CancellationToken.None);

        Assert.That(master, Is.Not.Null);
        Assert.That(master!.Variants.Single(variant => variant.Quality == "1080p60").AdFree, Is.False);
        Assert.That(master.Variants.Single(variant => variant.Quality == "360p30").AdFree, Is.True);
        Assert.That(master.Variants.Single(variant => variant.Quality == "360p30").Uri, Does.Contain("playlist.ttvnw.net"));
    }

    private sealed class PlaybackHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri!.Host == "gql.twitch.tv")
            {
                using var document = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(cancellationToken));
                var platform = document.RootElement.GetProperty("variables").GetProperty("platform").GetString();
                var value = platform == "android" ? "autoplay-token" : "site-token";
                var body = JsonSerializer.Serialize(new
                {
                    data = new
                    {
                        streamPlaybackAccessToken = new
                        {
                            value,
                            signature = "signature",
                            authorization = new { isForbidden = false, forbiddenReasonCode = "NONE" }
                        }
                    }
                });
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            }

            if (request.RequestUri.Host == "usher.ttvnw.net")
            {
                var token = request.RequestUri.Query
                    .Split('&', StringSplitOptions.RemoveEmptyEntries)
                    .Select(part => part.Split('=', 2))
                    .Where(parts => parts.Length == 2 && parts[0] == "token")
                    .Select(parts => Uri.UnescapeDataString(parts[1]))
                    .FirstOrDefault();
                var body = token == "autoplay-token" ? AutoplayMaster : SiteMaster;
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/vnd.apple.mpegurl") };
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }
}
