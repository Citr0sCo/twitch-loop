using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Core;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

public sealed record ScheduleSlotRequest(string Id, bool Enabled, string StartTime, IReadOnlyList<string> Channels);

[ApiController]
[Authorize]
[Route("api/schedule")]
public sealed class ScheduleController(SqliteStore store) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken) => Ok(new { version = 1, timeZone = (await store.GetSettingsAsync(cancellationToken)).TimeZone, slots = await store.GetScheduleAsync(cancellationToken) });

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] SchedulePutRequest request, CancellationToken cancellationToken)
    {
        var slots = new List<ScheduleSlot>();
        foreach (var item in request.Slots)
        {
            if (!TimeOnly.TryParseExact(item.StartTime, "HH:mm", out var time)) return BadRequest(new { error = "invalid_start_time", item.Id });
            slots.Add(new ScheduleSlot(item.Id, item.Enabled, time, item.Channels.Select(channel => channel.Trim()).Where(channel => channel.Length > 0).ToArray()));
        }
        var errors = ScheduleValidation.Validate(slots);
        if (errors.Count > 0) return BadRequest(new { error = "invalid_schedule", errors });
        await store.SaveScheduleAsync(slots, request.Version, request.Source ?? "database", cancellationToken);
        return Ok(new { version = request.Version + 1, slots });
    }
}

public sealed record SchedulePutRequest(int Version, IReadOnlyList<ScheduleSlotRequest> Slots, string? Source);
