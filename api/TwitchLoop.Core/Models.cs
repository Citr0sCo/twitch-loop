namespace TwitchLoop.Core;

public enum LiveStatus { Unknown, Offline, Live }
public enum SelectionTier { Scheduled, Personal, Discovery }

public static class ScheduleChannels
{
    public const string AnyFollowing = "any-following";
    public const string Any = "any";

    public static IReadOnlyList<string> Normalize(IEnumerable<string> channels)
    {
        var result = channels.Select(channel => channel.Trim())
            .Where(channel => channel.Length > 0 && !IsAutomaticFallback(channel))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        result.Add(AnyFollowing);
        result.Add(Any);
        return result;
    }

    public static bool IsAutomaticFallback(string channel) =>
        string.Equals(channel, AnyFollowing, StringComparison.OrdinalIgnoreCase) || string.Equals(channel, Any, StringComparison.OrdinalIgnoreCase);
}

public sealed record ScheduleSlot(string Id, bool Enabled, TimeOnly StartTime, IReadOnlyList<string> Channels);
public sealed record EvaluatedSlot(string? SlotId, IReadOnlyList<string> Channels, DateOnly LocalDate);
public sealed record Candidate(string Id, string Login, LiveStatus Status);
public sealed record SelectionResult(string? Channel, SelectionTier? Tier, string Reason);

public sealed class AppSettings
{
    public int Version { get; set; } = 1;
    public string TimeZone { get; set; } = "Europe/London";
    public string ChannelPoolMode { get; set; } = "paidSubscriptions";
    public bool KeepAwake { get; set; } = true;
    public bool AutoMaximiseStream { get; set; } = true;
    public string MaximiseMode { get; set; } = "theatre";
    public int TwitchPollSeconds { get; set; } = 60;
    public int BrowserPollSeconds { get; set; } = 15;
    public bool RandomDiscoveryEnabled { get; set; } = true;
    public int SessionDurationHours { get; set; } = 24;
    public string Source { get; set; } = "database";
}

public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public interface IRandomSource
{
    int Next(int maxExclusive);
}

public sealed class SystemClock : IClock
{
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
}

public sealed class SystemRandomSource : IRandomSource
{
    public int Next(int maxExclusive) => Random.Shared.Next(maxExclusive);
}
