# Updates

## Caffold

The menu-bar app looks for a new stable release when it starts and when you
open its menu more than six hours after the last check. To install one:

1. Choose **Check for Updates…** from the menu-bar app.
2. Approve the update. If Tasks are still working, Caffold asks you to confirm
   first; see [Running work during an update](#running-work-during-an-update).
3. Homebrew replaces the app and the `caffold` command. Caffold then relaunches
   and waits until its server is ready again.

The same update from a terminal:

```sh
brew upgrade --cask panarch/tap/caffold
```

Open windows keep the version they loaded. When a new version is ready, a
**Caffold update ready** dialog offers **Reload** or **Later**, and
**Settings → About Caffold** keeps a **Reload to update** action until you do.

## Running work during an update

An update restarts the Caffold server, not the agents:

- **Codex** and **Grok** turns keep running, and Caffold reconnects to them
  when it is back.
- **Claude Code** sessions keep running if the new server is back within ten
  minutes. Otherwise they stop, and each conversation resumes from Claude's
  own history when you open its Task again.

## Codex

Caffold does not update Codex in the background. **Settings → Codex** shows the
installed version, the running version, the newest release, and whether
Codex's own automatic updates are on.

**Update Codex…** asks for confirmation, runs Codex's own updater once, and
reports what Codex did, including whether its runtime restarted.
**Restart runtime…** restarts that runtime without updating it. Every Codex
Task, and any other app connected to Codex, shares that runtime, so both can
interrupt running work and neither runs without your confirmation.

## Claude Code and Grok

Caffold does not update Claude Code or the Grok CLI; update them with their
own tools.

**Restart runtime** in **Settings → Claude** stops Caffold's runner and every
Claude session it holds, then starts a fresh runner with the installed
`claude`. Use it after updating Claude Code. Each conversation resumes from
Claude's own history when you open its Task again.

**Settings → Grok** shows the build of Caffold's Grok leader next to the
installed version, so you can see when they differ.
