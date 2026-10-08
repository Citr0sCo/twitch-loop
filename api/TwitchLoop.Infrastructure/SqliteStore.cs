using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using TwitchLoop.Core;

namespace TwitchLoop.Infrastructure;

public sealed record StoredSession(string Id, string State, string? Channel, string AutomationMode, string? SelectionTier, int Revision, DateTimeOffset StartedAt, DateTimeOffset ExpiresAt);
public sealed record StoredConnection(string? TwitchUserId, string EncryptedAccessToken, string EncryptedRefreshToken, string Scopes, DateTimeOffset ExpiresAt);
public sealed record SiteEvent(long Id, DateTimeOffset OccurredAt, string Type, string Summary, string? Details);

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
                CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL, channel TEXT NULL, automation_mode TEXT NOT NULL, selection_tier TEXT NULL, revision INTEGER NOT NULL, started_at TEXT NOT NULL, expires_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS twitch_connection (id INTEGER PRIMARY KEY CHECK (id = 1), twitch_user_id TEXT NULL, encrypted_access_token TEXT NOT NULL, encrypted_refresh_token TEXT NOT NULL, scopes TEXT NOT NULL, expires_at TEXT NOT NULL, validated_at TEXT NULL);
                CREATE TABLE IF NOT EXISTS site_events (id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NULL);
                CREATE INDEX IF NOT EXISTS ix_site_events_occurred_at ON site_events(occurred_at DESC, id DESC);
                CREATE TABLE IF NOT EXISTS client_presence (client_id TEXT PRIMARY KEY, browser TEXT NOT NULL, device TEXT NOT NULL, connected_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, disconnected_at TEXT NULL);
                """;
            await command.ExecuteNonQueryAsync(cancellationToken);
            await using var schemaCommand = connection.CreateCommand();
            schemaCommand.CommandText = "SELECT COUNT(*) FROM pragma_table_info('twitch_connection') WHERE name = 'twitch_user_id'";
            if (Convert.ToInt32(await schemaCommand.ExecuteScalarAsync(cancellationToken)) == 0)
            {
                schemaCommand.CommandText = "ALTER TABLE twitch_connection ADD COLUMN twitch_user_id TEXT NULL";
                await schemaCommand.ExecuteNonQueryAsync(cancellationToken);
            }
            schemaCommand.CommandText = "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'selection_tier'";
            if (Convert.ToInt32(await schemaCommand.ExecuteScalarAsync(cancellationToken)) == 0)
            {
                schemaCommand.CommandText = "ALTER TABLE sessions ADD COLUMN selection_tier TEXT NULL";
                await schemaCommand.ExecuteNonQueryAsync(cancellationToken);
            }
        }
        finally { gate.Release(); }
    }

    public async Task<AppSettings> GetSettingsAsync(CancellationToken cancellationToken)
    {
        var stored = await ReadJsonAsync("SELECT json FROM settings WHERE id = 1", cancellationToken);
        var settings = stored is null ? new AppSettings() : JsonSerializer.Deserialize<AppSettings>(stored, JsonOptions) ?? new AppSettings();
        return settings;
    }

    public async Task<AppSettings> SaveSettingsAsync(AppSettings settings, int expectedVersion, CancellationToken cancellationToken)
    {
        settings.Version = expectedVersion + 1;
        await WriteJsonAsync("settings", settings.Version, JsonSerializer.Serialize(settings, JsonOptions), settings.Source, cancellationToken);
        return settings;
    }

    public async Task RecordEventAsync(string type, string summary, string? details, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            await InsertEventAsync(connection, transaction, type, summary, details, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task<IReadOnlyList<SiteEvent>> GetRecentEventsAsync(int limit, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT id,occurred_at,type,summary,details FROM site_events ORDER BY occurred_at DESC,id DESC LIMIT $limit";
            command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            var events = new List<SiteEvent>();
            while (await reader.ReadAsync(cancellationToken))
            {
                events.Add(new SiteEvent(reader.GetInt64(0), DateTimeOffset.Parse(reader.GetString(1)), reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4)));
            }
            return events;
        }
        finally { gate.Release(); }
    }

    public async Task HeartbeatClientAsync(string clientId, string browser, string device, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            var now = DateTimeOffset.UtcNow;
            await using var query = connection.CreateCommand();
            query.Transaction = transaction;
            query.CommandText = "SELECT disconnected_at FROM client_presence WHERE client_id=$clientId";
            query.Parameters.AddWithValue("$clientId", clientId);
            var disconnectedAt = await query.ExecuteScalarAsync(cancellationToken);
            var isNew = disconnectedAt is null;
            var wasDisconnected = disconnectedAt is not null && disconnectedAt is not DBNull;

            await using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = "INSERT INTO client_presence (client_id,browser,device,connected_at,last_seen_at,disconnected_at) VALUES ($clientId,$browser,$device,$now,$now,NULL) ON CONFLICT(client_id) DO UPDATE SET browser=$browser,device=$device,last_seen_at=$now,disconnected_at=NULL,connected_at=CASE WHEN client_presence.disconnected_at IS NULL THEN client_presence.connected_at ELSE $now END";
            update.Parameters.AddWithValue("$clientId", clientId);
            update.Parameters.AddWithValue("$browser", browser);
            update.Parameters.AddWithValue("$device", device);
            update.Parameters.AddWithValue("$now", now.ToString("O"));
            await update.ExecuteNonQueryAsync(cancellationToken);

            if (isNew || wasDisconnected)
            {
                var eventType = wasDisconnected ? "client_reconnected" : "client_connected";
                var summary = wasDisconnected ? "Browser reconnected" : "Browser connected";
                await InsertEventAsync(connection, transaction, eventType, summary, $"{browser} on {device}", cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task DisconnectStaleClientsAsync(DateTimeOffset staleBefore, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            await using var query = connection.CreateCommand();
            query.Transaction = transaction;
            query.CommandText = "SELECT client_id,browser,device FROM client_presence WHERE disconnected_at IS NULL AND last_seen_at < $staleBefore";
            query.Parameters.AddWithValue("$staleBefore", staleBefore.ToString("O"));
            var stale = new List<(string Id, string Browser, string Device)>();
            await using (var reader = await query.ExecuteReaderAsync(cancellationToken))
            {
                while (await reader.ReadAsync(cancellationToken)) stale.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
            }

            foreach (var client in stale)
            {
                await using var update = connection.CreateCommand();
                update.Transaction = transaction;
                update.CommandText = "UPDATE client_presence SET disconnected_at=$now WHERE client_id=$clientId AND disconnected_at IS NULL";
                update.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
                update.Parameters.AddWithValue("$clientId", client.Id);
                if (await update.ExecuteNonQueryAsync(cancellationToken) > 0)
                {
                    await InsertEventAsync(connection, transaction, "client_disconnected", "Browser disconnected", $"{client.Browser} on {client.Device}; heartbeat expired", cancellationToken);
                }
            }
            await transaction.CommitAsync(cancellationToken);
        }
        finally { gate.Release(); }
    }

    public async Task<IReadOnlyList<string>> GetScheduleAsync(CancellationToken cancellationToken)
    {
        var stored = await ReadJsonAsync("SELECT json FROM schedule WHERE id = 1", cancellationToken);
        if (stored is null) return ScheduleChannels.Normalize(Array.Empty<string>());

        using var document = JsonDocument.Parse(stored);
        if (document.RootElement.ValueKind == JsonValueKind.Array && document.RootElement.EnumerateArray().FirstOrDefault().ValueKind == JsonValueKind.Object)
        {
            var legacySlots = JsonSerializer.Deserialize<List<LegacyScheduleSlot>>(stored, JsonOptions) ?? [];
            var migrated = legacySlots.Where(slot => slot.Enabled)
                .OrderBy(slot => slot.StartTime)
                .SelectMany(slot => slot.Channels);
            return ScheduleChannels.Normalize(migrated);
        }

        return ScheduleChannels.Normalize(JsonSerializer.Deserialize<List<string>>(stored, JsonOptions) ?? []);
    }

    public async Task SaveScheduleAsync(IReadOnlyList<string> channels, int version, string source, CancellationToken cancellationToken)
    {
        var normalized = ScheduleChannels.Normalize(channels);
        await WriteJsonAsync("schedule", version + 1, JsonSerializer.Serialize(normalized, JsonOptions), source, cancellationToken);
    }

    private sealed record LegacyScheduleSlot(string Id, bool Enabled, TimeOnly StartTime, IReadOnlyList<string> Channels);

    public async Task<StoredSession> CreateSessionAsync(AppSettings settings, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var session = new StoredSession(Guid.NewGuid().ToString("N"), "waiting", null, "auto", null, 1, now, now.AddHours(settings.SessionDurationHours));
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "INSERT INTO sessions (id,state,channel,automation_mode,selection_tier,revision,started_at,expires_at) VALUES ($id,$state,$channel,$mode,$tier,$revision,$started,$expires)";
            AddSessionParameters(command, session);
            await command.ExecuteNonQueryAsync(cancellationToken);
            await InsertEventAsync(connection, transaction, "session_started", "Playback session started", "Searching for a live streamer", cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return session;
        }
        finally { gate.Release(); }
    }

    public async Task SaveConnectionAsync(string twitchUserId, string encryptedAccessToken, string encryptedRefreshToken, string scopes, DateTimeOffset expiresAt, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO twitch_connection (id,twitch_user_id,encrypted_access_token,encrypted_refresh_token,scopes,expires_at,validated_at) VALUES (1,$userId,$access,$refresh,$scopes,$expires,$validated) ON CONFLICT(id) DO UPDATE SET twitch_user_id=$userId,encrypted_access_token=$access,encrypted_refresh_token=$refresh,scopes=$scopes,expires_at=$expires,validated_at=$validated";
            command.Parameters.AddWithValue("$userId", twitchUserId);
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
            command.CommandText = "SELECT id,state,channel,automation_mode,selection_tier,revision,started_at,expires_at FROM sessions WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            return new StoredSession(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetInt32(5), DateTimeOffset.Parse(reader.GetString(6)), DateTimeOffset.Parse(reader.GetString(7)));
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
            command.CommandText = "SELECT id,state,channel,automation_mode,selection_tier,revision,started_at,expires_at FROM sessions WHERE expires_at > $now AND state <> 'stopped' AND automation_mode = 'auto'";
            command.Parameters.AddWithValue("$now", now.ToString("O"));
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            var sessions = new List<StoredSession>();
            while (await reader.ReadAsync(cancellationToken)) sessions.Add(new StoredSession(reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2), reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetInt32(5), DateTimeOffset.Parse(reader.GetString(6)), DateTimeOffset.Parse(reader.GetString(7))));
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
            command.CommandText = "SELECT twitch_user_id,encrypted_access_token,encrypted_refresh_token,scopes,expires_at FROM twitch_connection WHERE id = 1";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            return new StoredConnection(reader.IsDBNull(0) ? null : reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), DateTimeOffset.Parse(reader.GetString(4)));
        }
        finally { gate.Release(); }
    }

    public async Task<StoredSession?> UpdateSessionAsync(string id, string action, string? channel, CancellationToken cancellationToken, string? selectionTier = null, string? selectionReason = null)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await using var connection = Open();
            await connection.OpenAsync(cancellationToken);
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "SELECT state,channel,automation_mode,selection_tier,revision,started_at,expires_at FROM sessions WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken)) return null;
            var current = new StoredSession(id, reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2), reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetInt32(4), DateTimeOffset.Parse(reader.GetString(5)), DateTimeOffset.Parse(reader.GetString(6)));
            await reader.DisposeAsync();
            var next = action switch
            {
                "stop" => current with { State = "stopped", Channel = null, SelectionTier = null, Revision = current.Revision + 1 },
                "pauseAuto" => current with { AutomationMode = "paused", Revision = current.Revision + 1 },
                "resumeAuto" => current with { AutomationMode = "auto", Revision = current.Revision + 1 },
                "autoSelect" when !string.IsNullOrWhiteSpace(channel) => current with { State = "playing", Channel = channel.Trim(), AutomationMode = "auto", SelectionTier = selectionTier, Revision = current.Revision + 1 },
                "autoSelect" => current with { State = "waiting", Channel = null, AutomationMode = "auto", SelectionTier = null, Revision = current.Revision + 1 },
                "selectChannel" when !string.IsNullOrWhiteSpace(channel) => current with { State = "selected", Channel = channel.Trim(), AutomationMode = "manual", SelectionTier = "manual", Revision = current.Revision + 1 },
                _ => current
            };
            command.Parameters.Clear();
            command.CommandText = "UPDATE sessions SET state=$state,channel=$channel,automation_mode=$mode,selection_tier=$tier,revision=$revision WHERE id=$id";
            command.Parameters.AddWithValue("$id", id);
            command.Parameters.AddWithValue("$state", next.State);
            command.Parameters.AddWithValue("$channel", (object?)next.Channel ?? DBNull.Value);
            command.Parameters.AddWithValue("$mode", next.AutomationMode);
            command.Parameters.AddWithValue("$tier", (object?)next.SelectionTier ?? DBNull.Value);
            command.Parameters.AddWithValue("$revision", next.Revision);
            await command.ExecuteNonQueryAsync(cancellationToken);
            var eventData = GetSessionEvent(current, next, action, selectionReason);
            if (eventData is not null)
            {
                await InsertEventAsync(connection, transaction, eventData.Value.Type, eventData.Value.Summary, eventData.Value.Details, cancellationToken);
            }
            await transaction.CommitAsync(cancellationToken);
            return next;
        }
        finally { gate.Release(); }
    }

    private SqliteConnection Open() => new(connectionString);

    private static async Task InsertEventAsync(SqliteConnection connection, SqliteTransaction transaction, string type, string summary, string? details, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO site_events (occurred_at,type,summary,details) VALUES ($occurredAt,$type,$summary,$details); DELETE FROM site_events WHERE id NOT IN (SELECT id FROM site_events ORDER BY id DESC LIMIT 10000)";
        command.Parameters.AddWithValue("$occurredAt", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("$type", type);
        command.Parameters.AddWithValue("$summary", summary);
        command.Parameters.AddWithValue("$details", (object?)details ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static (string Type, string Summary, string? Details)? GetSessionEvent(StoredSession current, StoredSession next, string action, string? reason)
    {
        if (action == "stop" && current.State != "stopped")
        {
            return ("session_stopped", "Playback session stopped", current.Channel is null ? null : $"Stopped while playing {current.Channel}");
        }
        if (!string.Equals(current.Channel, next.Channel, StringComparison.OrdinalIgnoreCase))
        {
            if (next.Channel is not null)
            {
                return current.Channel is null
                    ? ("stream_selected", $"Selected stream: {next.Channel}", reason)
                    : ("stream_changed", $"Switched from {current.Channel} to {next.Channel}", reason);
            }
            if (current.Channel is not null) return ("stream_ended", $"Stream ended: {current.Channel}", reason);
        }

        return action switch
        {
            "pauseAuto" when current.AutomationMode != "paused" => ("automation_paused", "Automatic stream selection paused", null),
            "resumeAuto" when current.AutomationMode != "auto" => ("automation_resumed", "Automatic stream selection resumed", null),
            _ => null
        };
    }

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
        command.Parameters.AddWithValue("$tier", (object?)session.SelectionTier ?? DBNull.Value);
        command.Parameters.AddWithValue("$revision", session.Revision);
        command.Parameters.AddWithValue("$started", session.StartedAt.ToString("O"));
        command.Parameters.AddWithValue("$expires", session.ExpiresAt.ToString("O"));
    }
}
