# Toolyard access for native clients

Connect your Toolyard account to the destination BKT3 server first.
Use **Settings → BK Add-ons → Toolyard → Connect my Toolyard account**.
Toolyard assigns the host agent to your Toolyard account.

The server saves the Toolyard credential in its secret store.
Native clients use the server endpoint at `/mcp/toolyard`.
They do not receive the Toolyard credential.
Inbox decisions remain necessary for restricted tool calls.

## Authenticate a native client

Use your personal T3 external MCP token on a shared server.
Create it under **Settings → BK Add-ons → External MCP server → My external access**.
This token belongs to your T3 user.
Do not use a server-wide legacy operator token.
The native endpoint rejects that token because it has no user owner.

On a personal server without Clerk, use a normal T3 bearer session.
The local profile has one Toolyard connection for all authorized local clients.
The host owner can issue a T3 session through the existing CLI:

```sh
umask 077
mkdir -p "$HOME/.config/bkt3"
t3 auth session issue --ttl 30d --token-only > "$HOME/.config/bkt3/toolyard-native.t3-token"
chmod 600 "$HOME/.config/bkt3/toolyard-native.t3-token"
```

Use the server's normal `--home-dir` option if it has a custom data directory.
Run this command on your own host.
Do not run it against another user's live database.
Do not set a Clerk subject on a local session to impersonate a team user.

For a shared host, save your personal T3 token in an owner-only file.
Use a password manager or your editor's secure input.
Do not place the token in a shell command or an agent prompt.

The file contains a T3 access credential, not a Toolyard agent key.
Protect it as a password.
Replace the file after a token rotation.
Restart the native client after that replacement.

## Configure Claude Code or another stdio MCP client

Use the installed `t3` executable from this release.
Set the origin to the destination server.
Use the absolute path to your T3 token file.

```json
{
  "mcpServers": {
    "toolyard-host": {
      "command": "t3",
      "args": [
        "toolyard-mcp-bridge",
        "--server-url",
        "https://stagebkt3.dev.beknown.live",
        "--token-file",
        "/absolute/path/toolyard-native.t3-token"
      ]
    }
  }
}
```

## Configure Codex

Use this entry in your Codex configuration:

```toml
[mcp_servers.toolyard-host]
command = "t3"
args = ["toolyard-mcp-bridge", "--server-url", "https://stagebkt3.dev.beknown.live", "--token-file", "/absolute/path/toolyard-native.t3-token"]
```

For a personal local server, replace the origin with its loopback URL.
For example, use `http://127.0.0.1:3773` if the server uses port 3773.
Remote origins require HTTPS.
The helper rejects URLs with embedded credentials or a different endpoint path.
It rejects token files with other-user permissions or symbolic links.

Clients with direct HTTP MCP support can use `/mcp/toolyard` with their own T3 authorization method.
DPoP-bound sessions require a valid DPoP proof on every HTTP request.
The stdio helper supports bearer credentials only.
It does not extract credentials from browser storage.

## Audit and recovery

Toolyard records the request under the dedicated host agent and its account owner.
The native endpoint supplies the client type `cli`.
It supplies a native session label from the authenticated T3 session.
The proxy removes caller-supplied identity and audit headers.
The session label is attribution metadata, not a separate permission grant.

The endpoint checks the connection owner and current account status on every request.
Revocation or a disabled integration stops new requests.
The proxy does not follow Toolyard redirects or retry failed requests.
After an uncertain write, inspect Inbox execution status before another write.
The proxy delivers SSE events as they arrive.
Each exchange has a 60-second deadline and an 8 MiB response limit.
Client cancellation closes the upstream exchange.

Protocol tests cover stdio, HTTP, owner isolation, revocation, and private token files.
They do not prove installation on every native client or physical device.
