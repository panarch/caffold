# Product Workflows

This document describes Caffold's implemented product workflow and the object
boundaries that keep it consistent. Planned orchestration belongs in the
[Roadmap](roadmap.md).

Caffold currently supports this repeated development loop:

```text
Ad-hoc request
        -> start a Task and Codex thread in a selected cwd
        -> optionally prepare the same Task in an isolated worktree
        -> work <-> review <-> test
        -> archive or restore the Task and its owned resources
```

Conversation and integrated Review form the inner loop. Explicit worktree
preparation plus archive and restore provide the implemented outer lifecycle.

## Current implemented loop

### Task creation and turns

1. Open Tasks and start a New Task.
2. Confirm or choose the cwd, model, and reasoning effort, then send a prompt.
3. Caffold starts a Codex thread in that cwd and records managed membership.
4. Repository and worktree context are derived live from the thread cwd.
5. Follow-up prompts start or steer a turn from canonical app-server state.
6. Approvals, completion, interruption, and failures remain visible in the
   thread-backed conversation.

### Review loop

1. Open the Task's integrated Review workspace.
2. Select Working Tree or Branch scope.
3. Inspect changed files, unified diffs, source files, repository status, and
   Git log without changing Codex lifecycle state.
4. Return to Conversation and send a follow-up prompt.
5. Run and inspect tests through Codex or a manual development tool.

### Same-Task isolation preparation

An eligible Task can ask Codex to prepare an isolated worktree through
`isolate_current_task`. The operation moves the same Task and thread; it does not
create a child Task. It ends its setup turn after preparation and waits for the
user's next request.

By default, current staged, unstaged, and untracked changes remain in the source
checkout. They move only when the user explicitly requests `includeChanges`.
Branch handoff, dirty transfer recovery, ownership, archive, and restore follow
the [managed worktree lifecycle](../architecture/worktree-lifecycle.md).

### Archive and restore

- Archiving a Task removes it from the active navigator while retaining its
  thread and Caffold-owned metadata.
- A clean Caffold-managed worktree is removed during archive; its branch and
  ownership record remain available for restore.
- Dirty managed worktrees and active turns block archive.
- Restoring recreates an archived managed worktree from its retained branch and
  returns the same Task to the active navigator.
- Tasks without a managed-worktree ownership record retain their cwd and files.

Archive and filesystem cleanup are coordinated but distinct state changes. An
external worktree is never deleted merely because a Task uses it.

## Product object boundary

Use **work session** only as a planning term for one user job. No durable
work-session schema or product name has been accepted. The term connects these
independent objects:

| Object | Role and owner |
| --- | --- |
| Origin | Ad-hoc request, GitHub Issue, or GitHub PR. |
| Repository | Git repository in which the job is evaluated. |
| Worktree | Git-owned execution and inspection environment. |
| Codex thread | App-server-owned conversation and execution history. |
| Task membership | Caffold-owned link that exposes a thread in the product. |
| Review state | Browser/component selection, position, and presentation state. |
| Remote state | GitHub-owned Issue, PR, branch, check, and comment state. |

Neither a worktree nor a Codex thread is the whole user job. Avoid adding one
synthetic persisted status that overwrites the independent owners.

## Runtime boundary

Caffold intentionally uses one runtime owner in this product phase:

```text
one Caffold backend
  -> one disposable proxy connection
       -> one persistent Codex app-server daemon
            -> multiple threads in multiple repositories/worktrees
```

A worktree does not receive its own app-server. Thread cwd connects the thread
to the appropriate checkout. Managed and external app-server modes remain
exclusive process-startup choices, not Issue, PR, or worktree UX.
