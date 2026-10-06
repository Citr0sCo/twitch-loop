using System.Diagnostics;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/channels")]
public sealed class ChannelsController(TwitchApiClient twitch, SqliteStore store, TokenStore tokens, TimeZoneInfo timeZone, ILogger<ChannelsController> logger) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { data = Array.Empty<object>(), complete = false, message = "Connect with Twitch to build the catalogue." });

    [HttpGet("following")]
    public async Task<IActionResult> Following(CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var phase = "connection lookup";
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            var connection = await store.GetConnectionAsync(timeout.Token);
            if (connection is null) return Problem("Reconnect with Twitch to load followed channels.", statusCode: StatusCodes.Status409Conflict);
            var accessToken = tokens.Unprotect(connection.EncryptedAccessToken);
            var twitchUserId = connection.TwitchUserId;
            if (string.IsNullOrWhiteSpace(twitchUserId))
            {
                phase = "Twitch identity lookup";
                var identity = await twitch.GetCurrentUserAsync(accessToken, timeout.Token);
                if (identity is null) return Problem("Reconnect with Twitch to load followed channels.", statusCode: StatusCodes.Status409Conflict);
                twitchUserId = identity.Id;
                await store.SaveConnectionAsync(identity.Id, connection.EncryptedAccessToken, connection.EncryptedRefreshToken, connection.Scopes, connection.ExpiresAt, timeout.Token);
            }

            phase = "Twitch followed-channel lookup";
            var result = await twitch.GetFollowedChannelsAsync(twitchUserId, accessToken, timeout.Token);
            if (!result.Complete)
            {
                logger.LogWarning("Following channels request failed during {Phase} after {ElapsedMilliseconds} ms: {Error}", phase, stopwatch.ElapsedMilliseconds, result.Error);
                return Problem("Twitch followed channels could not be loaded. Try again shortly.", statusCode: StatusCodes.Status502BadGateway);
            }

            logger.LogInformation("Loaded {ChannelCount} followed channels in {ElapsedMilliseconds} ms", result.Data.Count, stopwatch.ElapsedMilliseconds);
            return Ok(new
            {
                data = result.Data.Select(channel => new { id = channel.BroadcasterId, login = channel.BroadcasterLogin, name = channel.BroadcasterName }),
                complete = result.Complete
            });
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "Following channels request timed out during {Phase} after {ElapsedMilliseconds} ms", phase, stopwatch.ElapsedMilliseconds);
            return Problem("Loading followed channels timed out. Try again shortly.", statusCode: StatusCodes.Status504GatewayTimeout);
        }
    }


    [HttpGet("status")]
    public IActionResult Status() => Ok(new { data = Array.Empty<object>(), freshness = "unknown" });

    [HttpGet("priority-status")]
    public async Task<IActionResult> PriorityStatus([FromServices] PriorityStatusCache status, CancellationToken cancellationToken)
    {
        var snapshot = status.Snapshot;
        var liveByLogin = snapshot.Channels.ToDictionary(channel => channel.Login, channel => channel.IsLive, StringComparer.OrdinalIgnoreCase);
        var channels = await store.GetScheduleAsync(cancellationToken);
        var configured = channels.Where(channel => !TwitchLoop.Core.ScheduleChannels.IsAutomaticFallback(channel))
            .Select(login => new { login, isLive = liveByLogin.TryGetValue(login, out var isLive) ? (bool?)isLive : null });
        return Ok(new { channels = configured, checkedAt = snapshot.CheckedAt, timeZone = timeZone.Id });
    }

    [HttpPost("refresh")]
    public IActionResult Refresh() => Accepted(new { status = "queued" });

    [HttpPost("candidates")]
    public IActionResult AddCandidate([FromBody] CandidateRequest request) => Ok(new { login = request.Login.Trim().ToLowerInvariant(), verification = "pending" });

    public sealed record CandidateRequest(string Login);
}
