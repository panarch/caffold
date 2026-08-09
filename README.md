# Caffold

Caffold is scaffolding for agent-assisted development: a browser-based review and control surface that helps developers inspect, guide, and validate Codex-backed code work across git worktrees.

It runs Codex-powered development tasks on a trusted host and gives the developer a browser-based surface for reviewing task state, diffs, files, test results, approvals, and follow-up prompts.

Caffold is not an autonomous coding product, an IDE, or a replacement for the Codex GUI.

Its narrower goal is to make agent-generated code review practical away from the desktop app, including on mobile and foldable devices.

## Why

Foldable phones and wider mobile displays make it increasingly plausible to review real code changes away from a desk.

Agent-assisted development makes that more useful. The developer still makes the judgment calls, but more of the day-to-day work becomes reading diffs, checking tests, inspecting files, approving commands, and sending follow-up prompts instead of typing every edit by hand.

That shift makes a browser-based review console practical. The important surface is not a full editor. It is a fast, reliable way to inspect agent output and decide what should happen next.

For long-running code work, the hard part is often not the agent itself. It is the surface around the agent: finding the right session again, understanding which worktree changed, reading the diff without opening a full editor, approving commands remotely, and continuing the review loop from another device.

Codex remains the work execution engine. The git worktree remains the construction site. Caffold is the structure a developer uses to get close to the work, inspect it, guide it, and decide what is safe to keep.

## Shape

Caffold consists of:

- a Rust backend running on each trusted host
- a browser/PWA frontend served by that backend
- a persistent Codex app-server daemon reached through a disposable proxy child
- JSON-RPC integration between the backend and Codex app-server
- Codex threads as the source of truth for task history
- git worktrees as the source of truth for code changes
- Tailscale or another trusted private network for remote access

## Core Principle

Caffold should make agent output easier to inspect, question, accept, reject, and continue.

It should not try to become VS Code, a full git GUI, or a native mobile app.

## Run

Building Caffold from source requires Rust, CMake, and the Xcode Command Line
Tools. On macOS, install the native build prerequisites with:

```sh
brew install cmake
xcode-select --install
```

Start Caffold:

```sh
cargo run -- serve
```

Then open the printed local URL. By default Caffold opens at `$HOME`, displays it as `~`, and allows read-only parent navigation up to the filesystem root.

For deterministic local testing, a bounded root can be supplied:

```sh
cargo run -- serve --root tests/fixtures/home
```

## Caffold Server for macOS

`Caffold Server` packages the Rust backend as a portable macOS menu bar app while the browser/PWA remains the primary interface.

Install Caffold on an Apple silicon Mac running macOS 14 or later:

```sh
brew install --cask panarch/tap/caffold
```

The Cask installs `Caffold Server.app` in `/Applications` and links the bundled `caffold` CLI.
Homebrew-managed installations can check for updates from the menu bar app. Caffold uses the
latest GitHub Release only for version discovery; an approved update is installed by Homebrew and
the app restarts after verifying the replacement bundle.

Caffold's restart-safe Codex transport requires the official standalone Codex
installation, already authenticated:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Caffold starts the user's persistent app-server daemon when needed and connects
through a disposable proxy. Replacing or quitting Caffold closes only that proxy;
it does not stop an active Codex turn in the daemon.

The task composer also supports keyboard-independent voice input. On first use,
Caffold asks before downloading the pinned multilingual Whisper `large-v3-turbo` model
(1,624,555,275 bytes, about 1.5 GiB) to the host data directory and verifies its
SHA-256 checksum. Microphone audio is sent only to the same Caffold host, decoded
in memory, and never saved. The model loads on the first transcription and stays
loaded until the Caffold backend exits. Localhost works directly; Tailscale only
provides the existing private HTTPS path when the browser is on another device.

Build the application bundle with:

```sh
desktop/macos/package-app build
```

The app is written to `target/caffold-server/Caffold Server.app`. Its menu reports Codex, Git, GitHub CLI, Whisper, and Tailscale status and controls the server name, bind mode, port, restart behavior, and tailnet-only Tailscale Serve access. Missing integrations disable only their related features.

See [Caffold Server for macOS](desktop/macos/README.md) for installation, runtime dependencies, storage paths, and packaging details.

## Test

Install the committed Node dependencies, then run Rust checks:

```sh
npm ci
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Run browser tests:

```sh
npm run test:e2e
```

Playwright tests verify behavior and write review screenshots under
`test-results`. The repository does not store Playwright snapshot baselines, so
visual comparisons should use screenshots generated from `main` and the pull
request head in the same runner.

See [Contributing](CONTRIBUTING.md) and the [testing guide](docs/development/testing.md)
for the complete Node, macOS, protocol, live Codex, and coverage matrix. Local
development and automated tests use isolated ports and data directories rather
than the installed application's database.

## Documentation

The complete [documentation index](docs/README.md) is organized by purpose.

Product:

- [Vision](docs/product/vision.md)
- [Current Product Status](docs/product/status.md)
- [Product Workflows](docs/product/workflows.md)
- [UI Surfaces](docs/product/ui-surfaces.md)
- [Roadmap](docs/product/roadmap.md)

Architecture and engineering policy:

- [Architecture Overview](docs/architecture/overview.md)
- [Review Policy](docs/review/policy.md)

Development:

- [Contributing](CONTRIBUTING.md)
- [Testing](docs/development/testing.md)
- [macOS Local Application Development](docs/development/macos-local-app.md)
- [Mobile and PWA Testing](docs/development/mobile-pwa-testing.md)

Operations:

- [macOS Release Process](docs/operations/macos-release.md)

## Status

This repository has a Codex-first task workspace plus read-only Files, Git, and GitHub review surfaces. The broader review and control workflow remains under active design and implementation.
