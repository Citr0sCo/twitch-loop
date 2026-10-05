using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/channels")]
public sealed class ChannelsController(TwitchApiClient twitch) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(new { data = Array.Empty<object>(), complete = false, message = "Connect with Twitch to build the catalogue." });

    [HttpGet("status")]
    public IActionResult Status() => Ok(new { data = Array.Empty<object>(), freshness = "unknown" });

    [HttpPost("refresh")]
    public IActionResult Refresh() => Accepted(new { status = "queued" });

    [HttpPost("candidates")]
    public IActionResult AddCandidate([FromBody] CandidateRequest request) => Ok(new { login = request.Login.Trim().ToLowerInvariant(), verification = "pending" });

    public sealed record CandidateRequest(string Login);
}
