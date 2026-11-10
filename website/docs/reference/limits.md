# Limits

These are the things Caffold does not do. Much of that work can still be done
by [asking the agent](../get-started/how-caffold-works.md#ask-the-agent-to-make-changes).
The [roadmap](https://github.com/panarch/caffold/blob/main/docs/product/roadmap.md)
lists what is planned.

- **One person, one host.** Caffold has no sign-in and is not for the public
  internet; see [Who can use Caffold](data-and-privacy.md#who-can-use-caffold).
  It runs on Apple silicon Macs with macOS 14 or later, and on x86_64 and
  aarch64 Linux with glibc 2.28 or later and systemd.
- **Four built-in agents.** Caffold works with Codex, Claude Code, Grok, and
  Antigravity, and cannot load other agents. A Task keeps its agent for its
  whole life;
  [continuing with another agent](../tasks/worktrees.md#continue-with-another-agent)
  starts a new Task on the same files. Not every feature exists for every
  agent: Antigravity cannot be [forked](../tasks/fork.md), and it takes no new
  prompt while a permission request waits; see
  [Steer and stop](../tasks/steer-and-stop.md#steer-a-running-turn).
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
