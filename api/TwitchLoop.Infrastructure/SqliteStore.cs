using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed record StoredSession(string Id, string State, string? Channel, string AutomationMode, int Revision, DateTimeOffset StartedAt, DateTimeOffset ExpiresAt);
public sealed record StoredConnection(string EncryptedAccessToken, string EncryptedRefreshToken, string Scopes, DateTimeOffset ExpiresAt);

public sealed class SqliteStore
{
    private readonly string connectionString;
    private readonly SemaphoreSlim gate = new(1, 1);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public SqliteStore(IConfiguration configuration)
    {
        var directory = configuration["App:DataDirectory"] ?? "/data";
        Directory.CreateDirectory(directory);
        connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "twitch-loop.db"),
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString();
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL, content_hash TEXT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, json TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NULL, automation_mode TEXT NOT NULL, revision INTEGER NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS twitch_connection (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted_access_token TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT NOT NULL, validated_at TEXT NULL);
                """;
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task<AppSettings> GetSettingsAsync(CancellationToken cancellationToken)
    {
        var stored = await ReadJsonAsync("SELECT json FROM settings WHERE id = 1", cancellationToken);
        return stored is null ? new AppSettings() : JsonSerializer.Deserialize<AppSettings>(stored, JsonOptions) ?? new AppSettings();
    }

    public async Task<AppSettings> SaveSettingsAsync(AppSettings settings, int expectedVersion, CancellationToken cancellationToken)
    {
        settings.Version = expectedVersion + 1;
        await WriteJsonAsync("settings", settings.Version, JsonSerializer.Serialize(settings, JsonOptions), settings.Source, cancellationToken);
        return settings;
    }

    public async Task<IReadOnlyList<ScheduleSlot>> GetScheduleAsync(CancellationToken cancellationToken)
    {
        var stored = await ReadJsonAsync("SELECT json FROM schedule WHERE id = 1", cancellationToken);
        if (stored is null) return [new ScheduleSlot("default", true, new TimeOnly(0, 0), Array.Empty<string>())];
        return JsonSerializer.Deserialize<List<ScheduleSlot>>(stored, JsonOptions) ?? [];
    }

    public async Task SaveScheduleAsync(IReadOnlyList<ScheduleSlot> slots, int version, string source, CancellationToken cancellationToken)
    {
        await WriteJsonAsync("schedule", version + 1, JsonSerializer.Serialize(slots, JsonOptions), source, cancellationToken);
    }

    public async Task<StoredSession> CreateSessionAsync(AppSettings settings, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var session = new StoredSession(Guid.NewGuid().ToString("N"), "waiting", null, "auto", 1, now, now.AddHours(settings.SessionDurationHours));
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO sessions (id,state,channel,automation_mode,revision,started_at,expires_at) VALUES ($id,$state,$channel,$mode,$revision,$started,$expires)";
            AddSessionParameters(command, session);
            await command.ExecuteNonQueryAsync(cancellationToken);
            return session;
        }
        finally { gate.Release(); }
    }

    public async Task SaveConnectionAsync(string encryptedAccessToken, string encryptedRefreshToken, string scopes, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO twitch_connection (id,encrypted_access_token,encrypted_refresh_token,scopes,expires_at,validated_at) VALUES (1,$access,$refresh,$scopes,$expires,$validated) ON CONFLICT(id) DO UPDATE SET encrypted_access_token=$access,encrypted_refresh_token=$refresh,scopes=$scopes,expires_at=$expires,validated_at=$validated";
            command.Parameters.AddWithValue("$access", encryptedAccessToken);
            command.Parameters.AddWithValue("$refresh", encryptedRefreshToken);
            command.Parameters.AddWithValue("$scopes", scopes);
            command.Parameters.AddWithValue("$expires", expiresAt.ToString("O"));
            command.Parameters.AddWithValue("$validated", DateTimeOffset.UtcNow.ToString("O"));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task<bool> HasConnectionAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT EXISTS(SELECT 1 FROM twitch_connection WHERE id = 1)";
            return Convert.ToInt32(await command.ExecuteScalarAsync(cancellationToken)) == 1;
        }
        finally { gate.Release(); }
    }

    public async Task DeleteConnectionAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM twitch_connection WHERE id = 1";
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task<StoredSession?> GetSessionAsync(string id, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT id,state,channel,automation_mode,revision,started_at,expires_at FROM sessions WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            return new StoredSession(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.GetInt32(4), DateTimeOffset.Parse(reader.GetString(5)), DateTimeOffset.Parse(reader.GetString(6)));
        }
        finally { gate.Release(); }
    }

    public async Task<IReadOnlyList<StoredSession>> GetActiveSessionsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT id,state,channel,automation_mode,revision,started_at,expires_at FROM sessions WHERE expires_at > $now AND state <> 'stopped' AND automation_mode = 'auto'";
            command.Parameters.AddWithValue("$now", now.ToString("O"));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            var sessions = new List<StoredSession>();
            while (await reader.ReadAsync(cancellationToken)) sessions.Add(new StoredSession(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.GetInt32(4), DateTimeOffset.Parse(reader.GetString(5)), DateTimeOffset.Parse(reader.GetString(6))));
            return sessions;
        }
        finally { gate.Release(); }
    }

    public async Task<StoredConnection?> GetConnectionAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT encrypted_access_token,encrypted_refresh_token,scopes,expires_at FROM twitch_connection WHERE id = 1";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            return new StoredConnection(reader.GetString(0), reader.GetString(1), reader.GetString(2), DateTimeOffset.Parse(reader.GetString(3)));
        }
        finally { gate.Release(); }
    }

    public async Task<StoredSession?> UpdateSessionAsync(string id, string action, string? channel, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "SELECT state,channel,automation_mode,revision,started_at,expires_at FROM sessions WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            var current = new StoredSession(id, reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2), reader.GetInt32(3), DateTimeOffset.Parse(reader.GetString(4)), DateTimeOffset.Parse(reader.GetString(5)));
            await reader.DisposeAsync();
            var next = action switch
            {
                "stop" => current with { State = "stopped", Channel = null, Revision = current.Revision + 1 },
                "pauseAuto" => current with { AutomationMode = "paused", Revision = current.Revision + 1 },
                "resumeAuto" => current with { AutomationMode = "auto", Revision = current.Revision + 1 },
                "autoSelect" when !string.IsNullOrWhiteSpace(channel) => current with { State = "playing", Channel = channel.Trim(), AutomationMode = "auto", Revision = current.Revision + 1 },
                "autoSelect" => current with { State = "waiting", Channel = null, AutomationMode = "auto", Revision = current.Revision + 1 },
                "selectChannel" when !string.IsNullOrWhiteSpace(channel) => current with { State = "selected", Channel = channel.Trim(), AutomationMode = "manual", Revision = current.Revision + 1 },
                _ => current
            };
            command.Parameters.Clear();
            command.CommandText = "UPDATE sessions SET state=$state,channel=$channel,automation_mode=$mode,revision=$revision WHERE id=$id";
            command.Parameters.AddWithValue("$id", id);
            command.Parameters.AddWithValue("$state", next.State);
            command.Parameters.AddWithValue("$channel", (object?)next.Channel ?? DBNull.Value);
            command.Parameters.AddWithValue("$mode", next.AutomationMode);
            command.Parameters.AddWithValue("$revision", next.Revision);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return next;
        }
        finally { gate.Release(); }
    }

    private SqliteConnection Open() => new(connectionString);

    private async Task<string?> ReadJsonAsync(string query, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = query;
            return await command.ExecuteScalarAsync(cancellationToken) as string;
        }
        finally { gate.Release(); }
    }

    private async Task WriteJsonAsync(string table, int version, string json, string source, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = $"INSERT INTO {table} (id,version,json,source,updated_at) VALUES (1,$version,$json,$source,$updated) ON CONFLICT(id) DO UPDATE SET version=$version,json=$json,source=$source,updated_at=$updated";
            command.Parameters.AddWithValue("$version", version);
            command.Parameters.AddWithValue("$json", json);
            command.Parameters.AddWithValue("$source", source);
            command.Parameters.AddWithValue("$updated", DateTimeOffset.UtcNow.ToString("O"));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    private static void AddSessionParameters(SqliteCommand command, StoredSession session)
    {
        command.Parameters.AddWithValue("$id", session.Id);
        command.Parameters.AddWithValue("$state", session.State);
        command.Parameters.AddWithValue("$channel", (object?)session.Channel ?? DBNull.Value);
        command.Parameters.AddWithValue("$mode", session.AutomationMode);
        command.Parameters.AddWithValue("$revision", session.Revision);
        command.Parameters.AddWithValue("$started", session.StartedAt.ToString("O"));
        command.Parameters.AddWithValue("$expires", session.ExpiresAt.ToString("O"));
    }
}
