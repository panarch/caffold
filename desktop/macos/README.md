# Caffold Server for macOS

`Caffold Server` packages the Rust server as a portable macOS menu bar application. The browser/PWA remains the primary Caffold interface; this app starts and controls the local server.

## Install

The macOS application requires an Apple silicon Mac running macOS 14 or later. Install it with:

```sh
brew install --cask panarch/tap/caffold
```

The Cask installs `Caffold Server.app` in `/Applications` and links the bundled CLI as `caffold`. The application is ad-hoc signed and not Apple-notarized; installation clears its quarantine attribute.

## Build

Source builds require CMake and the Xcode Command Line Tools:

```sh
brew install cmake
xcode-select --install
```

```sh
desktop/macos/package-app build
```

The app is written to `target/caffold-server/Caffold Server.app`. For a new
manual installation, copy the bundle to `/Applications` or transfer it with
AirDrop. Use the local installer below when replacing an existing development
installation.

Create and verify a versioned zip archive with:

```sh
desktop/macos/package-app archive
```

The command uses the committed Cargo lockfile and verifies both the bundle and its archived copy. It writes:

```text
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip.sha256
```

Maintainers preparing a distribution should follow the [macOS release process](../../docs/operations/macos-release.md).

For a local development replacement of `/Applications/Caffold Server.app`, use
the tracked safe installer and runbook:

```sh
desktop/macos/install-local
```

The [local application development guide](../../docs/development/macos-local-app.md)
documents backup, shutdown, health verification, and rollback behavior.

## Runtime dependencies

- the [official standalone Codex install](https://chatgpt.com/codex/install.sh),
  version `0.147.0` or newer and already authenticated (the daemon command
  requires this installation layout)
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
- The first voice-input use asks before downloading the pinned multilingual
  Whisper `large-v3-turbo` model (about 1.5 GiB) under
  `~/Library/Application Support/Caffold/data/models/whisper`. Caffold verifies
  the download checksum before publishing it, then loads it lazily on the first
  transcription and retains it until the backend exits.
- Voice recordings are captured as 16 kHz mono PCM WAV, sent to this Caffold
  host, processed in memory, and never persisted or sent to an external speech
  service. Localhost needs no Tailscale; remote mobile access uses the same
  tailnet-only HTTPS Serve URL as the rest of Caffold.
- Logs are stored in `~/Library/Logs/Caffold/caffold.log`.
- Caffold ensures the persistent Codex app-server daemon is running, then owns
  only a disposable proxy connection. Caffold restarts and app replacements do
  not stop the daemon or its active turns.

`Server Settings...` controls the installed PWA name, bind mode, port, and automatic Tailscale Serve startup. Use a distinct name before installing the PWA to distinguish multiple Caffold servers; existing installations may need to be reinstalled after a name change. Local-only binding is the default. LAN binding is an explicit opt-in and is not required for Tailscale Serve.

The menu reports stable status rows for Codex, Git, GitHub CLI, Whisper model
readiness, Tailscale connectivity, and the Caffold Serve URL. Codex uses the
backend's canonical compact summary, and its current recovery action opens the
shared Codex Settings page. Here, avoiding duplication means that Swift does
not own separate setup classification, version heuristics, storage, or a
complete client-specific repair workflow. It does not forbid native menu
controls: Swift and the PWA may both expose a useful setting or action when
both call the same backend capability. Adding a complete browser setting does
not by itself require removing its compact native entry point. Missing
integrations disable only their related features; the file browser and server
remain available.

This same boundary applies as settings currently available only in the wrapper
gain browser surfaces. Shared product settings and operations belong behind the
Caffold server API so Swift and the PWA can consume one implementation.
macOS-only launch, bundle, process-ownership, and pre-server failure handling
remain native wrapper responsibilities.

The app only restarts a server process that it started. When it connects to an existing Caffold process, choosing a different port starts a separate app-managed server and leaves the external process untouched. Changing only the bind mode on the occupied port remains blocked.

Updates follow the same ownership rule. Caffold refuses to update while connected to an externally managed server. For an app-managed server, it reads canonical managed-task status before confirmation and warns if active work may be interrupted. GitHub is only the release-discovery source; Homebrew remains responsible for downloading, checksum verification, installation, and CLI-link replacement. Manually copied app bundles receive a release-page link instead of being overwritten.
