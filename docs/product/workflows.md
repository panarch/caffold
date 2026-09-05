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
        -> preview an existing Codex Thread ID and fork its conversation here

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
4. Caffold starts the chosen agent's empty conversation in that cwd, durably
   records the Task's managed membership, agent, and current composer settings,
   and answers with the usable zero-turn Task. Creation does not wait for agent
   output.
5. The browser opens that Task immediately and transfers its retained text,
   attachments, and turn options into the Task Composer. The message then uses
   the ordinary prompt request, adapter handoff, exact accepted-message
   identity, reconciliation, and error behavior used by later messages.
6. A definitive prompt rejection removes the optimistic message and restores
   the retained Composer in the valid empty Task. A transport failure whose
   outcome is unknown remains visibly unconfirmed and is not replayed
   automatically. A backend replacement before submission therefore leaves an
   honest empty Task rather than an inferred or hidden first-turn state.
7. Near the end of the first turn, the agent is instructed to replace the
   initial display name with a concise name based on the understood goal.
   Each agent receives the `rename_current_task` base operation through its
   native MCP integration. This remains model-followed behavior rather than a
   completion gate.
8. Repository and worktree context is derived from the Task's current cwd.
9. Every prompt, including the first, starts a new turn or steers an active one
   through the same agent. The Task cannot switch agents in place.
10. Approvals, completion, interruption, and failures remain visible in the
   agent-owned conversation projected into Caffold.

### Fork a Codex conversation

Both entry points use the same native conversation-fork lifecycle:

1. From an idle managed Codex Task, choose **Fork task**. Its provider and
   Thread ID are already known.
2. From a managed Section, choose **Fork from Codex thread ID**, enter an ID,
   and explicitly request a preview. Caffold uses read-only app-server APIs for
   metadata and recent history. It does not resume the source or add it to
   managed Tasks.
3. Review the provider-reported source status and context. An external
   `notLoaded` source displays **Live status unavailable** without being
   presented as idle, but its persisted history can still be forked. Active,
   system-error, unrecognized, unresolved, and provider-mismatched sources
   cannot be forked.
4. Choose **Fork task**. The backend resolves the target Section again, reads
   the source again, and requires a managed source to be idle or an external
   source to be idle or not loaded before asking Codex to fork it.
5. Only the child ID returned by Codex is claimed as a managed Task. Its initial
   cwd is the selected Section project root, its initial name is `Fork of ...`,
   and the browser opens it immediately.

The source conversation remains unchanged. Caffold neither imports the source
nor persists a conversation lineage. Conversation history belongs to Codex and
is inherited by the native child. Files, uncommitted changes, branches, and
worktrees are not copied or created; the child can later use the ordinary
explicit worktree-isolation operation. A failure before the managed claim
creates no Task, and a failure after Codex creates a child deletes that
unclaimed child.

### Open an existing Task

1. Selecting a Task immediately keeps its stable header identity from the
   Caffold-owned Active-list row while readable conversation data loads.
2. Caffold opens the conversation through the Task's recorded agent. Codex
   reads its app-server thread; Claude reads its transcript and overlays any
   live runner-held session state.
3. Reconnecting preserves an already readable Detail while Caffold recovers
   current data. If live updates remain unavailable, the Detail reports that
   state without discarding readable content.
4. If canonical Detail cannot be read, the header keeps only the matching
   managed Task identity, the body reports the provider failure, and Retry and
   Archive remain available. Caffold does not infer conversation content,
   status, or repository context from that row.
5. Loading older history prepends it to the current conversation.
6. Switching Tasks prevents pending work for the previous selection from
   changing the new Detail.

### Current plan documents

A Task may keep a provider-neutral current plan in two ordinary Markdown files
relative to its effective working directory:

```text
.caffold/plans/current/PLAN.md
.caffold/plans/current/CHECKLIST.md
```

The convention is optional for a Task, but a current plan is valid only when
both exact files exist and can be read safely. `PLAN.md` is free-form Markdown;
its first H1, when present, is the display title. `CHECKLIST.md` is also
free-form Markdown. Every GFM task-list marker anywhere in that document counts
toward the completed and total values, regardless of headings, nesting, or
section layout. Zero task-list items and an entirely checked list are both
valid. Neither condition ends, resolves, or archives the plan.

The filesystem is the source of truth. Caffold does not copy plan content or
progress into its database and does not use an agent's native Plan mode as a
second ledger. The pair remains current for as long as both files remain at
the exact paths. An agent or user may move or delete both files when they are
no longer current; Caffold never performs that lifecycle step automatically.
No frontmatter, schema, format version, identifier, date, or stage structure is
required.

When the pair is readable, Task Detail floats a compact two-part progress
control above the follow-up Composer without changing the Composer's position.
The Plan title opens `PLAN.md`; the completed/total value opens `CHECKLIST.md`.
Both use the shared read-only Markdown dialog, and checkboxes are presentation
only. Conversation keeps the same bottom breathing room whether or not a plan
exists, so a missing pair leaves no placeholder and does not reposition the
Composer. A partial or unreadable pair shows a non-blocking problem instead of
guessed progress. Planning questions and design decisions continue through
ordinary natural-language Composer conversation; Caffold does not add a
structured clarification form or a Plan/default mode selector.

This convention does not prescribe Git policy. Caffold neither edits
`.gitignore` nor requires `.caffold` to be tracked, and ignored files remain
readable through Files and the current-plan surface. Ignored or untracked plan
documents can disappear with their containing directory or worktree, so users
who need durable history choose their own tracking, backup, or move policy.
Directories such as `docs/` or `resolved/`, including numerically prefixed
history names, are optional organization conventions only. Caffold does not
parse, validate, or index them and provides no resolved-plan list; they remain
ordinary files in Files.

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

- Archiving a Task moves its Caffold-owned membership out of the active
  navigator and retains its local metadata. Caffold also asks the recorded
  agent to archive or close the conversation, but provider acquisition, read,
  or archive failure does not strand the local Task in Active.
- A clean Caffold-managed worktree is removed during archive; its branch and
  ownership record remain available for restore.
- Dirty managed worktrees and a successfully read current Active status block
  archive. An unavailable provider is not presented as idle; it leaves the
  provider state unknown while the explicit local Archive proceeds.
- The archived Task remains visible from its durable row when its provider is
  unavailable. Restore is withheld until the provider can confirm that the
  conversation exists; permanent deletion remains available.
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
| Origin | Global New, managed Section, explicit GitHub Issue/PR Start Task, or a native fork of an existing Codex conversation. |
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
