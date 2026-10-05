namespace TwitchLoop.Core;

public static class ScheduleValidation
{
    public static IReadOnlyList<string> Validate(IReadOnlyList<ScheduleSlot> slots)
    {
        var errors = new List<string>();
        var enabledTimes = new HashSet<TimeOnly>();
        foreach (var slot in slots)
        {
            if (!slot.Enabled) continue;
            if (!enabledTimes.Add(slot.StartTime)) errors.Add($"Enabled start time {slot.StartTime:HH\\:mm} is duplicated.");
            var channels = slot.Channels.Where(channel => channel.Trim().Length > 0).ToArray();
            var duplicates = channels.GroupBy(channel => channel.Trim(), StringComparer.OrdinalIgnoreCase)
                .Where(group => group.Key.Length > 0 && group.Count() > 1).Select(group => group.Key);
            errors.AddRange(duplicates.Select(channel => $"Channel {channel} is duplicated in slot {slot.Id}."));
            if (channels.Any(channel => ScheduleChannels.IsAutomaticFallback(channel) && !string.Equals(channel, channels[^1], StringComparison.OrdinalIgnoreCase))) errors.Add($"Automatic fallbacks must be last in slot {slot.Id}.");
        }
        return errors;
    }
}
