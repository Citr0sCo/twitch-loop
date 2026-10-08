using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed class SessionWorker(SqliteStore store, TwitchApiClient twitch, TokenStore tokens, PriorityStatusCache priorityStatus, IClock clock, IRandomSource random, ILogger<SessionWorker> logger) : BackgroundService
{
    private const int PollSeconds = 60;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await EvaluateAsync(stoppingToken); }
            catch (Exception exception) when (exception is not OperationCanceledException) { logger.LogError(exception, "Session evaluation tick failed"); }
            await Task.Delay(TimeSpan.FromSeconds(PollSeconds), stoppingToken);
        }
    }

    public async Task EvaluateImmediatelyAsync(CancellationToken cancellationToken)
    {
        try { await EvaluateAsync(cancellationToken); }
        catch (Exception exception) when (exception is not OperationCanceledException) { logger.LogError(exception, "Immediate session evaluation failed"); }
    }

    private async Task EvaluateAsync(CancellationToken cancellationToken)
    {
        var sessions = await store.GetActiveSessionsAsync(clock.UtcNow, cancellationToken);
        if (sessions.Count == 0) return;
        var connection = await store.GetConnectionAsync(cancellationToken);
        if (connection is null || connection.ExpiresAt <= clock.UtcNow) return;

        var priorityChannels = await store.GetScheduleAsync(cancellationToken);
        var accessToken = tokens.Unprotect(connection.EncryptedAccessToken);
        var followed = string.IsNullOrWhiteSpace(connection.TwitchUserId)
            ? new TwitchApiResult<TwitchFollow>([], false, "missing_user_id")
            : await twitch.GetFollowedChannelsAsync(connection.TwitchUserId, accessToken, cancellationToken);
        var priorityLogins = priorityChannels.Where(channel => !ScheduleChannels.IsAutomaticFallback(channel)).ToArray();
        var followedLogins = followed.Data.Select(channel => channel.BroadcasterLogin).ToArray();
        var activeLogins = sessions.Select(session => session.Channel).OfType<string>();
        var trackedLogins = priorityLogins.Concat(followedLogins).Concat(activeLogins).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var status = await twitch.GetStreamsAsync(trackedLogins, accessToken, cancellationToken);
        if (!status.Complete) return;

        var live = status.Data.Select(stream => stream.UserLogin).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var priorityCandidates = priorityLogins.Select(login => new Candidate(login, login, live.Contains(login) ? LiveStatus.Live : LiveStatus.Offline)).ToArray();
        priorityStatus.Update(priorityCandidates, clock.UtcNow);
        var followingCandidates = followedLogins.Select(login => new Candidate(login, login, live.Contains(login) ? LiveStatus.Live : LiveStatus.Offline)).ToArray();
        var twitchWide = await twitch.GetStreamsAsync([], accessToken, cancellationToken);
        var twitchWideCandidates = twitchWide.Data.Select(stream => new Candidate(stream.UserId, stream.UserLogin, LiveStatus.Live)).ToArray();
        var engine = new SelectionEngine(random);
        foreach (var session in sessions)
        {
            var decision = engine.Select(priorityChannels, priorityCandidates, followingCandidates, twitchWideCandidates, followed.Complete, twitchWide.Complete, session.Channel);
            var tier = decision.Tier switch
            {
                SelectionTier.Priority => "priority",
                SelectionTier.Personal => "any-following",
                SelectionTier.TwitchWide => "any",
                _ => null
            };
            if (decision.Channel is not null &&
                (!string.Equals(decision.Channel, session.Channel, StringComparison.OrdinalIgnoreCase) || tier != session.SelectionTier))
            {
                var reason = ExplainSelection(decision.Reason, session.Channel, decision.Channel, live);
                await store.UpdateSessionAsync(session.Id, "autoSelect", decision.Channel, cancellationToken, tier, reason);
            }
            else if (decision.Channel is null && session.Channel is not null && !live.Contains(session.Channel))
            {
                var reason = decision.Reason switch
                {
                    "any_following_status_unknown" => $"{session.Channel} went offline; followed-stream status is unavailable, so no fallback could be confirmed.",
                    "any_twitch_status_unknown" => $"{session.Channel} went offline; Twitch-wide fallback status is unavailable, so no fallback could be confirmed.",
                    _ => $"{session.Channel} went offline; all configured streamers and available fallbacks are offline."
                };
                await store.UpdateSessionAsync(session.Id, "autoSelect", null, cancellationToken, selectionReason: reason);
            }
            logger.LogDebug("Evaluated session {SessionId}: {Reason}", session.Id, decision.Reason);
        }
    }

    private static string ExplainSelection(string reason, string? previousChannel, string? nextChannel, IReadOnlySet<string> live)
    {
        if (previousChannel is not null && !live.Contains(previousChannel))
        {
            return reason switch
            {
                "priority_channel_live" => $"{previousChannel} went offline; a higher-priority configured streamer ({nextChannel}) is live.",
                "any_following_live" => $"{previousChannel} went offline; no configured streamer is live, so a live followed streamer ({nextChannel}) is being used.",
                "any_twitch_live" => $"{previousChannel} went offline; no configured or followed streamer is live, so {nextChannel} is being used as the Twitch-wide fallback.",
                _ => $"{previousChannel} went offline; {nextChannel} was selected by the configured priority rules."
            };
        }

        return reason switch
        {
            "priority_channel_live" => previousChannel is null ? $"Highest-priority configured streamer {nextChannel} is live." : $"Higher-priority configured streamer {nextChannel} went live.",
            "any_following_live" => $"No higher-priority configured streamer is live; selected live followed streamer {nextChannel}.",
            "any_twitch_live" => $"No configured or followed streamer is live; selected Twitch-wide fallback {nextChannel}.",
            "no_live_candidate" => "All configured streamers and available fallbacks are offline.",
            _ => $"Selected {nextChannel} using the configured priority rules."
        };
    }
}
