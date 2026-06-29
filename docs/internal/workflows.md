# Workflows

> Internal planning note. These workflows describe intended product behavior before implementation.

Codger workflows should be described from the reviewer's point of view. The reviewer is not trying to edit code on a phone. The reviewer is trying to understand, approve, interrupt, continue, or reject agent work.

## Task Creation

1. Select a project.
2. Create a task with a title and prompt.
3. Choose or create a worktree.
4. Start or attach a Codex thread.
5. Record task creation, worktree binding, and thread binding in the operation ledger.

## Agent Turn

1. User sends a prompt.
2. Backend forwards it through the Codex app-server adapter.
3. App-server emits turn and agent events.
4. Backend streams task state to the UI.
5. Approvals are presented to the user when required.
6. Completion, interruption, or failure is recorded in the ledger.

## Review Loop

1. Open the task.
2. Inspect changed files.
3. Read the unified diff.
4. Open related files from the file browser.
5. Search filenames or code with `rg`.
6. Run a test preset or explicit command.
7. Send a follow-up prompt from the current review context.

## Approval Loop

1. Codex requests permission for an action.
2. Codger displays the requested command, cwd, risk context, and available decision buttons.
3. User accepts, accepts for the session, declines, or cancels.
4. Backend forwards the decision to app-server.
5. Ledger records the decision and resulting state.

## Resume

Resume is a core workflow.

When a user returns after time away, Codger should show:

- task title and status
- host
- project
- worktree path
- branch and base
- Codex thread ID
- recent ledger events
- latest changed file summary
- latest test or command summary

The user should not need to remember which terminal, tab, or GUI state held the work.

## Completion

Task completion does not mean Codger performs a git commit. In the MVP, completion means the reviewer marks the task as reviewed, accepted, rejected, paused, or archived.

Git mutation remains primarily agent-driven or manual until a controlled flow is designed.
