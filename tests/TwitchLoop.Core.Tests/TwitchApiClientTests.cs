using System.Text.Json;
using Microsoft.Extensions.Configuration;
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

    [Test]
    public async Task StreamRequestsIncludePriorityLoginsAndHundredItemLimitInQuery()
    {
        var handler = new CapturingHandler();
        using var httpClient = new HttpClient(handler);
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["TWITCH_CLIENT_ID"] = "test-client" })
            .Build();
        var client = new TwitchApiClient(httpClient, configuration, Microsoft.Extensions.Logging.Abstractions.NullLogger<TwitchApiClient>.Instance);

        await client.GetStreamsAsync(["first_login", "second"], "access-token", CancellationToken.None);
        await client.GetStreamsAsync([], "access-token", CancellationToken.None);

        Assert.That(handler.Queries, Is.EqualTo(new[] { "?first=100&user_login=first_login&user_login=second", "?first=100" }));
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public List<string> Queries { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Queries.Add(request.RequestUri!.Query);
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent("{\"data\":[]}", System.Text.Encoding.UTF8, "application/json")
            });
        }
    }

}
