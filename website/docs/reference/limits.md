# Limits

These are the things Caffold does not do. Much of that work can still be done
by [asking the agent](../get-started/how-caffold-works.md#ask-the-agent-to-make-changes).
The [roadmap](https://github.com/panarch/caffold/blob/main/docs/product/roadmap.md)
lists what is planned.

- **One person, one Mac.** Caffold has no sign-in and is not for the public
  internet; see [Who can use Caffold](data-and-privacy.md#who-can-use-caffold).
  It runs only on Apple silicon Macs with macOS 14 or later.
- **Three built-in agents.** Caffold works with Codex, Claude Code, and Grok and
  cannot load other agents. A Task cannot switch agents, and a feature one
  agent offers may not exist in another; forking, for example, is Codex only.
- **No terminal or code editor.** Ask the agent to run commands or change
  files; command output appears in the conversation.
- **Read-only Git and GitHub.** Ask the agent to commit or push; see
  [Git](../review/git.md#what-git-does-not-do).
- **No editing of plans or Notes in Caffold.** Ask the agent to change them.
- **Plain diffs.** Diffs are unified text, without a split view, syntax
  highlighting, or review comments.
- **Worktrees only on request.** Ask the agent; see
  [Worktrees](../tasks/worktrees.md).
- **No notification retries.** See
  [Notifications](../get-started/notifications.md#delivery).
