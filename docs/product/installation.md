# Installation and Operation

This guide covers the supported way to install, start, update, and remove
Caffold on macOS. Caffold runs on one trusted Mac; its browser/PWA is the
primary product interface.

Source builds and development servers are separate contributor workflows. See
[Contributing](../../CONTRIBUTING.md) when developing Caffold itself.

## How the installation fits together

Only the host Mac needs the native `Caffold Server.app`. That Mac runs the
Caffold backend, reaches the installed coding agents, and reads the Git
checkouts and worktrees stored there.

The user interface is a web app served by that host:

- on the same Mac, open its local URL;
- on another desktop, foldable, tablet, or phone, open its private Tailscale
  HTTPS URL; and
- on a supported browser, optionally install that page as a PWA for an
  app-like window, launcher icon, and home-screen entry.

An installed PWA is still a client of the host Mac. It does not contain an
agent, clone the repository, or run Tasks on the device. The Mac must be awake,
Caffold Server must be running, and the chosen URL must be reachable. Closing
the PWA does not end an active turn on the host.

## Requirements

Caffold supports Apple silicon Macs running macOS 14 or later. Installation and
updates use [Homebrew](https://brew.sh/). Git is required for repository and
worktree features.

Install and authenticate at least one supported coding agent. Installing both
makes both agents' available models selectable when a Task is created.

### Codex

Caffold supports the official standalone Codex CLI `0.147.0` or newer at
`~/.local/bin/codex`. Install it, run `codex`, and complete sign-in:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

**Settings → Codex** reports installation, authentication, app-server runtime,
and protocol readiness. A blocking Codex problem disables only Codex creation
and execution; existing readable Tasks and Claude remain available.

### Claude Code

Caffold supports Claude Code `2.1.259` or newer. Install Claude Code using its
official setup, make `claude` available on the Mac app's `PATH`, then run it and
complete sign-in. The released wrapper searches the common executable paths
including `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.

**Settings → Claude** reports the detected binary and version, signed-in
account and plan, usage windows as Claude reports them, and the Caffold runner
state. The report is diagnostic rather than a separate permission gate: if a
Claude operation cannot run, that operation returns the agent's actual error.

Caffold uses the CLI's existing authentication context. It does not read or
store Claude credentials, call the provider service with copied credentials,
or install Claude Code itself.

The Caffold application bundles `caffold-claude-runner`, not the `claude` CLI.
The runner is a transport and process supervisor for the installed CLI. See
[Agent runtimes](../architecture/agent-runtimes.md) for the ownership boundary.

### Optional integrations

These integrations disable only their own surfaces when absent:

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

Start a Task by choosing its directory, a model, and the first prompt. The
model identifies which agent runs the Task. That Task remains with the same
agent while later turns may change the model, effort, speed, or permission mode
among the choices that agent offers.

A Task can start in an ordinary checkout and explicitly prepare a
Caffold-managed worktree later when isolation is useful. A Section is an
optional fixed-directory workspace for a repository or another location you
return to often. Repository-backed Tasks and Sections expose Working Tree,
Branch, Git, and read-only GitHub surfaces from the same workspace; each Task
also keeps its own agent Conversation.

## Private access with Tailscale

Install Tailscale on the Mac and connect it to the tailnet used by the reviewing
device. Open local Caffold, then choose **Settings → Remote Access**. The page
distinguishes installation, connection, Serve, transition, conflict, and
failure states. When Tailscale is connected, choose **Enable** to configure only
Caffold's tailnet-only Serve mapping.

When access is ready, the page reports the private HTTPS Tailnet URL and offers
**Copy link**, **Open link**, and a QR code for that exact address. Install
Tailscale on the other device and sign in to an account permitted on the same
tailnet before opening or scanning it. A browser already using the Tailnet URL
can read status and the address, but Serve controls remain available only from
localhost on the host Mac.

The macOS menu retains its compact status, on/off action, and ready URL. Both
the menu and browser consume the same server-owned Tailscale status and Serve
operation rather than probing or configuring Tailscale independently.

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

## Task notifications

Each browser can opt in separately under **Settings → Notifications**. Choose
**Enable** and approve the browser permission to receive a system notification
when a managed Task turn completes, fails, or is interrupted, and when a Task
stops to wait for you to answer the agent's approval request. On iOS, add
Caffold to the Home Screen before enabling notifications.

A notification contains only the Task name with its terminal status or
`Approval required`. It never contains what the agent asked to do, prompts,
generated content, repository paths, or working directories; open the Task to
read the request and answer it. Delivery is best-effort while the Caffold
backend is running; missed notifications are not sent later when the backend
restarts.

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

## Updates and runtime continuity

The menu-bar app checks the latest stable GitHub Release for version discovery.
For a Homebrew-managed installation, choose `Check for Updates…`, approve the
update, and let Homebrew replace the app and bundled CLI. Caffold then
relaunches and confirms that its owned local server becomes ready.

The equivalent command is:

```sh
brew upgrade --cask panarch/tap/caffold
```

An active Codex turn lives in Codex's persistent app-server daemon; replacing
the Caffold backend closes its proxy and reconnects without stopping that turn.
An active Claude turn lives in the `claude` process held by Caffold's separate
runner; a normal backend replacement reconnects to that runner. If no backend
subscribes for ten minutes, the runner stops itself and the sessions it holds.
An explicit **Settings → Claude → Restart** also ends every held Claude session
before starting a fresh runner; their conversations resume from Claude's own
transcripts when the Tasks are opened again.

## Data and removal

Caffold stores its runtime data and downloaded models under:

```text
~/Library/Application Support/Caffold/data
```

Caffold keeps Task membership and its own UI/recovery metadata there. Codex
and Claude remain responsible for their own conversation records; Caffold does
not persist a second transcript.

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
