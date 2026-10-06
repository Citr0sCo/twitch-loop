using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using NUnit.Framework;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Core.Tests;

public sealed class SqliteStoreTests
{
    [Test]
    public async Task InitializeAddsUserIdToExistingConnectionSchema()
    {
        var directory = Path.Combine(Path.GetTempPath(), "twitch-loop-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var databasePath = Path.Combine(directory, "twitch-loop.db");
            await using (var connection = new SqliteConnection($"Data Source={databasePath}"))
            {
                await connection.OpenAsync();
                await using var command = connection.CreateCommand();
                command.CommandText = "CREATE TABLE twitch_connection (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted_access_token TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT NOT NULL, validated_at TEXT NULL)";
                await command.ExecuteNonQueryAsync();
            }

            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["App:DataDirectory"] = directory
            }).Build();
            var store = new SqliteStore(configuration);

            await store.InitializeAsync();
            await store.SaveConnectionAsync("user-id", "encrypted-access", "encrypted-refresh", "scopes", DateTimeOffset.UtcNow.AddHours(1), CancellationToken.None);
            var stored = await store.GetConnectionAsync(CancellationToken.None);

            Assert.That(stored, Is.Not.Null);
            Assert.That(stored!.TwitchUserId, Is.EqualTo("user-id"));
            Assert.That(stored.EncryptedAccessToken, Is.EqualTo("encrypted-access"));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Test]
    public async Task ScheduleRoundTripPreservesOrderedPriorityChannels()
    {
        var directory = Path.Combine(Path.GetTempPath(), "twitch-loop-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["App:DataDirectory"] = directory
            }).Build();
            var store = new SqliteStore(configuration);
            await store.InitializeAsync();
            await store.SaveScheduleAsync(new[] { "first", "second", TwitchLoop.Core.ScheduleChannels.AnyFollowing }, 1, "test", CancellationToken.None);

            var stored = await store.GetScheduleAsync(CancellationToken.None);

            Assert.That(stored, Is.EqualTo(new[] { "first", "second", TwitchLoop.Core.ScheduleChannels.AnyFollowing, TwitchLoop.Core.ScheduleChannels.Any }));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Test]
    public async Task ExistingTimedScheduleMigratesToChronologicalPriorityList()
    {
        var directory = Path.Combine(Path.GetTempPath(), "twitch-loop-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["App:DataDirectory"] = directory
            }).Build();
            var store = new SqliteStore(configuration);
            await store.InitializeAsync();
            await using (var connection = new SqliteConnection($"Data Source={Path.Combine(directory, "twitch-loop.db")}"))
            {
                await connection.OpenAsync();
                await using var command = connection.CreateCommand();
                command.CommandText = "INSERT INTO schedule (id,version,json,source,updated_at) VALUES (1,1,$json,'test',$updated)";
                command.Parameters.AddWithValue("$json", """[{"id":"late","enabled":true,"startTime":"18:00","channels":["night"]},{"id":"early","enabled":true,"startTime":"07:00","channels":["day"]}]""");
                command.Parameters.AddWithValue("$updated", DateTimeOffset.UtcNow.ToString("O"));
                await command.ExecuteNonQueryAsync();
            }

            var stored = await store.GetScheduleAsync(CancellationToken.None);

            Assert.That(stored, Is.EqualTo(new[] { "day", "night", TwitchLoop.Core.ScheduleChannels.AnyFollowing, TwitchLoop.Core.ScheduleChannels.Any }));
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }
}
