# Menu-bar app

**Caffold Server** lives in the menu bar and starts and controls the Caffold
server. Its menu opens with **Open Caffold**, followed by four groups.

## Server

- The server's status and port. **Server · Not responding** means the server
  is still running but has stopped answering, or never answered after it
  started.
- **Server Settings...** sets the **Name** of installed apps, which server
  address it listens on, the **Port**, and whether Tailscale Serve starts with
  the server. **Local only (127.0.0.1)** is the default, and
  [remote access](../get-started/other-devices.md) works with it.
- **Restart Server**, which reads **Start Server** while the server is stopped.
  A server that is not responding is stopped, forcibly if it does not quit,
  and started again.

## Remote Access

- Tailscale's status.
- **Open Tailnet URL** opens the private address.
- **Turn On Tailscale Serve** or **Turn Off Tailscale Serve** switches remote
  access.

## Integrations

Whether Codex, Git, the GitHub CLI, and voice input are ready.

## Application

- **Check for Updates…**; see [Updates](updates.md).
- **About Caffold Server**, with the build of the app.
- **Show Logs** opens Caffold's log folder, `~/Library/Logs/Caffold`.
- **Quit**.
