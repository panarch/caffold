# Install

Install Caffold on the computer that will run your agents, a Mac or a Linux
machine: the *Caffold host*. Other devices need no installation beyond a
browser; they connect to the host.

## Requirements

- A host that is one of:
    - an Apple silicon Mac running macOS 14 or later, with
      [Homebrew](https://brew.sh/), which installs and updates Caffold;
    - an x86_64 or aarch64 Linux machine with glibc 2.28 or later and systemd,
      such as Ubuntu 20.04, Debian 10, RHEL 8, or a later release.
- Git, for repository and worktree features.
- At least one coding agent installed and signed in on the host: Codex, Claude
  Code, Grok, or Antigravity.
  [Set up your agents](agents.md) lists the supported versions and steps.

Optional:

- [Tailscale](https://tailscale.com/download), to open Caffold from other
  devices. See [Use other devices](other-devices.md).
- The [GitHub CLI](https://cli.github.com/), signed in, for Issue and Pull
  Request views. See [GitHub](../review/github.md).

## Install on a Mac

```sh
brew install --cask panarch/tap/caffold
```

This installs **Caffold Server** in `/Applications` and links the bundled
`caffold` command. To open Caffold:

1. Launch **Caffold Server** from Applications. It appears in the menu bar
   instead of opening a window.
2. Choose **Open Caffold** from its menu.

Your browser opens `http://127.0.0.1:5178`. That page is the whole Caffold
workspace; the [menu-bar app](../reference/menu-bar-app.md) only starts and
controls the server.

## Install on Linux

Run this as the user Caffold will run as:

```sh
curl -fsSL https://caffold.dev/install.sh | sh
```

The script installs Caffold in `~/.local/share/caffold`, links the `caffold`
command in `~/.local/bin`, and starts the systemd user service
`caffold.service`, which serves Caffold at `http://127.0.0.1:5178`. It also:

- keeps the service running after you log out, or shows the `sudo` command that
  does;
- turns on Tailscale Serve when Tailscale is installed, and shows the address to
  open on your other devices. If Tailscale denies it, run
  `sudo tailscale set --operator=$USER` and run the script again.

On NixOS, enable `programs.nix-ld` in your configuration before you run the
script.

Open the address the script shows. Without Tailscale, forward the port over
SSH from your computer, for example `ssh -L 5178:127.0.0.1:5178 your-host`,
and open `http://127.0.0.1:5178`.

Next, [set up your agents](agents.md).
