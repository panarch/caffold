# Product Workflows

> Internal product and implementation boundary. Sections explicitly distinguish
> current behavior from planned orchestration.

Caffold is the review and control surface around a repeated development loop:

```text
Ad-hoc request | GitHub Issue | GitHub PR
        -> prepare repository, Task, thread, and optional worktree
        -> work <-> review <-> test
        -> sync or publish for that scenario
        -> complete, abandon, or finish review
        -> archive the Task and safely clean up owned resources
```

Conversation and integrated Review are the inner loop. Prepare, scenario-aware
Sync, Close, and cleanup form the outer loop. Caffold currently implements the
inner loop and the explicit worktree/archive portions of the outer loop.

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
the [managed worktree lifecycle](worktree-lifecycle.md).

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

## Planned scenario orchestration

The following flows describe product direction, not automatic behavior. Users
can prepare them through ordinary prompts and the available GitHub, Codex, Git,
and worktree capabilities.

### Implement a GitHub Issue

```text
Open Issue without allocating a worktree
-> explicitly Start Work
-> choose base and prepare branch/worktree
-> continue the same Task with Issue context
-> work <-> review <-> test
-> commit/push and create or link a PR
-> respond to feedback
-> merge or close
-> archive
```

Opening an Issue must not allocate resources. Preparation starts only after an
explicit transition from inspection to work.

### Review someone else's PR

```text
Open PR summary, checks, and changed files
-> explicitly Review in Worktree
-> prepare an isolated worktree at the PR head
-> review <-> optional Codex analysis/test
-> detect a changed remote head without replacing the current diff
-> explicitly Sync
-> finish or dismiss the review
-> archive and clean up the disposable owned worktree
```

Remote update detection and application are separate actions. A remote head
must not silently replace content under active review.

### Continue an owned PR

```text
Open linked PR
-> reuse its implementation worktree
-> inspect comments, checks, and base movement
-> ask Codex for a follow-up or edit manually
-> review the new delta
-> commit/push
-> repeat until merged
-> archive
```

This is not the same Sync operation as refreshing a disposable review worktree.

### Adopt existing local work

```text
Start a Task in an existing checkout or linked worktree
-> work <-> review
-> optionally move the same Task into a new Caffold-managed worktree
-> archive
```

Existing external worktrees are usable as Task cwd but are not adopted into
Caffold cleanup ownership. Caffold-managed and external provenance must remain
distinguishable.

## Independent state axes

Outer workflow state must not synthesize Codex thread lifecycle:

| Axis | Example states |
| --- | --- |
| Work session planning | preparing, active, waiting, completed, abandoned, archived |
| Managed worktree | absent, transferring, ready, dirty, removing, archived, recovery required |
| Remote | current, update available, ahead, behind, diverged, closed, merged |
| Codex thread | canonical `ThreadStatus`, active flags, and turn state |
| Transport/UI | loading, reconnecting, request failed, watch unavailable |

Codex lifecycle remains app-server-owned. Worktree, remote, transport, and UI
state may disable or annotate controls but cannot rewrite it.

## Sync is scenario-specific

`Sync` is a user intention, not one universal Git command:

- PR review: fetch and move a disposable review worktree to a newer PR head.
- Issue implementation: reconcile the work branch with its chosen base.
- Owned PR follow-up: reconcile base movement, local commits, and the published
  branch without discarding user work.

Every Sync action must preview its intended operation, protect dirty state, and
avoid silently changing the active review.

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

## Next workflow decision

Close the review flow for someone else's PR first because it exercises the
shared outer-loop substrate with limited mutation:

1. identify repository and remote PR;
2. discover or prepare the review worktree;
3. attach Review and optional Codex work;
4. detect a changed PR head;
5. sync without losing review position or local changes;
6. finish review;
7. archive and safely clean up.

Automatic issue/PR recognition, isolation bootstrap, and continuation of the
original request remain later orchestration. `isolate_current_task` itself stays
a setup-only, explicit operation.
