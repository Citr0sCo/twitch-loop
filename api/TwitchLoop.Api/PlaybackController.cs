using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/playback")]
public sealed class PlaybackController(TwitchPlaybackClient playback, IHttpClientFactory httpClientFactory) : ControllerBase
{
    private const string ProxyClientName = "twitch-playback-proxy";

    [HttpGet("{channel}/master.m3u8")]
    public async Task<IActionResult> Master(string channel, CancellationToken cancellationToken)
    {
        if (!TwitchPlaybackClient.IsValidLogin(channel)) return BadRequest(new { error = "invalid_channel" });

        var master = await playback.GetMasterAsync(channel, cancellationToken);
        if (master is null || master.Variants.Count == 0) return NotFound(new { error = "stream_unavailable" });

        var body = TwitchPlaylistParser.RewriteMaster(master.Variants, ManifestUrl);
        return Content(body, "application/vnd.apple.mpegurl");
    }

    [HttpGet("manifest.m3u8")]
    public async Task<IActionResult> Manifest([FromQuery] string u, CancellationToken cancellationToken)
    {
        if (!TryGetUpstream(u, out var upstream)) return BadRequest(new { error = "invalid_manifest_url" });

        var client = httpClientFactory.CreateClient(ProxyClientName);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));

        try
        {
            using var response = await client.GetAsync(upstream, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.RequestMessage?.RequestUri is { } finalUri && !TwitchPlaylistParser.IsAllowedHost(finalUri))
                return StatusCode(StatusCodes.Status502BadGateway, new { error = "manifest_redirect_rejected" });
            if (!response.IsSuccessStatusCode) return StatusCode((int)response.StatusCode);

            var playlist = await response.Content.ReadAsStringAsync(timeout.Token);
            var body = TwitchPlaylistParser.RewriteMedia(playlist, upstream, SegmentUrl);
            return Content(body, "application/vnd.apple.mpegurl");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return StatusCode(StatusCodes.Status504GatewayTimeout, new { error = "manifest_timeout" });
        }
        catch (HttpRequestException)
        {
            return StatusCode(StatusCodes.Status502BadGateway, new { error = "manifest_unavailable" });
        }
    }

    [HttpGet("segment")]
    public async Task ProxySegment([FromQuery] string u, CancellationToken cancellationToken)
    {
        if (!TryGetUpstream(u, out var upstream))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            await Response.WriteAsJsonAsync(new { error = "invalid_segment_url" }, cancellationToken);
            return;
        }

        var client = httpClientFactory.CreateClient(ProxyClientName);
        using var request = new HttpRequestMessage(HttpMethod.Get, upstream);
        if (!string.IsNullOrWhiteSpace(Request.Headers.Range))
            request.Headers.TryAddWithoutValidation("Range", Request.Headers.Range.ToString());

        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.RequestMessage?.RequestUri is { } finalUri && !TwitchPlaylistParser.IsAllowedHost(finalUri))
            {
                Response.StatusCode = StatusCodes.Status502BadGateway;
                return;
            }

            Response.StatusCode = (int)response.StatusCode;
            if (response.Content.Headers.ContentType is { } contentType) Response.ContentType = contentType.ToString();
            if (response.Content.Headers.ContentLength is { } contentLength) Response.ContentLength = contentLength;
            if (response.Content.Headers.ContentRange is { } contentRange) Response.Headers["Content-Range"] = contentRange.ToString();
            if (response.Headers.AcceptRanges.Count > 0) Response.Headers["Accept-Ranges"] = response.Headers.AcceptRanges.ToString();
            if (response.Headers.ETag is { } etag) Response.Headers["ETag"] = etag.ToString();
            if (response.Content.Headers.LastModified is { } lastModified) Response.Headers["Last-Modified"] = lastModified.ToString("R");

            await response.Content.CopyToAsync(Response.Body, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The browser went away; there is no response left to write.
        }
        catch (HttpRequestException)
        {
            if (!Response.HasStarted) Response.StatusCode = StatusCodes.Status502BadGateway;
        }
    }

    private static string ManifestUrl(string upstream) => "/api/playback/manifest.m3u8?u=" + Uri.EscapeDataString(upstream);
    private static string SegmentUrl(string upstream) => "/api/playback/segment?u=" + Uri.EscapeDataString(upstream);

    private static bool TryGetUpstream(string value, out Uri upstream)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var uri) && TwitchPlaylistParser.IsAllowedHost(uri))
        {
            upstream = uri;
            return true;
        }

        upstream = null!;
        return false;
    }
}
