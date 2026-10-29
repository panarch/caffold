# Troubleshooting

## Caffold does not open

- Check that **Caffold Server** is in the menu bar. If its **Server** status
  reads **Server · Stopped**, choose **Start Server**. If it reads
  **Server · Not responding**, choose **Restart Server**.
- Open `http://127.0.0.1:5178`, or the port set in **Server Settings...**, on
  the Mac itself.
- **Show Logs** opens the log folder, `~/Library/Logs/Caffold`.

## An agent is missing from New Task

New Task offers only the agents Caffold can reach. Open that agent's Settings
page to see what Caffold found, and compare it with
[Set up your agents](../get-started/agents.md): where the agent has to be
installed, which versions are supported, and how to sign in.

If the agent is installed and signed in but its requests fail,
**Service status** on its Settings page shows whether the provider has an
outage.

## A Task stops responding

- **Codex:** if **Settings → Codex** asks for a restart, choose
  **Restart runtime…**.
- **Claude Code:** choose **Restart runtime** in **Settings → Claude**; see
  [Updates](updates.md#claude-code-and-grok).
- A Task shows a warning instead of its conversation when its agent cannot be
  reached. Choose **Retry** once the agent is available; you can still archive
  the Task in the meantime.

## A Section shows a missing-folder warning

If you moved or renamed the original folder outside Caffold, reconnect
its Section to the folder's current location:

1. Open the Section and review **Previous location**.
2. Under **New location**, browse to the moved folder or type its path.
   This selects a folder on the Mac running Caffold, even from another device.
3. Finish any running Tasks, then choose **Reconnect folder**.

Caffold keeps the Section and Task order. This works with ordinary folders
and Git repositories, with or without worktrees. Deleted worktrees are not
recreated.

If an active Task fails to reconnect, the Section keeps its previous path and
the form names that Task. Earlier successful repairs remain usable. Resolve the
problem and retry with the same selected folder. If you no longer need a broken
worktree's files, Task details can offer
[Discard changes and archive](../tasks/archive-and-delete.md#discard-changes-and-archive).

If you put the original folder back or resolve an access problem, choose
**Check again** to check its original location without reconnecting.

## An archived Task will not restore

Restore keeps the Task in Archived if its folder or repository cannot be found.
If its Section shows a missing-folder warning, reconnect the Section using the
steps above, then try Restore again.

A Task archived with **Discard changes and archive** may not be restorable
when its Git connection was already broken. Its conversation remains in
Archived.

## Another device cannot open Caffold

- Use the private HTTPS address from **Settings → Remote Access**, not
  `127.0.0.1`.
- The device needs Tailscale, signed in to an account permitted on the same
  tailnet.
- If the menu bar shows **Serve port in use**, or **Settings → Remote Access**
  reports a conflict, something else already uses Tailscale Serve's HTTPS port
  on the Mac. Caffold does not replace it; remove that Serve entry in Tailscale
  first.

## Notifications do not arrive

- Notifications are turned on per browser: open **Settings → Notifications** in
  the browser that should receive them.
- On an iPhone or iPad,
  [install Caffold as an app](../get-started/other-devices.md#open-caffold-on-another-device) first.
- The Mac has to be awake and running Caffold when the turn ends.

## The voice button says **Set up voice input**

The chosen voice provider is not ready: its model is not downloaded, or its API
key is not saved. The button opens **Settings → Voice Input**.

## Reporting a problem

**Settings → About Caffold → Copy diagnostics** copies the version and build
details. Include them, with the relevant part of
`~/Library/Logs/Caffold/caffold.log`, in an issue on
[GitHub](https://github.com/panarch/caffold/issues).

If the server stopped responding, also include any diagnostic reports from
`~/Library/Application Support/Caffold/data/diagnostics/stalls`.
