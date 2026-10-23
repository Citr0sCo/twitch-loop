using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed record PriorityChannelStatus(string Login, bool IsLive);
public sealed record LiveStreamStatus(string Login, string Name, int ViewerCount, DateTimeOffset StartedAt, string? GameName);
public sealed record PriorityStatusSnapshot(IReadOnlyList<PriorityChannelStatus> Channels, IReadOnlyList<LiveStreamStatus> LiveStreams, DateTimeOffset? CheckedAt);

public sealed class PriorityStatusCache
{
    private PriorityStatusSnapshot snapshot = new([], [], null);

    public PriorityStatusSnapshot Snapshot => Volatile.Read(ref snapshot);

    public void Update(IEnumerable<Candidate> candidates, IEnumerable<TwitchStream> liveStreams, DateTimeOffset checkedAt)
    {
        var channels = candidates
            .Select(candidate => new PriorityChannelStatus(candidate.Login, candidate.Status == LiveStatus.Live))
            .ToArray();
        var streams = liveStreams
            .DistinctBy(stream => stream.UserLogin, StringComparer.OrdinalIgnoreCase)
            .Select(stream => new LiveStreamStatus(stream.UserLogin, stream.UserName, stream.ViewerCount, stream.StartedAt, string.IsNullOrWhiteSpace(stream.GameName) ? null : stream.GameName))
            .ToArray();
        Volatile.Write(ref snapshot, new PriorityStatusSnapshot(channels, streams, checkedAt));
    }
}
