using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace TwitchLoop.Infrastructure;

public sealed class SessionWorker(SqliteStore store, TwitchApiClient twitch, TokenStore tokens, TwitchLoop.Core.IClock clock, TwitchLoop.Core.IRandomSource random, ILogger<SessionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { await EvaluateAsync(stoppingToken); }
            catch (Exception exception) when (exception is not OperationCanceledException) { logger.LogError(exception, "Session evaluation tick failed"); }
        }
    }

    private async Task EvaluateAsync(CancellationToken cancellationToken)
    {
        var sessions = await store.GetActiveSessionsAsync(clock.UtcNow, cancellationToken);
        if (sessions.Count == 0) return;
        var settings = await store.GetSettingsAsync(cancellationToken);
        var connection = await store.GetConnectionAsync(cancellationToken);
        if (connection is null || connection.ExpiresAt <= clock.UtcNow) return;
        var timeZone = ResolveTimeZone(settings.TimeZone);
        var evaluated = new TwitchLoop.Core.ScheduleEvaluator().Evaluate(await store.GetScheduleAsync(cancellationToken), clock.UtcNow, timeZone);
        var accessToken = tokens.Unprotect(connection.EncryptedAccessToken);
        var followed = string.IsNullOrWhiteSpace(connection.TwitchUserId)
            ? new TwitchApiResult<TwitchFollow>([], false, "missing_user_id")
            : await twitch.GetFollowedChannelsAsync(connection.TwitchUserId, accessToken, cancellationToken);
        var scheduledLogins = evaluated.Channels.Where(channel => !TwitchLoop.Core.ScheduleChannels.IsAutomaticFallback(channel)).ToArray();
        var followedLogins = followed.Data.Select(channel => channel.BroadcasterLogin).ToArray();
        var activeLogins = sessions.Select(session => session.Channel).OfType<string>();
        var trackedLogins = scheduledLogins.Concat(followedLogins).Concat(activeLogins).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var status = await twitch.GetStreamsAsync(trackedLogins, accessToken, cancellationToken);
        var live = status.Data.Select(stream => stream.UserLogin).ToHashSet(StringComparer.OrdinalIgnoreCase);
        TwitchLoop.Core.LiveStatus StatusFor(string login) => status.Complete ? (live.Contains(login) ? TwitchLoop.Core.LiveStatus.Live : TwitchLoop.Core.LiveStatus.Offline) : TwitchLoop.Core.LiveStatus.Unknown;
        var scheduledCandidates = scheduledLogins.Select(login => new TwitchLoop.Core.Candidate(login, login, StatusFor(login))).ToArray();
        var followingCandidates = followedLogins.Select(login => new TwitchLoop.Core.Candidate(login, login, StatusFor(login))).ToArray();
        var discovery = await twitch.GetStreamsAsync([], accessToken, cancellationToken);
        var discoveryCandidates = discovery.Complete
            ? discovery.Data.Select(stream => new TwitchLoop.Core.Candidate(stream.Id, stream.UserLogin, TwitchLoop.Core.LiveStatus.Live)).ToArray()
            : Array.Empty<TwitchLoop.Core.Candidate>();
        var engine = new TwitchLoop.Core.SelectionEngine(random);
        foreach (var session in sessions)
        {
            if (session.Channel is not null && status.Complete && live.Contains(session.Channel)) continue;
            var decision = engine.Select(evaluated.Channels, scheduledCandidates, followingCandidates, discoveryCandidates, session.Channel, settings.RandomDiscoveryEnabled);
            await store.UpdateSessionAsync(session.Id, "autoSelect", decision.Channel, cancellationToken);
            logger.LogDebug("Evaluated session {SessionId}: {Reason}", session.Id, decision.Reason);
        }
    }

    private static TimeZoneInfo ResolveTimeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
        catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
    }
}
