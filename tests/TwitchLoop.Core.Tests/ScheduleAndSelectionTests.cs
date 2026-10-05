using NUnit.Framework;
using TwitchLoop.Core;

namespace TwitchLoop.Core.Tests;

public sealed class ScheduleAndSelectionTests
{
    [Test]
    public void BeforeFirstSlotUsesPreviousDayLastSlot()
    {
        var slots = new[]
        {
            new ScheduleSlot("midday", true, new TimeOnly(12, 0), new[] { "day" }),
            new ScheduleSlot("evening", true, new TimeOnly(18, 0), new[] { "night" })
        };
        var result = new ScheduleEvaluator().Evaluate(slots, new DateTimeOffset(2026, 10, 5, 6, 0, 0, TimeSpan.Zero), TimeZoneInfo.Utc);
        Assert.That(result.SlotId, Is.EqualTo("evening"));
        Assert.That(result.Channels, Is.EqualTo(new[] { "night" }));
    }

    [Test]
    public void HandoffPreservesOrderedScheduledFallback()
    {
        var statuses = new[] { new Candidate("1", "first", LiveStatus.Offline), new Candidate("2", "second", LiveStatus.Live) };
        var result = new SelectionEngine(new FixedRandom(0)).Select(new[] { "first", "second" }, statuses, Array.Empty<Candidate>(), null, true);
        Assert.That(result.Channel, Is.EqualTo("second"));
        Assert.That(result.Tier, Is.EqualTo(SelectionTier.Scheduled));
    }

    [Test]
    public void UnknownScheduledStatusDoesNotFallThrough()
    {
        var result = new SelectionEngine(new FixedRandom(0)).Select(
            new[] { "first" },
            new[] { new Candidate("1", "first", LiveStatus.Unknown) },
            new[] { new Candidate("2", "discovery", LiveStatus.Live) }, null, true);
        Assert.That(result.Channel, Is.Null);
        Assert.That(result.Reason, Is.EqualTo("scheduled_channel_status_unknown"));
    }

    [Test]
    public void ScheduleValidationRejectsDuplicateTimesAndChannels()
    {
        var errors = ScheduleValidation.Validate(new[]
        {
            new ScheduleSlot("one", true, new TimeOnly(9, 0), new[] { "alpha", "alpha" }),
            new ScheduleSlot("two", true, new TimeOnly(9, 0), new[] { "beta" })
        });
        Assert.That(errors, Has.Count.EqualTo(2));
    }

    private sealed class FixedRandom(int value) : IRandomSource
    {
        public int Next(int maxExclusive) => Math.Min(value, maxExclusive - 1);
    }
}
