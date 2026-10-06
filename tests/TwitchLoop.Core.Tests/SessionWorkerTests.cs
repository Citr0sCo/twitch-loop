using System.Net;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using NUnit.Framework;
using TwitchLoop.Core;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Core.Tests;

public sealed class SessionWorkerTests
{
    [Test]
    public async Task ImmediateEvaluationSelectsALiveFollowedChannelForAnEmptySchedule()
    {
        var directory = Path.Combine(Path.GetTempPath(), "twitch-loop-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["App:DataDirectory"] = directory,
                ["TWITCH_CLIENT_ID"] = "test-client"
            }).Build();
            var store = new SqliteStore(configuration);
            var tokens = new TokenStore(new PassthroughProtectionProvider());
            await store.InitializeAsync();
            await store.SaveConnectionAsync("user-id", tokens.Protect("access"), tokens.Protect("refresh"), "scopes", DateTimeOffset.UtcNow.AddHours(1), CancellationToken.None);
            var settings = await store.GetSettingsAsync(CancellationToken.None);
            var session = await store.CreateSessionAsync(settings, CancellationToken.None);
            Assert.That(await store.GetActiveSessionsAsync(DateTimeOffset.UtcNow, CancellationToken.None), Has.Count.EqualTo(1));
            var connection = await store.GetConnectionAsync(CancellationToken.None);
            Assert.That(connection, Is.Not.Null);
            Assert.That(connection!.ExpiresAt, Is.GreaterThan(DateTimeOffset.UtcNow));
            var handler = new TwitchResponseHandler();
            using var httpClient = new HttpClient(handler);
            var twitch = new TwitchApiClient(httpClient, configuration, NullLogger<TwitchApiClient>.Instance);
            var workerLogger = new CapturingLogger<SessionWorker>();
            var worker = new SessionWorker(store, twitch, tokens, new SystemClock(), new SystemRandomSource(), workerLogger);

            await worker.EvaluateImmediatelyAsync(CancellationToken.None);
            Assert.That(workerLogger.LastException, Is.Null);
            Assert.That(handler.Paths, Is.EqualTo(new[] { "/helix/channels/followed", "/helix/streams" }));

            var updated = await store.GetSessionAsync(session.Id, CancellationToken.None);
            Assert.That(updated?.State, Is.EqualTo("playing"));
            Assert.That(updated?.Channel, Is.EqualTo("followedlive"));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class TwitchResponseHandler : HttpMessageHandler
    {
        public List<string> Paths { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Paths.Add(request.RequestUri!.AbsolutePath);
            var body = request.RequestUri!.AbsolutePath.EndsWith("/channels/followed", StringComparison.Ordinal)
                ? """{"data":[{"broadcaster_id":"1","broadcaster_login":"followedlive","broadcaster_name":"Followed Live","followed_at":"2026-10-05T12:00:00Z"}],"pagination":{}}"""
                : """{"data":[{"id":"stream-1","user_id":"1","user_login":"followedlive","user_name":"Followed Live","started_at":"2026-10-05T12:00:00Z","language":"en","game_name":"Test"}]}""";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            });
        }
    }

    private sealed class PassthroughProtectionProvider : IDataProtectionProvider
    {
        public IDataProtector CreateProtector(string purpose) => new PassthroughProtector();
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public Exception? LastException { get; private set; }
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            LastException = exception;
        }
    }


    private sealed class PassthroughProtector : IDataProtector
    {
        public byte[] Protect(byte[] plaintext) => plaintext;
        public byte[] Unprotect(byte[] protectedData) => protectedData;
        public IDataProtector CreateProtector(string purpose) => this;
    }
}
