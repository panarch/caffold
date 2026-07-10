# Caffold Server for macOS

`Caffold Server` packages the Rust server as a portable macOS menu bar application. The browser/PWA remains the primary Caffold interface; this app starts and controls the local server.

## Build

```sh
desktop/macos/package-app build
```

The app is written to `target/caffold-server/Caffold Server.app` and can be moved directly to `/Applications` or transferred with AirDrop.

Create an optional zip archive only when a single-file distribution container is useful:

```sh
desktop/macos/package-app archive
```

The archive is written to `target/caffold-server/Caffold-Server-macos-<arch>.zip`.

## Runtime dependencies

- Codex CLI or Codex.app, already authenticated
- Git
- GitHub CLI for GitHub views
- Tailscale for private remote access

Missing optional dependencies do not prevent the server from starting. The menu status reports when Tailscale is unavailable or its Serve setup fails.

## Runtime behavior

- Caffold listens on `http://127.0.0.1:5178`.
- When Tailscale is available, the app configures tailnet-only Tailscale Serve on HTTPS port 443.
- The default browser opens after the local health check succeeds.
- The menu bar icon reopens Caffold, configures the server, exposes logs, retries Tailscale Serve, and quits the server.
- Data is stored in `~/Library/Application Support/Caffold/data`.
- Logs are stored in `~/Library/Logs/Caffold/caffold.log`.

`Server Settings...` controls the installed PWA name, bind mode, port, and automatic Tailscale Serve startup. Use a distinct name before installing the PWA to distinguish multiple Caffold servers; existing installations may need to be reinstalled after a name change. Local-only binding is the default. LAN binding is an explicit opt-in and is not required for Tailscale Serve.

The menu reports stable status rows for Codex, Git, GitHub CLI, Tailscale connectivity, and the Caffold Serve URL. Missing integrations disable only their related features; the file browser and server remain available.

The app only restarts a server process that it started. When it connects to an existing Caffold process, choosing a different port starts a separate app-managed server and leaves the external process untouched. Changing only the bind mode on the occupied port remains blocked.

The private `.notes/bin/caffold-5178` helper remains separate. It manages the local development/validation service and is not part of the distributed application.
