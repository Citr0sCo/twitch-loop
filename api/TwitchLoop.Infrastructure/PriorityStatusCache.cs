using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed record PriorityChannelStatus(string Login, bool IsLive);
public sealed record PriorityStatusSnapshot(IReadOnlyList<PriorityChannelStatus> Channels, DateTimeOffset? CheckedAt);

public sealed class PriorityStatusCache
{
    private PriorityStatusSnapshot snapshot = new([], null);

    public PriorityStatusSnapshot Snapshot => Volatile.Read(ref snapshot);

    public void Update(IEnumerable<Candidate> candidates, DateTimeOffset checkedAt)
    {
        var channels = candidates
            .Select(candidate => new PriorityChannelStatus(candidate.Login, candidate.Status == LiveStatus.Live))
            .ToArray();
        Volatile.Write(ref snapshot, new PriorityStatusSnapshot(channels, checkedAt));
    }
}
