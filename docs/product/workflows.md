# Product Workflows

This document describes Caffold's implemented product workflow and the object
boundaries that keep it consistent. Planned orchestration belongs in the
[Roadmap](roadmap.md).

Caffold supports three entry paths into the same repeated development loop:

```text
Global New
        -> choose a cwd and a Codex or Claude model
        -> start a Task with that agent
        -> optionally prepare the same Task in an isolated worktree

Managed Section
        -> inspect Working Tree/Branch, Git, or GitHub at its repository root
        -> start an agent Task in the fixed directory or from Issue/PR detail

GitHub Issue or Pull Request detail
        -> explicitly start a source-derived Task with the chosen agent
        -> prepare its isolated worktree
        -> wait for the user's next request

Any entry
        -> work <-> review <-> test
        -> archive, restore, or permanently delete the Task and its owned resources
```

Conversation owns Task execution and follow-up work. The common Detail review
surfaces inspect either a repository-backed Task or managed Section. Explicit
worktree preparation plus archive, restore, and permanent deletion provide the
implemented outer lifecycle.

## Current implemented loop

### Task creation and turns

1. Open Global New or select a managed Section and start a New Task.
2. For Global New, confirm or choose the cwd. Section New uses its managed
   logical path.
3. Choose a model. Each offered model identifies its agent, so this choice also
   binds the new Task to Codex or Claude. Choose the available effort, speed,
   and permission mode, then send a prompt.
4. Caffold starts the chosen agent's conversation in that cwd and records the
   Task's managed membership, agent, and current composer settings.
5. Near the end of the first turn, the agent is instructed to replace the
   initial display name with a concise name based on the understood goal.
   Codex receives a dynamic tool and Claude receives the equivalent
   Caffold-served MCP tool. This remains model-followed behavior rather than a
   completion gate.
6. Repository and worktree context is derived from the Task's current cwd.
7. Follow-up prompts start a new turn or steer an active one through the same
   agent. The Task cannot switch agents in place.
8. Approvals, completion, interruption, and failures remain visible in the
   agent-owned conversation projected into Caffold.

### Open an existing Task

1. Selecting a Task keeps the loading shell until readable Task and
   conversation data arrives.
2. Caffold opens the conversation through the Task's recorded agent. Codex
   reads its app-server thread; Claude reads its transcript and overlays any
   live runner-held session state.
3. Reconnecting preserves an already readable Detail while Caffold recovers
   current data. If live updates remain unavailable, the Detail reports that
   state without discarding readable content.
4. Loading older history prepends it to the current conversation.
5. Switching Tasks prevents pending work for the previous selection from
   changing the new Detail.

### Start from a GitHub Issue or Pull Request

Issue and Pull Request detail expose the same `Start Task` action from a
repository-backed Task or Section. Each creates a separate setup-only Task and
stops after worktree preparation.

For an Issue:

1. Choose a base ref and a Codex or Claude model.
2. Caffold creates a Task at the repository root.
3. The setup prompt treats the Issue body and URL as untrusted context, renames
   the Task, creates a concise branch from the selected base with
   `includeChanges: false`, and prepares the managed worktree.

For a Pull Request:

1. Confirm the read-only base/head identity and choose a model.
2. Caffold creates a Task at the repository root.
3. The setup prompt treats the PR body, URL, base/head identity, conversation,
   and review context as untrusted data.
4. The Task renames itself and prepares a concise local branch from the
   verified head with `includeChanges: false`.

The setup instruction names the tools through the chosen agent's native
extension point. The resulting Git worktree lifecycle is the same. The user
decides the prepared Task's next bounded action.

### Review loop

1. Select a repository-backed Task or Section and open Integrated Review.
2. Select Working Tree or Branch scope.
3. Inspect changed files, unified diffs, and source files without changing the
   agent conversation or runtime state.
4. Open the same subject's Git child for arbitrary Compare or bounded Log, or
   its GitHub child for Issues and Pull Requests.
5. When the subject is a Task, return to Conversation and send the selected
   agent a follow-up prompt. From a Section, start a fixed-directory or
   GitHub-derived Task.
6. Run and inspect tests through the Task's agent or a manual development tool.

### Same-Task isolation preparation

An eligible Task can ask its agent to prepare an isolated worktree through
`isolate_current_task`. The operation moves the same Task and conversation; it
does not create a child Task. It ends its setup turn after preparation and
waits for the user's next request.

By default, current staged, unstaged, and untracked changes remain in the
source checkout. They move only when the user explicitly requests
`includeChanges`. Branch handoff, dirty transfer recovery, provider-specific
cwd movement, ownership, archive, and restore follow the
[managed worktree lifecycle](../architecture/worktree-lifecycle.md).

### Archive and restore

- Archiving a Task removes it from the active navigator while retaining its
  agent conversation and Caffold-owned metadata.
- A clean Caffold-managed worktree is removed during archive; its branch and
  ownership record remain available for restore.
- Dirty managed worktrees and active turns block archive.
- Restoring recreates an archived managed worktree from its retained branch and
  returns the same Task to the active navigator.
- Tasks without a managed-worktree ownership record retain their cwd and files.
- Permanent deletion is available only after archive. It removes the
  agent-owned conversation through that Task's driver — the Codex thread or the
  Claude transcript and its same-session files — then removes Caffold's Task
  and worktree-ownership records. It does not delete the retained Git branch.

Archive and filesystem cleanup are coordinated but distinct state changes. An
external worktree is never deleted merely because a Task uses it.

## Product object boundary

Use **work session** only as a planning term for one user job. No durable
work-session schema or product name has been accepted. The term connects these
independent objects:

| Object | Role and owner |
| --- | --- |
| Origin | Global New, managed Section, or explicit GitHub Issue/PR Start Task. |
| Task | Caffold-owned membership, display identity, selected agent, and review entry point. |
| Agent conversation | Codex app-server thread or Claude session/transcript that owns prompts, turns, and agent activity. |
| Repository | Git repository in which the job is evaluated. |
| Worktree | Git-owned execution and inspection environment. |
| Review state | Browser/component selection, position, and presentation state. |
| Remote state | GitHub-owned Issue, PR, branch, check, and comment state. |

Neither a worktree nor an agent conversation is the whole user job. Avoid
adding one synthetic persisted status that overwrites the independent owners.

## Runtime boundary

All Tasks on one host share the Caffold backend, but they do not share one
synthetic agent runtime. Codex Tasks use the user-global Codex app-server
daemon. Claude Tasks use one Caffold runner per data directory and one `claude`
process per live session. Preparing a worktree changes the Task's cwd; it does
not create another agent service.

See [Agent runtimes](../architecture/agent-runtimes.md),
[Architecture Overview](../architecture/overview.md), and
[Codex App Server](../architecture/codex-app-server.md) for detailed transport
and state ownership.
