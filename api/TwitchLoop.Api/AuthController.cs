using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(IConfiguration configuration, IHttpClientFactory clients, TokenStore tokens, SqliteStore store) : ControllerBase
{
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken cancellationToken) => Ok(new
    {
        setupRequired = string.IsNullOrWhiteSpace(configuration["Twitch:ClientId"]) || string.IsNullOrWhiteSpace(configuration["Twitch:ClientSecret"]) || string.IsNullOrWhiteSpace(configuration["Twitch:RedirectUri"]),
        connected = await store.HasConnectionAsync(cancellationToken),
        ownerConfigured = !string.IsNullOrWhiteSpace(configuration["App:AllowedOwnerTwitchId"]),
        scopes = new[] { "user:read:follows", "user:read:subscriptions" }
    });

    [HttpGet("twitch/start")]
    public IActionResult Start()
    {
        var clientId = configuration["Twitch:ClientId"];
        var redirectUri = configuration["Twitch:RedirectUri"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(redirectUri)) return Problem("Twitch OAuth is not configured.", statusCode: 503);
        var state = TokenStore.CreateState();
        Response.Cookies.Append("twitch_oauth_state", state, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = Request.IsHttps, MaxAge = TimeSpan.FromMinutes(5) });
        var url = "https://id.twitch.tv/oauth2/authorize?" + QueryString.Create(new Dictionary<string, string?>
        {
            ["client_id"] = clientId, ["redirect_uri"] = redirectUri, ["response_type"] = "code", ["scope"] = "user:read:follows user:read:subscriptions", ["state"] = state
        });
        return Redirect(url);
    }

    [HttpGet("twitch/callback")]
    public async Task<IActionResult> Callback([FromQuery] string? code, [FromQuery] string? state, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state) || !Request.Cookies.TryGetValue("twitch_oauth_state", out var expected) || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(state), System.Text.Encoding.UTF8.GetBytes(expected))) return BadRequest(new { error = "invalid_oauth_state" });
        Response.Cookies.Delete("twitch_oauth_state");
        var response = await clients.CreateClient().PostAsJsonAsync("https://id.twitch.tv/oauth2/token", new { client_id = configuration["Twitch:ClientId"], client_secret = configuration["Twitch:ClientSecret"], code, grant_type = "authorization_code", redirect_uri = configuration["Twitch:RedirectUri"] }, cancellationToken);
        if (!response.IsSuccessStatusCode) return Problem("Twitch authorization failed.", statusCode: 502);
        var token = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken: cancellationToken);
        if (token is null || string.IsNullOrWhiteSpace(token.AccessToken) || string.IsNullOrWhiteSpace(token.RefreshToken)) return Problem("Twitch returned an incomplete token response.", statusCode: 502);
        using var userRequest = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/users");
        userRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token.AccessToken);
        userRequest.Headers.Add("Client-Id", configuration["Twitch:ClientId"]);
        using var userResponse = await clients.CreateClient().SendAsync(userRequest, cancellationToken);
        var userPayload = await userResponse.Content.ReadFromJsonAsync<UserResponse>(cancellationToken: cancellationToken);
        var user = userPayload?.Data?.FirstOrDefault();
        if (user is null) return Problem("Twitch identity validation failed.", statusCode: 502);
        var allowedOwner = configuration["App:AllowedOwnerTwitchId"];
        if (!string.IsNullOrWhiteSpace(allowedOwner) && !string.Equals(allowedOwner, user.Id, StringComparison.Ordinal)) return Forbid();
        await store.SaveConnectionAsync(user.Id, tokens.Protect(token.AccessToken), tokens.Protect(token.RefreshToken), "user:read:follows user:read:subscriptions", DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn), cancellationToken);
        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("twitch_user_id", user.Id)], CookieAuthenticationDefaults.AuthenticationScheme)));
        return Redirect("/watch?connected=1");
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout() { await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme); return NoContent(); }

    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect(CancellationToken cancellationToken) { await store.DeleteConnectionAsync(cancellationToken); await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme); return NoContent(); }

    private sealed record TokenResponse([property: System.Text.Json.Serialization.JsonPropertyName("access_token")] string AccessToken, [property: System.Text.Json.Serialization.JsonPropertyName("refresh_token")] string RefreshToken, [property: System.Text.Json.Serialization.JsonPropertyName("expires_in")] int ExpiresIn);
    private sealed record UserResponse([property: System.Text.Json.Serialization.JsonPropertyName("data")] List<TwitchUser> Data);
    private sealed record TwitchUser([property: System.Text.Json.Serialization.JsonPropertyName("id")] string Id);

}
