# Installation and Operation

This document owns the supported ways to install, start, update, and remove
Caffold. Caffold runs as one trusted-user service per host; the browser/PWA is
the primary product surface.

## Prerequisite

Caffold requires the official standalone Codex CLI `0.147.0` or newer at
`~/.local/bin/codex`. Install it, run `codex`, and complete sign-in. Git is
required for repository and worktree features. GitHub CLI and Tailscale are
optional and disable only their related integrations when absent.

## macOS

The supported macOS package requires Apple silicon and macOS 14 or later:

```sh
brew install --cask panarch/tap/caffold
```

Launch `Caffold Server` from Applications. Its menu-bar process owns the Rust
backend at `http://127.0.0.1:5178`, exposes status and settings, and stores data
under `~/Library/Application Support/Caffold/data`.

Homebrew-managed updates are explicitly approved from the menu app or run with:

```sh
brew upgrade --cask panarch/tap/caffold
```

Remove the package with `brew uninstall --cask panarch/tap/caffold`. Homebrew's
Cask zap operation can also remove Caffold data, logs, and preferences, so
inspect retained work before using it.

## Linux with Homebrew

Caffold publishes native x86_64 and aarch64 binaries for 64-bit glibc Linux.
Ubuntu 24.04 on both architectures is the directly tested baseline. Other
glibc distributions may work through Homebrew but are not part of that CI
contract. musl systems, 32-bit x86, and ARM32 are not supported.

Install and start Caffold as a non-root user service:

```sh
brew install panarch/tap/caffold
brew services start panarch/tap/caffold
```

Open `http://127.0.0.1:5177`. The Formula installs Homebrew's Vulkan loader and
starts `caffold serve` through the user's systemd manager. It does not install
a GPU driver or Tailscale. A machine without a usable Vulkan GPU still runs
Whisper on CPU.

Without `sudo`, `brew services` registers a systemd user service that starts at
login. A headless host that must start the user service before interactive
login can enable systemd lingering explicitly:

```sh
loginctl enable-linger "$USER"
```

That is a host administration choice, not a Caffold installation side effect.

Update and restart the installed service with:

```sh
brew upgrade panarch/tap/caffold
brew services restart panarch/tap/caffold
```

Stop and remove it with:

```sh
brew services stop panarch/tap/caffold
brew uninstall panarch/tap/caffold
```

Linux data remains under `~/.caffold`. Formula service output is written under
Homebrew's `var/log/caffold.log`.

## Linux release archive

Every supported release also publishes `Caffold-<version>-linux-x86_64.tar.gz`
and `Caffold-<version>-linux-aarch64.tar.gz` with adjacent SHA-256 files. This
is the fallback for users who do not want Homebrew. Verify the checksum, copy
`caffold` to a directory on `PATH`, and provide a system Vulkan loader such as
`libvulkan.so.1` through the host distribution.

The archive does not install a service definition. Run `caffold serve`
directly or connect it to the host's existing process supervisor.

## Whisper acceleration

`caffold serve` accepts:

- `--whisper-acceleration auto`: macOS tries Metal; Linux tries Vulkan; either
  platform retains the CPU backend as fallback.
- `--whisper-acceleration cpu`: skip GPU initialization and use CPU only.

The production model remains the pinned multilingual `large-v3-turbo` model.
The smaller multilingual tiny model is used only by the opt-in inference smoke
workflow.

## Tailscale Serve

Tailscale is optional and independently installed. With Caffold already
running and Tailscale connected:

```sh
caffold tailscale enable
caffold tailscale status
```

The default target is `http://127.0.0.1:5177`. A non-default development or
macOS target can be supplied explicitly:

```sh
caffold tailscale enable --target http://127.0.0.1:5178
```

The command configures persistent tailnet-only HTTPS Serve on port 443. It is
idempotent for the exact Caffold target and refuses an existing handler or
another proxy target. `caffold tailscale disable` has the same ownership check
and will not turn off another service's mapping.

Do not use Tailscale Funnel for Caffold. Caffold has no public-deployment
authentication boundary.
