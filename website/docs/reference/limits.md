# Limits

These are the things Caffold does not do. Much of that work can still be done
by [asking the agent](../get-started/how-caffold-works.md#ask-the-agent-to-make-changes).
The [roadmap](https://github.com/panarch/caffold/blob/main/docs/product/roadmap.md)
lists what is planned.

- **One person, one host.** Caffold has no sign-in and is not for the public
  internet; see [Who can use Caffold](data-and-privacy.md#who-can-use-caffold).
  It runs on Apple silicon Macs with macOS 14 or later, and on x86_64 and
  aarch64 Linux with glibc 2.28 or later and systemd.
- **Four built-in agents.** Caffold works with Codex, Claude Code, Grok, and Antigravity and
  cannot load other agents. Each Task keeps its agent;
  [Continue with another agent](../tasks/worktrees.md#continue-with-another-agent)
  opens a separate Task at the same files. A feature one
  agent offers may not exist in another; forking supports Codex, Claude, and Grok; Antigravity is excluded.
  Antigravity requires a pending permission to be answered or the turn stopped before another prompt.
- **No code editor, and one terminal per Task.** Ask the agent to change
  files, or edit them in the [terminal](../tasks/terminal.md). A terminal
  appears in place of the conversation, not beside it, and closes when the
  Caffold server stops.
- **Read-only Git and GitHub.** Ask the agent to commit or push; see
  [Git](../review/git.md#what-git-does-not-do).
- **No editing of plans or Notes in Caffold.** Ask the agent to change them.
- **Unified diffs.** Diffs are unified text, without a split view or review
  comments. Pull Request diffs have no syntax colors, and neither do files in a
  language Caffold does not recognize, files with very long lines such as
  minified code, or diffs of very large files.
- **Worktrees only on request.** Ask the agent; see
  [Worktrees](../tasks/worktrees.md).
- **No notification retries.** See
  [Notifications](../get-started/notifications.md#delivery).
