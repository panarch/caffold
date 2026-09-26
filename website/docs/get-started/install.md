# Install

Install Caffold on the Mac that will run your agents. Other devices need no
installation beyond a browser; they connect to this Mac.

## Requirements

- An Apple silicon Mac running macOS 14 or later.
- [Homebrew](https://brew.sh/), which installs and updates Caffold.
- Git, for repository and worktree features.
- At least one coding agent installed and signed in on the Mac: Codex, Claude
  Code, or Grok. [Set up your agents](agents.md) lists the supported versions.

Optional:

- [Tailscale](https://tailscale.com/download), to open Caffold from other
  devices. See [Use other devices](other-devices.md).
- The [GitHub CLI](https://cli.github.com/), signed in, for Issue and Pull
  Request views. See [GitHub](../review/github.md).

## Install Caffold

```sh
brew install --cask panarch/tap/caffold
```

This installs **Caffold Server** in `/Applications` and links the bundled
`caffold` command.

## Open Caffold

1. Launch **Caffold Server** from Applications. It appears in the menu bar
   instead of opening a window.
2. Choose **Open Caffold** from its menu.

Your browser opens `http://127.0.0.1:5178`. That page is the whole Caffold
workspace; the [menu-bar app](../reference/menu-bar-app.md) only starts and
controls the server.

Next, [set up your agents](agents.md).
