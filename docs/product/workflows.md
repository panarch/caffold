# Product Workflows

This document describes Caffold's implemented product workflow and the object
boundaries that keep it consistent. Planned orchestration belongs in the
[Roadmap](roadmap.md).

Caffold currently supports four entry paths into the same repeated
development loop:

```text
Global New
        -> start a Task and Codex thread in a selected cwd
        -> optionally prepare the same Task in an isolated worktree

Managed Section
        -> inspect Working Tree/Branch, Git, or GitHub at its repository root
        -> start a Task in the fixed directory or from Issue/PR detail

GitHub Issue detail
        -> explicitly start a setup-only Task
        -> prepare an isolated worktree from its selected base ref
        -> wait for the user's next request

GitHub Pull Request detail
        -> explicitly start a setup-only Task
        -> prepare an isolated worktree from the exact PR head
        -> wait for the user's next request

Any entry
        -> work <-> review <-> test
        -> archive or restore the Task and its owned resources
```

Conversation owns Task execution and follow-up work. The common Detail review
surfaces inspect either a repository-backed Task or managed Section. Explicit
worktree preparation plus archive and restore provide the implemented outer
lifecycle.

## Current implemented loop

### Task creation and turns

1. Open Global New or select a managed Section and start a New Task.
2. For Global New, confirm or choose the cwd. Section New uses its managed
   logical path. Choose the model and reasoning effort, then send a prompt.
3. Caffold starts a Codex thread in that cwd and records managed membership.
4. Repository and worktree context are derived live from the thread cwd.
5. Follow-up prompts start or steer a turn from canonical app-server state.
6. Approvals, completion, interruption, and failures remain visible in the
   thread-backed conversation.

### Open an existing Task

1. Selecting a Task uses its detail SSE as the normal snapshot path and keeps
   the loading shell until readable Task and conversation data arrives.
2. Reconnects normally recover through the same stream without clearing a
   readable Detail or adding a parallel full REST read.
3. If the stream is unsupported or exhausts its retries, one REST fallback may
   keep the Task readable while unavailable live updates are reported.
4. Loading older conversation history uses a cursor REST request and merges the
   page into the current Task. Switching Tasks prevents pending work for the
   previous selection from changing the new Detail.

### Start from a GitHub Issue or Pull Request

The common GitHub root owns one shared Task Start dialog rather than separate
Issue and Pull Request workflows. A repository-backed Task or Section supplies
the source repository context. Both detail pages provide only the visible action
and canonical source payload; the dialog keeps one Task-creation and modal
lifecycle while applying the appropriate source-specific setup.

For an Issue:

1. Open Issue detail from a Task or Section GitHub surface and choose
   `Start Task`.
2. Select a base ref and the new Task's model, reasoning, speed, and approval
   choices.
3. Caffold creates a separate Task at the resolved repository root. Its first
   prompt carries the Issue metadata as untrusted context and is setup-only.
4. That turn renames the Task and calls `isolate_current_task` with the selected
   base ref and `includeChanges: false`.
5. Once the managed worktree is ready, the turn stops. The user reviews the
   prepared Task and sends a new request before analysis or implementation
   begins.

For a Pull Request:

1. Open Pull Request detail and choose the same `Start Task` action; there is no
   separate review-versus-implementation choice or arbitrary base selector.
2. Confirm the read-only base/head repository, ref, and commit relationship and
   choose the new Task's turn options.
3. Caffold resolves and verifies the exact canonical PR head commit.
   Same-repository and fork PRs are supported; a moved or unavailable head
   stops with a recoverable error instead of selecting another ref.
4. Caffold creates a separate Task whose setup-only prompt carries the PR body,
   URL, base/head identity, conversation, and review context as untrusted data.
5. That turn renames the Task, creates a concise local branch from the verified
   head with `includeChanges: false`, and stops as soon as the managed worktree
   is ready.

Neither source automatically continues review or implementation after
preparation. The user decides the prepared Task's next bounded action.

### Review loop

1. Select a repository-backed Task or Section and open Integrated Review.
2. Select Working Tree or Branch scope.
3. Inspect changed files, unified diffs, and source files without changing
   Codex lifecycle state.
4. Open the same subject's Git child for arbitrary Compare or bounded Log, or
   its GitHub child for Issues and Pull Requests.
5. When the subject is a Task, return to Conversation and send a follow-up
   prompt. From a Section, start a fixed-directory or GitHub-derived Task.
6. Run and inspect tests through Codex or a manual development tool.

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
| Origin | Global New, managed Section, or explicit GitHub Issue/PR Start Task. |
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
