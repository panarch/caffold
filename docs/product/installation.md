# Installation and Operation

This guide covers the supported way to install, start, update, and remove
Caffold on macOS. Caffold runs on one trusted Mac; its browser/PWA is the
primary product interface.

Source builds and development servers are separate contributor workflows. See
[Contributing](../../CONTRIBUTING.md) when developing Caffold itself.

## How the installation fits together

Only the host Mac needs the native `Caffold Server.app`. That Mac runs the
Caffold backend, keeps the Codex app-server connection available, and reads the
Git checkouts and worktrees stored on the Mac.

The user interface is a web app served by that host:

- on the same Mac, open its local URL;
- on another desktop, foldable, phone, or tablet, open its private Tailscale
  HTTPS URL; and
- on any supported browser, optionally install that page as a PWA for an
  app-like window, launcher icon, and home-screen entry.

An installed PWA is still a client of the host Mac. It does not contain Codex,
clone the repository, or run Tasks on the device. The Mac must be awake,
Caffold Server must be running, and the chosen URL must be reachable. Closing
the PWA does not end an active Codex turn on the host.

## Requirements

Caffold supports Apple silicon Macs running macOS 14 or later. Installation and
updates use [Homebrew](https://brew.sh/).

Caffold requires the official standalone Codex CLI `0.147.0` or newer at
`~/.local/bin/codex`. Install it, run `codex`, and complete sign-in:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Caffold shows persistent setup guidance if the supported Codex installation is
missing, outdated, signed out, or needs to be restarted.

Git is required for repository and worktree features. These integrations are
optional and disable only their own surfaces when absent:

- an authenticated [GitHub CLI](https://cli.github.com/) for GitHub Issue and
  Pull Request views; and
- [Tailscale](https://tailscale.com/download) for private access from another
  device.

## Install Caffold

Install the Homebrew Cask:

```sh
brew install --cask panarch/tap/caffold
```

The Cask installs `Caffold Server.app` in `/Applications` and links the bundled
`caffold` CLI. Launch `Caffold Server` from Applications. It stays in the menu
bar instead of opening a browser automatically.

Choose `Open Caffold` from the menu to open `http://127.0.0.1:5178`. The
menu-bar app starts and controls the local backend; the browser or installed PWA
contains the complete Caffold workspace.

Start a Task by choosing its directory and sending a prompt. A Task keeps the
Codex conversation and work associated with that directory together. It can
start in an ordinary checkout and explicitly prepare a Caffold-managed
worktree later when isolation is useful.

A Section is an optional fixed-directory workspace for a repository or another
location you return to often. It can start Tasks without choosing the directory
again. Repository-backed Tasks and Sections expose Working Tree, Branch, Git,
and read-only GitHub surfaces from the same workspace; each Task also keeps its
own Conversation.

## Private access with Tailscale

Install Tailscale on the Mac and connect it to the tailnet used by the reviewing
device. Choose `Turn On Tailscale Serve` from the Caffold menu. The menu reports
the tailnet-only HTTPS URL when Serve is ready.

`Server Settings...` can start Tailscale Serve automatically. Caffold remains
bound to localhost and uses Tailscale Serve for the private HTTPS path; LAN
binding is not required.

Caffold refuses to replace a different Tailscale Serve target. It does not use
Tailscale Funnel, and direct public-internet exposure is not supported.

## Install the browser interface as a PWA

First open the Caffold URL you intend to keep using on that device. Use the
browser's **Install App** or **Add to Home Screen** action; the exact label and
location vary by browser and operating system.

Use the local `http://127.0.0.1:5178` address only on the host Mac. On another
device, use the HTTPS URL reported by Tailscale Serve—`127.0.0.1` on a phone
would refer to the phone itself, not the Mac.

If you run more than one Caffold host, set a distinct installed PWA name under
`Server Settings...` before installing it on a device. An existing PWA may
need to be reinstalled after that name changes.

## Completion notifications

Each browser can opt in separately under **Settings → Notifications**. Choose
**Enable** and approve the browser permission to receive a system notification
when a managed Task turn completes, fails, or is interrupted. On iOS, add
Caffold to the Home Screen before enabling notifications.

Notifications contain only the Task name and terminal status, never prompts,
generated content, repository paths, or working directories. Delivery is
best-effort while the Caffold backend is running; missed notifications are not
sent later when the backend restarts.

## Optional GitHub views

Install and authenticate GitHub CLI on the Mac that runs Caffold:

```sh
brew install gh
gh auth login
```

Caffold derives the active GitHub repository from the selected Task or Section.
Its GitHub surfaces are read-only; comments, reviews, Pull Requests, and other
remote mutations remain outside the product boundary.

## Voice input

The Task composer supports multilingual voice input processed by the Caffold
host. On first use, Caffold asks before downloading the pinned Whisper
`large-v3-turbo` model (about 1.5 GiB) under:

```text
~/Library/Application Support/Caffold/data/models/whisper
```

Caffold verifies the download before publishing it and loads the model lazily
for the first transcription. Voice recordings are sent only to the same
Caffold host, processed in memory, and never persisted or sent to an external
speech service.

## Updates

The menu-bar app checks the latest stable GitHub Release for version discovery.
For a Homebrew-managed installation, choose `Check for Updates…`, approve the
update, and let Homebrew replace the app and bundled CLI. Caffold then
relaunches and confirms that its owned local server becomes ready.

The equivalent command is:

```sh
brew upgrade --cask panarch/tap/caffold
```

Active Codex turns run in the persistent app-server daemon. Replacing or
quitting the Caffold wrapper closes its proxy connection but does not stop the
daemon's active turns.

## Data and removal

Caffold stores runtime data and downloaded models under:

```text
~/Library/Application Support/Caffold/data
```

Logs are stored under `~/Library/Logs/Caffold`. Remove the installed app and
CLI with:

```sh
brew uninstall --cask panarch/tap/caffold
```

A normal uninstall does not request Cask `zap`. The Cask's zap operation also
removes Caffold data, logs, and preferences. This includes the default
`data/worktrees` directory used for Caffold-managed worktrees and can remove
uncommitted changes stored there. Inspect those worktrees and retain or commit
any work you need before using `zap`.

## Package and contributor details

See [Caffold Server for macOS](../../desktop/macos/README.md) for bundle
construction, packaging, native-wrapper integration, and maintainer behavior.
Use [macOS local application development](../development/macos-local-app.md)
when replacing an installed development build.
