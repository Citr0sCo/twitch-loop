using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Core;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/schedule")]
public sealed class ScheduleController(SqliteStore store) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken) => Ok(new { version = 1, channels = await store.GetScheduleAsync(cancellationToken) });

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] SchedulePutRequest request, CancellationToken cancellationToken)
    {
        var channels = request.Channels ?? [];
        var errors = ScheduleValidation.Validate(channels);
        if (errors.Count > 0) return BadRequest(new { error = "invalid_schedule", errors });
        var normalized = ScheduleChannels.Normalize(channels);
        await store.SaveScheduleAsync(normalized, request.Version, request.Source ?? "database", cancellationToken);
        var configured = normalized.Where(channel => !ScheduleChannels.IsAutomaticFallback(channel));
        var details = configured.Any() ? $"Configured order: {string.Join(" → ", configured)}" : "No configured streamers; automatic fallbacks remain active.";
        await store.RecordEventAsync("priority_list_updated", "Streamer priority list updated", details, cancellationToken);
        return Ok(new { version = request.Version + 1, channels = normalized });
    }
}

public sealed record SchedulePutRequest(int Version, IReadOnlyList<string>? Channels, string? Source);
