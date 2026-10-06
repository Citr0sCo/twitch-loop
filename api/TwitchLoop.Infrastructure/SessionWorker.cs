using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed class SessionWorker(SqliteStore store, TwitchApiClient twitch, TokenStore tokens, IClock clock, IRandomSource random, ILogger<SessionWorker> logger) : BackgroundService
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
        var followingCandidates = followedLogins.Select(login => new Candidate(login, login, live.Contains(login) ? LiveStatus.Live : LiveStatus.Offline)).ToArray();
        var twitchWide = await twitch.GetStreamsAsync([], accessToken, cancellationToken);
        var twitchWideCandidates = twitchWide.Data.Select(stream => new Candidate(stream.UserId, stream.UserLogin, LiveStatus.Live)).ToArray();
        var engine = new SelectionEngine(random);
        foreach (var session in sessions)
        {
            var decision = engine.Select(priorityChannels, priorityCandidates, followingCandidates, twitchWideCandidates, followed.Complete, twitchWide.Complete, session.Channel);
            if (decision.Channel is not null && !string.Equals(decision.Channel, session.Channel, StringComparison.OrdinalIgnoreCase))
            {
                await store.UpdateSessionAsync(session.Id, "autoSelect", decision.Channel, cancellationToken);
            }
            else if (decision.Channel is null && session.Channel is not null && !live.Contains(session.Channel))
            {
                await store.UpdateSessionAsync(session.Id, "autoSelect", null, cancellationToken);
            }
            logger.LogDebug("Evaluated session {SessionId}: {Reason}", session.Id, decision.Reason);
        }
    }
}
