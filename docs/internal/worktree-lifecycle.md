# Managed Worktree Lifecycle

Caffold can move the current Task into an isolated Git worktree. The lifecycle
is deliberately limited to worktrees created by Caffold; existing user
worktrees are never adopted or removed.

## Ownership Boundary

- A managed worktree has one stable UUID, one local branch, and at most one
  Codex thread.
- Its filesystem path is `<managed-root>/<worktree-id>` and does not change when
  a Task or branch is renamed.
- The default managed root is `<data-dir>/worktrees`. `caffold serve
  --worktree-root PATH` can select another directory, but that directory is
  treated as exclusively owned by Caffold and must be inside the configured
  browsing root.
- Ownership is recorded in the `managed_worktrees` table. A path alone is never
  sufficient proof that Caffold may remove it.
- Tasks without a managed-worktree record keep the legacy archive behavior:
  their existing cwd and files are retained.

## Isolation Preparation

The `isolate_current_task` Codex dynamic tool is available only inside a Task
already managed by Caffold. It is an explicit preparation operation, intended
for requests such as "prepare a worktree for this PR review". It does not start
a child Task and does not automatically continue the review or other work.

The tool must be the final file-affecting action of its turn. After it succeeds,
that turn ends. The user's next request starts a new turn on the same Codex
thread with the managed worktree as `cwd` and runtime workspace root.

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

Codex currently accepts Caffold's dynamic tools only on `thread/start`. A Task
whose thread predates `isolate_current_task` does not acquire the tool merely by
being resumed or forked; newly started threads receive it.

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

Archive coordinates the Codex thread, Task membership, and managed worktree:

- an active Codex turn still blocks archive;
- a dirty managed worktree blocks archive with
  `managed_worktree_dirty`;
- a clean managed worktree is removed from disk without `--force`;
- its local branch and ownership record are retained;
- the record transitions from `ready` through `removing` to `archived`.

Restore recreates the same UUID path from the retained local branch before the
Codex thread and Task return to the active list. The record transitions through
`restoring` back to `ready`.

If a later coordinated step fails, Caffold attempts the inverse worktree and
Codex transition so the visible Task state and filesystem state remain aligned.
Interrupted transfer, `removing`, and `restoring` states are reconciled on
startup from the ownership record and actual filesystem state. A mismatched or
otherwise unsafe target remains in its persisted non-ready state without
preventing unrelated Tasks or the Caffold server from starting.

## Deliberate First-Release Limitation

Coordination across Git, the Codex app-server, and the Caffold task store is not
an atomic transaction in the first same-thread isolation implementation.
Caffold protects user changes, but clean orphan branches, worktrees, transfer
refs, or a temporarily detached source checkout can remain after a failed
best-effort cleanup. This release does not claim exactly-once execution, full
rollback, automatic orphan collection, or automatic continuation of the
original request.

A later bootstrap orchestration may recognize a new issue/PR task, request
isolation preparation, and continue it automatically. That orchestration is
explicitly outside this lifecycle.

## Safety Invariants

- No operation removes a path outside the canonical managed root.
- The record ID must be a UUID and its recorded path must exactly equal the
  UUID-derived owned path.
- Repository common Git directory and branch identity are verified before
  removal.
- Dirty ready worktrees are never removed by archive. Recovery never resets an
  existing dirty target automatically; the exact dirty snapshot remains
  protected by its transfer ref for manual recovery. Clean isolation recovery
  likewise never resets a dirty target.
- A `ready` record is verified against the live Git common directory and branch
  before its path is projected into Task detail or used for a new prompt.
- Normal archive preserves the branch; branch deletion is restricted to a
  failed, unbound creation whose HEAD is unchanged.
- Caffold never manages or deletes an external worktree merely because a Task
  uses it as cwd.
