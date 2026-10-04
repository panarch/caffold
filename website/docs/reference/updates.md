# Updates

## Caffold

When a new version is out, a dot appears on **Settings**. Update Caffold one of
these ways:

- **At the Mac:** choose **Update to Caffold X…** in the menu-bar app.
- **From another device:** choose **Update Caffold** in **Settings → About
  Caffold**.
- **From a terminal:** run `brew upgrade --cask panarch/tap/caffold`, then quit
  and reopen Caffold Server.

The first two back up Caffold and restore it if the new version does not start.

**Update Caffold** starts a Task in which an agent runs the update and stays
with it. Choose the mode that allows everything, **Full access** or **Allow
all**, if the agent should recover Caffold even when the restore fails. Other
modes can stop at the update command, and while Caffold restarts no one can
answer approvals.

If an update is rolled back, each browser says so once, the menu-bar app says
so if you started it there, and **Settings → About Caffold** shows it under
**Last update**. The dot stays, and you can try again.

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
- Open [terminals](../tasks/terminal.md) close.

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
