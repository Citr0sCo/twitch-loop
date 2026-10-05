using System.Text.Json;
using NUnit.Framework;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Core.Tests;

public sealed class TwitchApiClientTests
{
    [Test]
    public void FollowedChannelDeserializesTwitchSnakeCaseFields()
    {
        const string json = """{"broadcaster_id":"123","broadcaster_login":"channel_login","broadcaster_name":"Channel Name","followed_at":"2026-08-01T12:00:00Z"}""";

        var channel = JsonSerializer.Deserialize<TwitchFollow>(json);

        Assert.That(channel, Is.Not.Null);
        Assert.That(channel!.BroadcasterId, Is.EqualTo("123"));
        Assert.That(channel.BroadcasterLogin, Is.EqualTo("channel_login"));
        Assert.That(channel.BroadcasterName, Is.EqualTo("Channel Name"));
        Assert.That(channel.FollowedAt, Is.EqualTo(DateTimeOffset.Parse("2026-08-01T12:00:00Z")));
    }
}
