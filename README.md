# Caffold

Caffold is a browser interface for doing development work with Codex on a Mac
you control.

It started from a simple change in the way coding felt. Once Codex was doing
more of the typing and command execution, the part that still needed a
developer was mostly reading code, checking diffs, making decisions, and giving
the next instruction. That part turned out to work well in a browser, whether
the browser was on a desktop, a foldable, a tablet, or a phone.

Caffold keeps that whole loop together. It is not a remote terminal, and it
does not hide the underlying work: the conversation, commands, tests, files,
and Git diff stay available for inspection.

## What it looks like

![A completed Caffold Task with its conversation, test result, and changed files](docs/assets/showcase-conversation.png)

_Follow the Task as it runs, then read the result and decide what comes next._

![The same Caffold Task reviewing a README diff in Working Tree](docs/assets/showcase-working-tree.png)

_Open Working Tree to review the actual files and diff without leaving the
Task._

Both images come from the repository's reproducible Playwright showcase rather
than a hand-built mockup.

## How it works

Only one machine does the actual work. Install `Caffold Server.app` on the Mac
that has Codex, Git, and your checkouts. The app stays in the menu bar, keeps
the Caffold backend available, and connects the browser interface to Codex and
the files on that Mac.

```text
browser or installed PWA
(desktop, foldable, tablet, phone)
             |
    local URL or private
    Tailscale HTTPS URL
             |
    Caffold Server on Mac
          /       \
 Codex app-server  Git checkouts and worktrees
```

On the host Mac, `Open Caffold` opens the local address. On another device,
Tailscale Serve provides a private HTTPS address. Open that address in the
device's browser and, if useful, install it with the browser's **Install App**
or **Add to Home Screen** action.

Each PWA is a window onto the same Mac, not another copy of the server. Tasks,
Codex execution, repositories, and local data remain on the host. Closing a
browser or PWA does not end an active Codex turn, but the Mac must stay awake,
running Caffold, and reachable for another device to use it.

## A typical Task

1. Start a Task in the directory where the work belongs.
2. Follow the conversation and respond to approval requests while Codex works.
3. Read the result, command and test output, changed files, and actual diff.
4. Type or dictate the next instruction, or return later and continue the same
   Task.

Caffold also keeps the Task connected to its repository, optional managed
worktree, Git history, and read-only GitHub Issue or Pull Request context.

## Install on macOS

Caffold supports Apple silicon Macs running macOS 14 or later. It requires the
authenticated official standalone Codex CLI `0.147.0` or newer.

Install Codex, then run `codex` once and complete sign-in:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Install Caffold with Homebrew:

```sh
brew install --cask panarch/tap/caffold
```

Launch `Caffold Server` from Applications, then choose `Open Caffold` from its
menu-bar menu.

The [Installation and operation guide](docs/product/installation.md) explains
the host/client arrangement, PWA installation, optional GitHub and Tailscale
integration, updates, local data, voice input, and removal.

## Work without a keyboard

The Task composer supports host-local multilingual voice input. On first use,
Caffold asks before downloading the pinned Whisper `large-v3-turbo` model
(about 1.5 GiB). Audio is sent only to the same Caffold host, processed in
memory, and never stored or sent to an external speech service.

Voice is useful here for the same reason the browser interface is useful: much
of the work is giving direction, reading what happened, and following up. A
keyboard is welcome, but it should not be required for every step.

## Current limits

Caffold currently assumes one trusted user, one trusted Mac, and a private
network. It does not provide authentication for a public deployment or
multi-user authorization.

Its Git and GitHub views are deliberately review-oriented. Caffold does not
provide a full editor or terminal, and it does not expose stage, commit,
checkout, merge, rebase, reset, stash, publication, or review mutation controls.
Those operations can still be requested through Codex or performed with the
developer tools you already use.

Managed-worktree preparation is explicit, and Caffold only cleans up worktrees
that it created and recorded. The complete implemented scope and limitations
are tracked in [Current Product Status](docs/product/status.md).

## Documentation and development

- [Installation and operation](docs/product/installation.md)
- [Product vision](docs/product/vision.md)
- [Current product status](docs/product/status.md)
- [Product workflows](docs/product/workflows.md)
- [Roadmap](docs/product/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Testing](docs/development/testing.md)

The complete [documentation index](docs/README.md) groups product,
architecture, development, review, and maintainer material by purpose. Caffold
is available under the [Apache License 2.0](LICENSE).
