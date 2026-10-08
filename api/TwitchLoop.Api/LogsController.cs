using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/logs")]
public sealed class LogsController(SqliteStore store) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Recent(CancellationToken cancellationToken) => Ok(await store.GetRecentEventsAsync(250, cancellationToken));

    [HttpPost("playback-started")]
    public async Task<IActionResult> PlaybackStarted([FromBody] PlaybackStartedRequest request, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(request.SessionId, out var sessionId) || string.IsNullOrWhiteSpace(request.Channel) || request.Channel.Length > 25 || !request.Channel.All(character => char.IsAsciiLetterOrDigit(character) || character == '_'))
        {
            return BadRequest(new { error = "invalid_playback_event" });
        }

        var session = await store.GetSessionAsync(sessionId.ToString("N"), cancellationToken);
        if (session is null || !string.Equals(session.Channel, request.Channel, StringComparison.OrdinalIgnoreCase)) return NotFound();
        await store.RecordEventAsync("stream_started", $"Stream started: {session.Channel}", "Twitch player reported playback", cancellationToken);
        return Accepted();
    }

    [HttpPost("presence")]
    public async Task<IActionResult> Heartbeat([FromBody] ClientHeartbeat request, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(request.ClientId, out var clientId)) return BadRequest(new { error = "invalid_client_id" });
        var (browser, device) = DescribeClient(Request.Headers.UserAgent.ToString());
        await store.HeartbeatClientAsync(clientId.ToString("N"), browser, device, cancellationToken);
        return NoContent();
    }

    private static (string Browser, string Device) DescribeClient(string userAgent)
    {
        var browser = userAgent.Contains("Edg/", StringComparison.OrdinalIgnoreCase) ? "Edge"
            : userAgent.Contains("OPR/", StringComparison.OrdinalIgnoreCase) ? "Opera"
            : userAgent.Contains("Firefox/", StringComparison.OrdinalIgnoreCase) || userAgent.Contains("FxiOS/", StringComparison.OrdinalIgnoreCase) ? "Firefox"
            : userAgent.Contains("CriOS/", StringComparison.OrdinalIgnoreCase) ? "Chrome on iOS"
            : userAgent.Contains("Chrome/", StringComparison.OrdinalIgnoreCase) ? "Chrome"
            : userAgent.Contains("Safari/", StringComparison.OrdinalIgnoreCase) ? "Safari"
            : "Unknown browser";

        var device = userAgent.Contains("iPhone", StringComparison.OrdinalIgnoreCase) ? "iPhone"
            : userAgent.Contains("iPad", StringComparison.OrdinalIgnoreCase) ? "iPad"
            : userAgent.Contains("Android", StringComparison.OrdinalIgnoreCase) ? "Android device"
            : userAgent.Contains("Windows", StringComparison.OrdinalIgnoreCase) ? "Windows PC"
            : userAgent.Contains("Macintosh", StringComparison.OrdinalIgnoreCase) ? "Mac"
            : userAgent.Contains("Linux", StringComparison.OrdinalIgnoreCase) ? "Linux PC"
            : "Unknown device";
        return (browser, device);
    }

    public sealed record ClientHeartbeat(string ClientId);
    public sealed record PlaybackStartedRequest(string SessionId, string Channel);
}
