using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using TwitchLoop.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
var dataDirectory = builder.Configuration["App:DataDirectory"] ?? "/data";
Directory.CreateDirectory(dataDirectory);

builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(dataDirectory, "keys"))).SetApplicationName("TwitchLoop");
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(options =>
{
    options.Cookie.Name = "twitch_loop_session";
    options.Cookie.HttpOnly = true;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.ExpireTimeSpan = TimeSpan.FromDays(14);
    options.SlidingExpiration = true;
    options.Events.OnRedirectToLogin = context => { context.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; };
});
builder.Services.AddAuthorization();
builder.Services.AddControllers().AddJsonOptions(options => options.JsonSerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddHttpClient<TwitchApiClient>(client => client.Timeout = TimeSpan.FromSeconds(10));
builder.Services.AddMemoryCache();
builder.Services.AddSingleton<SqliteStore>();
builder.Services.AddSingleton<TokenStore>();
builder.Services.AddSingleton<TwitchLoop.Core.IClock, TwitchLoop.Core.SystemClock>();
builder.Services.AddSingleton<TwitchLoop.Core.IRandomSource, TwitchLoop.Core.SystemRandomSource>();
builder.Services.AddHostedService<SessionWorker>();

var app = builder.Build();
using (var scope = app.Services.CreateScope())
{
    await scope.ServiceProvider.GetRequiredService<SqliteStore>().InitializeAsync();
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers.ContentSecurityPolicy = "default-src 'self'; frame-src https://player.twitch.tv https://player.twitch.tv/; script-src 'self' https://player.twitch.tv; connect-src 'self' https://api.twitch.tv; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'";
    await next();
});
app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapGet("/health/live", () => Results.Ok(new { status = "ok" }));
app.MapGet("/health/ready", async (SqliteStore store, CancellationToken cancellationToken) =>
{
    await store.InitializeAsync(cancellationToken);
    return Results.Ok(new { status = "ready" });
});
app.MapFallbackToFile("index.html");
await app.RunAsync();

public partial class Program;
