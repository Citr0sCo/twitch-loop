using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using TwitchLoop.Infrastructure;

namespace TwitchLoop.Api;

[ApiController]
[Route("api/auth")]
public sealed class AuthController(IConfiguration configuration, IHttpClientFactory clients, TokenStore tokens, SqliteStore store) : ControllerBase
{
    [AllowAnonymous]
    [HttpGet("status")]
    public async Task<IActionResult> Status(CancellationToken cancellationToken) => Ok(new
    {
        setupRequired = string.IsNullOrWhiteSpace(configuration["TWITCH_CLIENT_ID"]) || string.IsNullOrWhiteSpace(configuration["TWITCH_CLIENT_SECRET"]) || string.IsNullOrWhiteSpace(configuration["TWITCH_REDIRECT_URI"]) || string.IsNullOrWhiteSpace(configuration["APP_ALLOWED_OWNER_TWITCH_ID"]),
        connected = User.Identity?.IsAuthenticated == true && await store.HasConnectionAsync(cancellationToken),
        ownerConfigured = !string.IsNullOrWhiteSpace(configuration["APP_ALLOWED_OWNER_TWITCH_ID"]),
        scopes = new[] { "user:read:follows", "user:read:subscriptions" }
    });

    [AllowAnonymous]
    [HttpGet("twitch/start")]
    public IActionResult Start()
    {
        var clientId = configuration["TWITCH_CLIENT_ID"];
        var redirectUri = configuration["TWITCH_REDIRECT_URI"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(redirectUri)) return Problem("Twitch OAuth is not configured.", statusCode: 503);
        var state = TokenStore.CreateState();
        Response.Cookies.Append("twitch_oauth_state", state, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = Request.IsHttps, MaxAge = TimeSpan.FromMinutes(5) });
        var url = "https://id.twitch.tv/oauth2/authorize" + QueryString.Create(new Dictionary<string, string?>
        {
            ["client_id"] = clientId, ["redirect_uri"] = redirectUri, ["response_type"] = "code", ["scope"] = "user:read:follows user:read:subscriptions", ["state"] = state
        });
        return Redirect(url);
    }

    [AllowAnonymous]
    [HttpGet("twitch/callback")]
    public async Task<IActionResult> Callback([FromQuery] string? code, [FromQuery] string? state, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state) || !Request.Cookies.TryGetValue("twitch_oauth_state", out var expected) || !CryptographicOperations.FixedTimeEquals(System.Text.Encoding.UTF8.GetBytes(state), System.Text.Encoding.UTF8.GetBytes(expected))) return BadRequest(new { error = "invalid_oauth_state" });
        Response.Cookies.Delete("twitch_oauth_state");
        var response = await clients.CreateClient().PostAsJsonAsync("https://id.twitch.tv/oauth2/token", new { client_id = configuration["TWITCH_CLIENT_ID"], client_secret = configuration["TWITCH_CLIENT_SECRET"], code, grant_type = "authorization_code", redirect_uri = configuration["TWITCH_REDIRECT_URI"] }, cancellationToken);
        if (!response.IsSuccessStatusCode) return Problem("Twitch authorization failed.", statusCode: 502);
        var token = await response.Content.ReadFromJsonAsync<TokenResponse>(cancellationToken: cancellationToken);
        if (token is null || string.IsNullOrWhiteSpace(token.AccessToken) || string.IsNullOrWhiteSpace(token.RefreshToken)) return Problem("Twitch returned an incomplete token response.", statusCode: 502);
        using var userRequest = new HttpRequestMessage(HttpMethod.Get, "https://api.twitch.tv/helix/users");
        userRequest.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token.AccessToken);
        userRequest.Headers.Add("Client-Id", configuration["TWITCH_CLIENT_ID"]);
        using var userResponse = await clients.CreateClient().SendAsync(userRequest, cancellationToken);
        var userPayload = await userResponse.Content.ReadFromJsonAsync<UserResponse>(cancellationToken: cancellationToken);
        var user = userPayload?.Data?.FirstOrDefault();
        if (user is null) return Problem("Twitch identity validation failed.", statusCode: 502);
        var allowedOwner = configuration["APP_ALLOWED_OWNER_TWITCH_ID"];
        if (string.IsNullOrWhiteSpace(allowedOwner) || !string.Equals(allowedOwner, user.Id, StringComparison.Ordinal)) return Forbid();
        await store.SaveConnectionAsync(user.Id, tokens.Protect(token.AccessToken), tokens.Protect(token.RefreshToken), "user:read:follows user:read:subscriptions", DateTimeOffset.UtcNow.AddSeconds(token.ExpiresIn), cancellationToken);
        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("twitch_user_id", user.Id)], CookieAuthenticationDefaults.AuthenticationScheme)));
        return Redirect("/watch?connected=1");
    }

    [Authorize]
    [HttpPost("logout")]
    public async Task<IActionResult> Logout() { await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme); return NoContent(); }

    [Authorize]
    [HttpPost("disconnect")]
    public async Task<IActionResult> Disconnect(CancellationToken cancellationToken) { await store.DeleteConnectionAsync(cancellationToken); await HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme); return NoContent(); }

    private sealed record TokenResponse([property: System.Text.Json.Serialization.JsonPropertyName("access_token")] string AccessToken, [property: System.Text.Json.Serialization.JsonPropertyName("refresh_token")] string RefreshToken, [property: System.Text.Json.Serialization.JsonPropertyName("expires_in")] int ExpiresIn);
    private sealed record UserResponse([property: System.Text.Json.Serialization.JsonPropertyName("data")] List<TwitchUser> Data);
    private sealed record TwitchUser([property: System.Text.Json.Serialization.JsonPropertyName("id")] string Id);

}
