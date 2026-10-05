namespace TwitchLoop.Core;

public sealed class SelectionEngine
{
    private readonly IRandomSource random;

    public SelectionEngine(IRandomSource random) => this.random = random;

    public SelectionResult Select(
        IReadOnlyList<string> scheduledChannels,
        IReadOnlyList<Candidate> personalCandidates,
        IReadOnlyList<Candidate> discoveryCandidates,
        string? excludedChannel,
        bool discoveryEnabled)
    {
        var scheduledUnknown = false;
        foreach (var login in scheduledChannels.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var candidate = Find(personalCandidates, discoveryCandidates, login);
            if (candidate is null || candidate.Status == LiveStatus.Unknown)
            {
                scheduledUnknown = true;
                continue;
            }

            if (candidate.Status == LiveStatus.Live && !Same(candidate.Login, excludedChannel))
            {
                return new SelectionResult(candidate.Login, SelectionTier.Scheduled, "scheduled_channel_live");
            }
        }

        if (scheduledUnknown)
        {
            return new SelectionResult(null, null, "scheduled_channel_status_unknown");
        }

        var personal = Live(personalCandidates, excludedChannel);
        if (personal.Count > 0)
        {
            return new SelectionResult(personal[random.Next(personal.Count)].Login, SelectionTier.Personal, "personal_channel_live");
        }

        if (discoveryEnabled)
        {
            var discovery = Live(discoveryCandidates, excludedChannel);
            if (discovery.Count > 0)
            {
                return new SelectionResult(discovery[random.Next(discovery.Count)].Login, SelectionTier.Discovery, "discovery_channel_live");
            }
        }

        return new SelectionResult(null, null, "no_live_candidate");
    }

    private static Candidate? Find(IEnumerable<Candidate> first, IEnumerable<Candidate> second, string login) =>
        first.Concat(second).FirstOrDefault(candidate => Same(candidate.Login, login));

    private static List<Candidate> Live(IEnumerable<Candidate> candidates, string? excluded) => candidates
        .Where(candidate => candidate.Status == LiveStatus.Live && !Same(candidate.Login, excluded))
        .GroupBy(candidate => candidate.Login, StringComparer.OrdinalIgnoreCase)
        .Select(group => group.First())
        .ToList();

    private static bool Same(string? left, string? right) => left is not null && right is not null &&
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
}
