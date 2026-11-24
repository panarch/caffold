# Fork a conversation

Forking starts a new Task with the saved history of a Codex, Claude Code, Grok, or GitHub Copilot conversation. The child uses the same agent. Antigravity is not offered.

## Fork a Task

1. Open an idle Task, choose **Task details** at its top right, and choose
   **Fork task**.
2. Choose the folder the new Task starts in. The folder list starts at the
   Task's Section folder and stays open: choose a folder in it, or choose ✎ to
   type a path.
3. Choose **Fork task**. The new Task, named `Fork of …`, opens in that
   folder's Section. A folder without a Section gets a new one, as when you
   start a Task there.

![Task details with Fork task](../assets/screenshots/task-details-light-desktop.png#only-light)
![Task details with Fork task](../assets/screenshots/task-details-dark-desktop.png#only-dark)

![Fork task with its folder list](../assets/screenshots/task-fork-light-desktop.png#only-light)
![Fork task with its folder list](../assets/screenshots/task-fork-dark-desktop.png#only-dark)

The second line of the dialog says what the new Task will not have; see
[What a fork copies](#what-a-fork-copies).

## Fork a conversation from outside Caffold

1. Select a Section to open it.
2. Under **Existing conversations**, choose **Fork conversation**.
3. Select the source agent. Enter its Thread ID (Codex) or Session ID
   (Claude, Grok, or GitHub Copilot). Codex also accepts a `codex://threads/…` link.
4. Choose **Preview conversation** and check the source name, status, working
   directory, and recent messages. Changing the agent or ID clears the preview.
5. Choose **Fork task**.

![Conversation fork preview](../assets/screenshots/conversation-fork-light-desktop.png#only-light)
![Conversation fork preview](../assets/screenshots/conversation-fork-dark-desktop.png#only-dark)

The child starts in the Section's directory. Preview reads the source without
resuming it or adding it to the Task list. A known active conversation cannot
be forked. **Live status unavailable** means Caffold can read saved history but
cannot confirm the external session's live status; it does not mean idle.
Caffold cannot prevent another external client from changing that source.

For GitHub Copilot, enter the CLI session ID. If a Caffold Task owns that session, the preview shows its current status and working directory. **Fork task** in Task details looks up the session ID for you.

For Grok, use the native Session ID when entering an external source. A Task
that has moved to a worktree can run on a different native session than its
original Task ID. **Fork task** resolves the Task's current session for you.

## What a fork copies

The agent copies its own conversation history. Files, uncommitted changes,
branches, and worktrees are not copied; the child can
[move into a worktree](worktrees.md) like any other Task. A Task that works
in its own worktree keeps it, so a child forked from it starts in the folder
you chose without that worktree's changes. The source remains independent.

If the child was created but could not be opened, retry opening that child.
If the connection failed before a creation result arrived, check the Task list
before submitting another fork. While a fork runs, its dialog stays open.
