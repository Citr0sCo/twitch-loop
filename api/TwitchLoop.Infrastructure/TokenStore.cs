using System.Security.Cryptography;
using Microsoft.AspNetCore.DataProtection;

namespace TwitchLoop.Infrastructure;

public sealed class TokenStore(IDataProtectionProvider protectionProvider)
{
    private readonly IDataProtector protector = protectionProvider.CreateProtector("TwitchLoop.TwitchTokens.v1");

    public string Protect(string token) => protector.Protect(token);
    public string Unprotect(string token) => protector.Unprotect(token);
    public static string CreateState() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
}
