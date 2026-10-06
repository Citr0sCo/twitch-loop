namespace TwitchLoop.Core;

public sealed class SelectionEngine
{
    private readonly IRandomSource random;

    public SelectionEngine(IRandomSource random) => this.random = random;

    public SelectionResult Select(
        IReadOnlyList<string> priorityChannels,
        IReadOnlyList<Candidate> priorityCandidates,
        IReadOnlyList<Candidate> followingCandidates,
        IReadOnlyList<Candidate> twitchWideCandidates,
        bool followingComplete,
        bool twitchWideComplete,
        string? excludedChannel)
    {
        foreach (var login in priorityChannels)
        {
            if (string.Equals(login, ScheduleChannels.AnyFollowing, StringComparison.OrdinalIgnoreCase))
            {
                var following = Live(followingCandidates);
                if (following.Count > 0) return PickOrKeep(following, excludedChannel, SelectionTier.Personal, "any_following_live");
                if (!followingComplete) return new SelectionResult(null, null, "any_following_status_unknown");
                continue;
            }

            if (string.Equals(login, ScheduleChannels.Any, StringComparison.OrdinalIgnoreCase))
            {
                var twitchWide = Live(twitchWideCandidates);
                if (twitchWide.Count > 0) return PickOrKeep(twitchWide, excludedChannel, SelectionTier.TwitchWide, "any_twitch_live");
                if (!twitchWideComplete) return new SelectionResult(null, null, "any_twitch_status_unknown");
                continue;
            }

            var candidate = Find(priorityCandidates, login);
            if (candidate is null || candidate.Status == LiveStatus.Unknown)
            {
                return new SelectionResult(null, null, "priority_channel_status_unknown");
            }

            if (candidate.Status == LiveStatus.Live)
            {
                return new SelectionResult(candidate.Login, SelectionTier.Priority, "priority_channel_live");
            }
        }

        return new SelectionResult(null, null, "no_live_candidate");
    }

    private SelectionResult PickOrKeep(IReadOnlyList<Candidate> candidates, string? current, SelectionTier tier, string reason)
    {
        var active = candidates.FirstOrDefault(candidate => Same(candidate.Login, current));
        return new SelectionResult(active?.Login ?? candidates[random.Next(candidates.Count)].Login, tier, reason);
    }

    private static Candidate? Find(IEnumerable<Candidate> candidates, string login) =>
        candidates.FirstOrDefault(candidate => Same(candidate.Login, login));

    private static List<Candidate> Live(IEnumerable<Candidate> candidates) => candidates
        .Where(candidate => candidate.Status == LiveStatus.Live)
        .GroupBy(candidate => candidate.Login, StringComparer.OrdinalIgnoreCase)
        .Select(group => group.First())
        .ToList();

    private static bool Same(string? left, string? right) => left is not null && right is not null &&
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}
