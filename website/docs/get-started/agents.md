# Set up your agents

Set up at least one supported coding agent on the host. New Task offers the
models of every agent
Caffold can reach.

Caffold uses each agent's own sign-in. It never reads or stores your agent
credentials. Install and sign in to each agent separately on the host.

## Codex

Caffold supports the official standalone Codex CLI `0.155.1` or newer,
installed at `~/.local/bin/codex`. A Codex installed another way, for example
with Homebrew, is reported as unsupported. Install it, then run `codex` once
and complete sign-in:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Caffold uses the CLI to start and connect to the App-server. The App-server
package is managed separately and can have a different version from the CLI.

**Settings → Codex** reports whether Codex is installed, signed in, and ready,
and says how to fix it when it is not. A Codex problem blocks only Codex: your
existing Tasks stay readable, and other agents keep working.

![Settings → Codex: usage, reset credits, and a ready App-server with its version](../assets/screenshots/settings-codex-light-desktop.png#only-light)
![Settings → Codex: usage, reset credits, and a ready App-server with its version](../assets/screenshots/settings-codex-dark-desktop.png#only-dark)

Codex's own automatic updates restart it in the middle of running work, so
Caffold turns them off unless you have set them yourself in Codex's settings.
Update Codex from **Settings → Codex** instead; see
[Updates](../reference/updates.md#codex).

## Claude Code

Caffold supports Claude Code `2.1.259` or newer. Install it with its official
setup, run `claude` once, and complete sign-in. Caffold looks for `claude` on
its `PATH`, which includes `~/.local/bin` and `/usr/local/bin`, and also
`/opt/homebrew/bin` on a Mac.

**Settings → Claude** shows your usage as Claude reports it, the version and
path Caffold found, the signed-in account and plan, and the state of Caffold's
runner, a small process that keeps Claude Code sessions going while the
Caffold server restarts. When a Claude operation cannot run, the Task shows
Claude's own error.

## Grok

Caffold supports the Grok CLI `1.0.30` or newer. Install it with its official
setup, run `grok` once, and complete sign-in. Caffold looks for `grok` on its
`PATH` and at `~/.grok/bin/grok` and `~/.local/bin/grok`.

The first time Caffold needs Grok, it starts a Grok background process of its
own, which **Settings → Grok** shows as its **Leader**. The leader keeps Grok
turns running while the Caffold server restarts, and it stays running after
Caffold quits. **Settings → Grok** also shows your usage, the version and path
Caffold found, and the signed-in account.

## Antigravity

Install [Antigravity CLI](https://antigravity.google/docs/cli/) `1.5.1` or newer.
Caffold finds `agy` on its executable search path or at `~/.local/bin/agy`.

1. Run `agy` in a terminal on the host and finish the CLI's sign-in.
2. Open **Settings → Antigravity** to check the installed version, account,
   plan, quota and models. **Refresh** repeats the check.
3. Choose an Antigravity model in New Task.

Caffold shares the CLI's saved sign-in. Manage that sign-in in the CLI.

![Antigravity CLI and observed Google account plan](../assets/screenshots/settings-antigravity-light-desktop.png#only-light)
![Antigravity CLI and observed Google account plan](../assets/screenshots/settings-antigravity-dark-desktop.png#only-dark)

You can send more instructions while Antigravity works. Answer a pending
permission, or stop the turn, before sending another prompt.

Next, [run your first Task](first-task.md).
