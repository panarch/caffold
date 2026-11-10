# Menu-bar app

On a Mac, **Caffold Server** lives in the menu bar and starts and controls the
Caffold server. Its menu opens with **Open Caffold**, followed by five groups.
On Linux, the systemd user service `caffold.service` runs the server instead;
see [Install on Linux](../get-started/install.md#install-on-linux).

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

## Agents

A row for each agent Caffold works with: Codex, Claude, Grok, and
Antigravity. A row shows only whether the agent's command-line tool is
installed. Sign-in, plan, and usage are on the agent's page in
[Settings](settings.md).

- A check mark: installed, and Caffold can run it. Its submenu shows the
  version.
- A dashed circle: not installed. An agent you don't use stays this way.
- A cross: installed, but Caffold can't run it, for example because it is
  older than Caffold supports.
- **Open *agent* Settings...** in the submenu opens that agent's Settings page.

Until the server answers for the first time, the group holds one line instead:
**Checking...**, **Preparing...**, or **Server unavailable**. Once the agents
are listed they stay, and each reads **Server unavailable** while the server
does not answer.

## Integrations

Whether Git, the GitHub CLI, and voice input are ready.

## Application

- **Check for Updates…**; see [Updates](updates.md).
- **About Caffold Server**, with the build of the app.
- **Show Logs** opens Caffold's log folder, `~/Library/Logs/Caffold`.
- **Quit**.
