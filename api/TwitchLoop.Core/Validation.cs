namespace TwitchLoop.Core;

public static class ScheduleValidation
{
    public static IReadOnlyList<string> Validate(IReadOnlyList<string> channels)
    {
        var errors = new List<string>();
        var explicitChannels = channels.Where(channel => !string.IsNullOrWhiteSpace(channel))
            .Where(channel => !ScheduleChannels.IsAutomaticFallback(channel.Trim())).ToArray();
        var duplicates = explicitChannels.GroupBy(channel => channel.Trim(), StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Key.Length > 0 && group.Count() > 1).Select(group => group.Key);
        errors.AddRange(duplicates.Select(channel => $"Channel {channel} is duplicated."));
        errors.AddRange(explicitChannels.Where(channel => channel.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_') || channel.Length > 25)
            .Select(channel => $"Channel {channel} is not a valid Twitch login."));
        return errors;
    }
}
