using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/sessions")]
public sealed class SessionsController(SqliteStore store) : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Start(CancellationToken cancellationToken)
    {
        var session = await store.CreateSessionAsync(await store.GetSettingsAsync(cancellationToken), cancellationToken);
        return Created($"/api/sessions/{session.Id}", ToResponse(session));
    }

    [HttpGet("{id}/current-stream")]
    public async Task<IActionResult> Current(string id, CancellationToken cancellationToken)
    {
        var session = await store.GetSessionAsync(id, cancellationToken);
        return session is null ? NotFound() : Ok(ToResponse(session));
    }

    [HttpPost("{id}/actions")]
    public async Task<IActionResult> Action(string id, [FromBody] SessionAction action, CancellationToken cancellationToken)
    {
        if (action.Name is not ("stop" or "pauseAuto" or "resumeAuto" or "selectChannel")) return BadRequest(new { error = "unsupported_action" });
        var session = await store.UpdateSessionAsync(id, action.Name, action.Channel, cancellationToken);
        return session is null ? NotFound() : Ok(ToResponse(session));
    }

    [HttpPost("{id}/refresh-hint")]
    public IActionResult RefreshHint(string id) => Accepted(new { status = "coalesced", sessionId = id });

    [HttpPost("{id}/playback-events")]
    public IActionResult RecordPlaybackEvent(string id, [FromBody] PlaybackEvent request) => Accepted(new { sessionId = id, eventName = request.EventName });

    [HttpGet("{id}/history")]
    public IActionResult History(string id) => Ok(new { sessionId = id, decisions = Array.Empty<object>() });

    private static object ToResponse(StoredSession session) => new
    {
        sessionId = session.Id, revision = session.Revision, state = session.State, automationMode = session.AutomationMode, channel = session.Channel,
        selectionTier = session.Channel is null ? null : "scheduled", activeSlotId = (string?)null, nextSlotTime = (string?)null,
        reason = session.State == "waiting" ? "awaiting_fresh_live_status" : "session_started", statusFreshness = "unknown",
        pollAfterSeconds = 15, settingsVersion = 1, expiresAt = session.ExpiresAt
    };

    public sealed record SessionAction(string Name, string? Channel);
    public sealed record PlaybackEvent(string EventName);
}
