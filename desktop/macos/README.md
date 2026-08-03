# Caffold Server for macOS

`Caffold Server` packages the Rust server as a portable macOS menu bar application. The browser/PWA remains the primary Caffold interface; this app starts and controls the local server.

## Install

The current preview requires an Apple silicon Mac running macOS 14 or later. Install it with:

```sh
brew install --cask panarch/tap/caffold
```

The Cask installs `Caffold Server.app` in `/Applications` and links the bundled CLI as `caffold`. The preview is ad-hoc signed and not Apple-notarized; installation clears its quarantine attribute.

## Build

```sh
desktop/macos/package-app build
```

The app is written to `target/caffold-server/Caffold Server.app` and can be moved directly to `/Applications` or transferred with AirDrop.

Create and verify a versioned zip archive with:

```sh
desktop/macos/package-app archive
```

The command uses the committed Cargo lockfile and verifies both the bundle and its archived copy. It writes:

```text
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip.sha256
```

Maintainers preparing a distribution should follow the [internal release process](../../docs/internal/macos-release.md).

## Runtime dependencies

- Codex CLI or Codex.app, already authenticated
- Git
- GitHub CLI for GitHub views
- Tailscale for private remote access

Missing optional dependencies do not prevent the server from starting. The menu status reports when Tailscale is unavailable or its Serve setup fails.

## Runtime behavior

- Caffold listens on `http://127.0.0.1:5178`.
- When Tailscale is available, the app configures tailnet-only Tailscale Serve on HTTPS port 443.
- Startup keeps the server in the menu bar without opening the default browser.
- `Open Caffold` in the menu opens the browser; reopening the running app does the same.
- The menu bar icon also configures the server, exposes logs, retries Tailscale Serve, and quits the server.
- The About panel shows the version, build number, and local package date and time.
- The app checks the latest stable GitHub Release at launch and when its menu is reopened after six hours.
- `Check for Updates…` installs an approved update through Homebrew, then relaunches Caffold and confirms that its owned local server becomes ready.
- Data is stored in `~/Library/Application Support/Caffold/data`.
- Logs are stored in `~/Library/Logs/Caffold/caffold.log`.

`Server Settings...` controls the installed PWA name, bind mode, port, and automatic Tailscale Serve startup. Use a distinct name before installing the PWA to distinguish multiple Caffold servers; existing installations may need to be reinstalled after a name change. Local-only binding is the default. LAN binding is an explicit opt-in and is not required for Tailscale Serve.

The menu reports stable status rows for Codex, Git, GitHub CLI, Tailscale connectivity, and the Caffold Serve URL. Missing integrations disable only their related features; the file browser and server remain available.

The app only restarts a server process that it started. When it connects to an existing Caffold process, choosing a different port starts a separate app-managed server and leaves the external process untouched. Changing only the bind mode on the occupied port remains blocked.

Updates follow the same ownership rule. Caffold refuses to update while connected to an externally managed server. For an app-managed server, it reads canonical managed-task status before confirmation and warns if active work may be interrupted. GitHub is only the release-discovery source; Homebrew remains responsible for downloading, checksum verification, installation, and CLI-link replacement. Manually copied app bundles receive a release-page link instead of being overwritten.

The private `.notes/bin/caffold-5178` helper remains separate. It manages the local development/validation service and is not part of the distributed application.
