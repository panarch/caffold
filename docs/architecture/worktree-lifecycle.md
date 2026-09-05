# Managed Worktree Lifecycle

Caffold can move the current Task into an isolated Git worktree. The lifecycle
is deliberately limited to worktrees created by Caffold; existing user
worktrees are never adopted or removed.

## Ownership Boundary

- A managed worktree has one stable UUID, one repository common Git directory,
  one UUID-derived owned path, and one bound Task conversation.
- Its filesystem path is `<managed-root>/<worktree-id>` and does not change when
  a Task or branch is renamed.
- While the record is `ready`, the user may switch the owned worktree between
  named local branches. The live checkout is presentation state, not persisted
  ownership identity.
- The default managed root is `<data-dir>/worktrees`. `caffold serve
  --worktree-root PATH` can select another directory, but that directory is
  treated as exclusively owned by Caffold and must be inside the configured
  browsing root.
- Ownership is recorded in the `managed_worktrees` table. A path alone is never
  sufficient proof that Caffold may remove it.
- Tasks without a managed-worktree record retain their existing cwd and files
  when archived.

## Isolation Preparation

The `isolate_current_task` tool is available only inside a Task already managed
by Caffold. Codex receives Caffold's HTTP MCP server on thread start and resume;
Caffold also answers calls from dynamic tool definitions already persisted on
pre-MCP threads. Claude receives the `mcp__caffold__isolate_current_task` tool
from its in-process MCP server.
It is an explicit preparation operation, intended for requests such as
"prepare a worktree for this PR review". It does not start a child Task and
does not automatically continue the review or other work.

The tool must be the final file-affecting action of its turn. After it succeeds,
that turn ends. The user's next request starts a new turn in the same agent
conversation with the managed worktree as `cwd` and runtime workspace root.

