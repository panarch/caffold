# Caffold

Caffold is a browser-based review and control surface for Codex-backed
development work. It runs on a trusted Mac or Linux host and keeps Tasks,
conversations, approvals, files, diffs, tests, GitHub context, and managed git
worktrees available from a desktop or mobile browser.

Codex remains the execution engine and git remains the source of truth for code
changes. Caffold makes that work easier to inspect, guide, and continue without
trying to become an IDE or an autonomous coding product.

## What Caffold provides

- persistent Codex Tasks with live turns, steering, interruption, and approvals;
- responsive Conversation, Files, Integrated Review, Git, and GitHub surfaces;
- explicit Caffold-managed worktree preparation, archive, and restore;
- a host-local multilingual Whisper voice-input path;
- installable PWA access over localhost or tailnet-only Tailscale Serve; and
- a macOS menu-bar host or a Linux user service around the same Rust backend.

## Install

Caffold requires the authenticated official standalone Codex CLI `0.147.0` or
newer. Install Codex, run `codex` once, and complete sign-in before starting
development work in Caffold.

| Host | Supported package | Tested system |
| --- | --- | --- |
| macOS arm64 | Homebrew Cask and menu-bar app | macOS 14 or later |
| Linux x86_64 | Homebrew Formula or release tarball | Ubuntu 24.04 |
| Linux aarch64 | Homebrew Formula or release tarball | Ubuntu 24.04 |

On an Apple silicon Mac:

```sh
brew install --cask panarch/tap/caffold
```

On a 64-bit glibc Linux host:

```sh
brew install panarch/tap/caffold
brew services start panarch/tap/caffold
```

The macOS app serves `http://127.0.0.1:5178`. The Linux service serves
`http://127.0.0.1:5177`. See the [installation guide](docs/product/installation.md)
for updates, manual Linux archives, service behavior, storage, and uninstallation.

## Private remote access

Caffold stays bound to localhost by default. Tailscale is an optional external
CLI integration, not a Caffold package dependency. On Linux, expose the running
service to the current tailnet with:

```sh
caffold tailscale enable
```

Inspect or remove only Caffold's own mapping with:

```sh
caffold tailscale status
caffold tailscale disable
```

The adapter refuses to overwrite or disable another HTTPS Serve target. Caffold
uses tailnet-only Serve, never public Tailscale Funnel. The macOS menu applies
the same shared CLI contract to its configured port.

## Local voice input

The task composer can download the pinned multilingual Whisper
`large-v3-turbo` model on first use. Audio is sent only to the same Caffold
host, processed in memory, and never stored or sent to an external speech
service.

macOS automatically uses Metal when available. Linux defaults to Vulkan and
falls back to CPU when a usable GPU backend is unavailable. To skip GPU
initialization explicitly:

```sh
caffold serve --whisper-acceleration cpu
```

## Trust boundary

Caffold is intended for one trusted user on a trusted host, reached locally or
through a trusted private network. Direct public-internet exposure is not
supported. Tailscale protects the transport but does not add application-level
multi-user authentication or authorization.

## Documentation and development

- [Installation and operation](docs/product/installation.md)
- [Current product status](docs/product/status.md)
- [Product workflows](docs/product/workflows.md)
- [Architecture](docs/architecture/overview.md)
- [Roadmap](docs/product/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Testing](docs/development/testing.md)
- [Release process](docs/operations/release.md)

The complete [documentation index](docs/README.md) groups product,
architecture, development, review, and maintainer material by owner.
