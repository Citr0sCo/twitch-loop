using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

public sealed class ClientPresenceWorker(SqliteStore store, ILogger<ClientPresenceWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(30));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await store.DisconnectStaleClientsAsync(DateTimeOffset.UtcNow.AddSeconds(-90), stoppingToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogWarning(exception, "Could not update client presence");
            }
        }
    }
}
