using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/channels")]
public sealed class ChannelsController(TwitchApiClient twitch, SqliteStore store, TokenStore tokens) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { data = Array.Empty<object>(), complete = false, message = "Connect with Twitch to build the catalogue." });

    [HttpGet("following")]
    public async Task<IActionResult> Following(CancellationToken cancellationToken)
    {
        var connection = await store.GetConnectionAsync(cancellationToken);
        if (connection is null || string.IsNullOrWhiteSpace(connection.TwitchUserId)) return Problem("Reconnect with Twitch to load followed channels.", statusCode: StatusCodes.Status409Conflict);
        var result = await twitch.GetFollowedChannelsAsync(connection.TwitchUserId, tokens.Unprotect(connection.EncryptedAccessToken), cancellationToken);
        if (!result.Complete) return Problem("Twitch followed channels could not be loaded.", statusCode: StatusCodes.Status502BadGateway);
        return Ok(new
        {
            data = result.Data.Select(channel => new { id = channel.BroadcasterId, login = channel.BroadcasterLogin, name = channel.BroadcasterName }),
            complete = result.Complete
        });
    }


    [HttpGet("status")]
    public IActionResult Status() => Ok(new { data = Array.Empty<object>(), freshness = "unknown" });

    [HttpPost("refresh")]
    public IActionResult Refresh() => Accepted(new { status = "queued" });

    [HttpPost("candidates")]
    public IActionResult AddCandidate([FromBody] CandidateRequest request) => Ok(new { login = request.Login.Trim().ToLowerInvariant(), verification = "pending" });

    public sealed record CandidateRequest(string Login);
}