For Codex, either compatible delivery path moves the thread's workspace for the
next turn. Supplying MCP config while resuming a managed thread does not adopt
or expose an unmanaged app-server thread as a Caffold Task. The detailed tool
delivery and binding contract belongs to
[Codex App Server](codex-app-server.md#thread-subscription-lifecycle).

A Claude Task reaches the same state by moving rather than by per-turn `cwd`:
the agent only changes directory between turns, so the session is moved into
the worktree the moment the isolating turn ends, and every later opening of the
Task starts its session in the worktree directly. The agent keeps its
transcript where its session runs, and the CLI relocates the file with the
move, so a Task that has a worktree record — whatever state that record is in —
is read, resumed, and erased at the worktree's path.

The branch behavior follows the source checkout:

- a clean current non-default branch is handed off literally to the managed
  worktree; the original checkout is detached briefly and then switched to the
  local default branch on a best-effort basis;
- a dirty current non-default branch is rejected by the default clean-isolation
  path because Git cannot check out that same branch in two worktrees;
- a current default branch or detached HEAD produces a new branch named
  `caffold/<task-slug>-<short-id>`, unless an explicit new branch name is
  requested;
- a requested rename of a current non-default branch is rejected;
- an existing linked worktree is rejected rather than adopted.

By default, staged, unstaged, and untracked state remains in the source
checkout, and a default-branch or detached source is not switched. The tool's
`includeChanges` argument defaults to `false` and is set to `true` only when the
user explicitly asks to move current or uncommitted changes. In that opt-in
mode, supported dirty state moves with the Task while ignored files and build
artifacts remain in the source checkout. Caffold rejects unresolved Git
operations and dirty submodule or nested-repository state because Git stash
cannot safely represent those cases.

Claude declares Caffold's MCP server on every hello, so a Claude Task serves
the tool on resumed and re-attached sessions as well.

## Dirty-State Transfer And Recovery

Only when `includeChanges` is `true`, Caffold creates a uniquely marked `git stash
--include-untracked` snapshot and anchors its commit at
`refs/caffold/transfers/<worktree-id>`. The normal stash entry may then be
dropped. The snapshot is applied in the target with `--index`, preserving the
staged/unstaged distinction, and the protected ref is deleted only after the
owned record reaches `ready`.

The existing `managed_worktrees` record is the recovery anchor; no separate
operation ledger is used. Its persisted state distinguishes clean branch
creation, clean branch handoff, and dirty-state transfer before Git mutation.
`anchor_branch` and `anchor_head_sha` are a paired checkout anchor: both are
present in every non-ready operation or recovery state, including legacy
`creating` recovery, and both are null in `ready`. Partial pairs and states with
the wrong anchor presence are invalid.
Interrupted operations are recovered at startup using the matching mode; clean
recovery never creates or applies a stash snapshot. Dirty transfers additionally
use the unique stash marker and protected ref.

If the owned target does not exist, Caffold can recreate it and reapply the
protected snapshot. An existing dirty target is never reset automatically,
because Caffold cannot prove that every change came from the interrupted
transfer. Startup instead continues with the record in `recovery_required`;
prompts are blocked with an actionable error and the source, target, and
protected ref are retained.

## Archive And Restore

Archive coordinates the selected agent's conversation, Task membership, and
managed worktree:

- a successfully read current Active agent status blocks archive;
- a dirty managed worktree blocks archive with
  `managed_worktree_dirty`;
- managed-worktree preflight completes before any provider archive attempt;
- provider acquisition, description, and archive are best effort, so an
  unavailable provider does not bypass local safety and does not strand the
  Caffold-owned Task in Active;
- archive inspects the actual named branch and HEAD, then atomically records
  them as the checkout anchor while transitioning from `ready` to `removing`;
- a clean managed worktree is removed from disk without `--force`;
- its local branch and ownership record are retained;
- the record transitions from `ready` through `removing` to `archived`.

Restore recreates the same UUID path from the branch recorded when archive
began before the conversation and Task return to the active list. The record
transitions through `restoring` back to `ready`, where the checkout anchor is
cleared again.

Permanent deletion is available only after archive. The archived managed
worktree path is already absent, so deletion removes only Caffold's ownership
record. The local branch remains in the repository and no external worktree or
Git ref is removed.

If a later coordinated step fails, Caffold attempts the inverse worktree
transition. It reverses the provider archive only when that provider operation
actually succeeded in the same request, so a failed or unattempted provider
operation is never treated as state that must be undone. This keeps the visible
Task state and filesystem state aligned without guessing provider state.
Interrupted transfer, `removing`, and `restoring` states are reconciled on
startup from the ownership record and actual filesystem state. A mismatched or
otherwise unsafe target remains in its persisted non-ready state without
preventing unrelated Tasks or the Caffold server from starting.

## Coordination And Recovery Limits

Coordination across Git, the selected agent runtime, and the Caffold task store
is not an atomic transaction. Caffold protects user changes, but clean orphan
branches, worktrees, transfer refs, or a temporarily detached source checkout
can remain after a failed best-effort cleanup. The lifecycle does not provide
exactly-once execution, full rollback, automatic orphan collection, or
automatic continuation of the original request.

Automatic Issue/PR recognition, isolation preparation, and request continuation
are scenario orchestration outside this lifecycle.

## Safety Invariants

- No operation removes a path outside the canonical managed root.
- The record ID must be a UUID and its recorded path must exactly equal the
  UUID-derived owned path.
- Repository common Git directory is always verified. Operation and recovery
  states also retain and verify their persisted branch identity before Git
  mutation; transfer recovery additionally uses the anchored HEAD.
- Dirty ready worktrees are never removed by archive. Recovery never resets an
  existing dirty target automatically; the exact dirty snapshot remains
  protected by its transfer ref for manual recovery. Clean isolation recovery
  likewise never resets a dirty target.
- A `ready` record accepts its live named branch after verifying the owned path,
  symlink boundary, repository common directory, and attached HEAD. Task detail,
  prompt, restart reconciliation, and serialization reads do not persist the
  observed branch or HEAD.
- A detached `ready` worktree, repository mismatch, unowned path, or symlinked
  owned slot fails closed.
- Normal archive preserves the branch that was live when archive began.
- Caffold never manages or deletes an external worktree merely because a Task
  uses it as cwd.
