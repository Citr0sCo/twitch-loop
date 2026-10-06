using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Core;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Authorize]
[Route("api/settings")]
public sealed class SettingsController(SqliteStore store) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken cancellationToken) => Ok(await store.GetSettingsAsync(cancellationToken));

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] AppSettings settings, [FromHeader(Name = "If-Match")] int? expectedVersion, CancellationToken cancellationToken)
    {
        var errors = new Dictionary<string, string[]>();
        if (settings.BrowserPollSeconds is < 5 or > 120 || settings.SessionDurationHours is < 1 or > 24) errors["polling"] = ["Browser polling and session values are outside the supported range."];
        if (settings.MaximiseMode is not ("theatre" or "fullscreen")) errors["maximiseMode"] = ["Maximise mode must be theatre or fullscreen."];
        if (errors.Count > 0) return BadRequest(new { errors });
        var current = await store.GetSettingsAsync(cancellationToken);
        if (expectedVersion.HasValue && expectedVersion.Value != current.Version) return Conflict(new { error = "settings_version_conflict", version = current.Version });
        return Ok(await store.SaveSettingsAsync(settings, current.Version, cancellationToken));
    }
}
