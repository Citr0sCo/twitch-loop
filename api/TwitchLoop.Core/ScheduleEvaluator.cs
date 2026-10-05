namespace TwitchLoop.Core;

public sealed class ScheduleEvaluator
{
    public EvaluatedSlot Evaluate(IReadOnlyList<ScheduleSlot> slots, DateTimeOffset utcNow, TimeZoneInfo timeZone)
    {
        var local = TimeZoneInfo.ConvertTime(utcNow, timeZone);
        var enabled = slots.Where(slot => slot.Enabled).OrderBy(slot => slot.StartTime).ToArray();
        if (enabled.Length == 0)
        {
            return new EvaluatedSlot(null, Array.Empty<string>(), DateOnly.FromDateTime(local.Date));
        }

        var current = enabled.LastOrDefault(slot => slot.StartTime <= TimeOnly.FromDateTime(local.DateTime));
        current ??= enabled[^1];
        return new EvaluatedSlot(current.Id, current.Channels, DateOnly.FromDateTime(local.Date));
    }
}

public static class ScheduleTimeZones
{
    public const string DefaultId = "Europe/London";

    public static TimeZoneInfo Resolve(string? id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(string.IsNullOrWhiteSpace(id) ? DefaultId : id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }
}

