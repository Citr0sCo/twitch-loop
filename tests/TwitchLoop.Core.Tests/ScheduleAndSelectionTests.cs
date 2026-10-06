using NUnit.Framework;
using TwitchLoop.Core;

namespace TwitchLoop.Core.Tests;

public sealed class ScheduleAndSelectionTests
{
    [Test]
    public void SelectsFirstLiveConfiguredChannelInPriorityOrder()
    {
        var result = Select(
            ["first", "second", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Live), Candidate("second", LiveStatus.Live)],
            [Candidate("followed", LiveStatus.Live)],
            [Candidate("global", LiveStatus.Live)]);

        Assert.That(result.Channel, Is.EqualTo("first"));
        Assert.That(result.Tier, Is.EqualTo(SelectionTier.Priority));
    }

    [Test]
    public void SkipsOfflineConfiguredChannelsAndPicksNextLiveChannel()
    {
        var result = Select(
            ["first", "second", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Offline), Candidate("second", LiveStatus.Live)],
            [Candidate("followed", LiveStatus.Live)],
            [Candidate("global", LiveStatus.Live)]);

        Assert.That(result.Channel, Is.EqualTo("second"));
        Assert.That(result.Tier, Is.EqualTo(SelectionTier.Priority));
    }

    [TestCase("second", "second")]
    [TestCase("third", "second")]
    public void KeepsHighestPriorityLiveConfiguredChannel(string current, string expected)
    {
        var result = Select(
            ["first", "second", "third", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Offline), Candidate("second", LiveStatus.Live), Candidate("third", LiveStatus.Live)],
            [],
            [],
            current: current);

        Assert.That(result.Channel, Is.EqualTo(expected));
    }

    [Test]
    public void FallsBackToAnyLiveFollowedChannelBeforeTwitchWideChannels()
    {
        var result = Select(
            ["first", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Offline)],
            [Candidate("followed", LiveStatus.Live)],
            [Candidate("global", LiveStatus.Live)]);

        Assert.That(result.Channel, Is.EqualTo("followed"));
        Assert.That(result.Tier, Is.EqualTo(SelectionTier.Personal));
        Assert.That(result.Reason, Is.EqualTo("any_following_live"));
    }

    [Test]
    public void FallsBackToAnyLiveTwitchChannelWhenNoFollowedChannelsAreLive()
    {
        var result = Select(
            ["first", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Offline)],
            [Candidate("followed", LiveStatus.Offline)],
            [Candidate("global", LiveStatus.Live)]);

        Assert.That(result.Channel, Is.EqualTo("global"));
        Assert.That(result.Tier, Is.EqualTo(SelectionTier.TwitchWide));
        Assert.That(result.Reason, Is.EqualTo("any_twitch_live"));
    }

    [Test]
    public void UnknownPriorityOrFallbackStatusDoesNotFallThrough()
    {
        var priorityUnknown = Select(["first", "second", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Unknown), Candidate("second", LiveStatus.Live)], [], [Candidate("global", LiveStatus.Live)]);
        var followsUnknown = Select(["first", ScheduleChannels.AnyFollowing, ScheduleChannels.Any],
            [Candidate("first", LiveStatus.Offline)], [], [Candidate("global", LiveStatus.Live)], followingComplete: false);

        Assert.That(priorityUnknown.Channel, Is.Null);
        Assert.That(priorityUnknown.Reason, Is.EqualTo("priority_channel_status_unknown"));
        Assert.That(followsUnknown.Channel, Is.Null);
        Assert.That(followsUnknown.Reason, Is.EqualTo("any_following_status_unknown"));
    }

    [Test]
    public void KeepsCurrentLiveRandomFallbackInsteadOfRedrawingEveryMinute()
    {
        var result = Select([ScheduleChannels.AnyFollowing, ScheduleChannels.Any], [],
            [Candidate("first", LiveStatus.Live), Candidate("current", LiveStatus.Live)], [], current: "current");

        Assert.That(result.Channel, Is.EqualTo("current"));
    }

    [Test]
    public void NormalizationAlwaysAppendsAutomaticFallbacksInOrder()
    {
        Assert.That(ScheduleChannels.Normalize([" First ", "second", "first", ScheduleChannels.Any]),
            Is.EqualTo(new[] { "first", "second", ScheduleChannels.AnyFollowing, ScheduleChannels.Any }));
    }

    [Test]
    public void ValidationRejectsDuplicateAndInvalidTwitchLogins()
    {
        var errors = ScheduleValidation.Validate(["alpha", "ALPHA", "bad-login"]);
        Assert.That(errors, Has.Count.EqualTo(2));
    }

    private static SelectionResult Select(
        IReadOnlyList<string> channels,
        IReadOnlyList<Candidate> configured,
        IReadOnlyList<Candidate> following,
        IReadOnlyList<Candidate> twitchWide,
        bool followingComplete = true,
        bool twitchWideComplete = true,
        string? current = null) =>
        new SelectionEngine(new FixedRandom(0)).Select(channels, configured, following, twitchWide, followingComplete, twitchWideComplete, current);

    private static Candidate Candidate(string login, LiveStatus status) => new(login, login, status);

    private sealed class FixedRandom(int value) : IRandomSource
    {
        public int Next(int maxExclusive) => Math.Min(value, maxExclusive - 1);
    }
}
