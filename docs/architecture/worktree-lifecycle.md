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
from its in-process MCP server. Grok receives `caffold__isolate_current_task`
from Caffold's HTTP MCP server, declared with a Task-bound header whenever its
session is started or loaded.
It is an explicit preparation operation, intended for requests such as
"prepare a worktree for this PR review". It does not start a child Task and
does not automatically continue the review or other work.

The tool must be the final file-affecting action of its turn. After it succeeds,
that turn ends. The user's next request starts a new turn in the same agent
conversation with the managed worktree as `cwd` and runtime workspace root.
Creating the worktree also closes the Task's [terminal](terminal.md#lifetime),
whose shell was started in the old directory.

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

A Grok session never changes directory. When the isolating turn ends, Caffold
forks the session into the worktree with Grok's own `_x.ai/session/fork`, loads
the copy and checks that it runs at the worktree, re-binds the Task to the copy,
and closes the source session. The Task keeps its identifier, name, Section,
and conversation; the record it reads from then on is the copy's, which carries
the same events. A move that stops short — a fork refused or unanswered twice,
a copy that could not be loaded or runs elsewhere — leaves the Task bound to the
source and refuses new turns with that reason until a prompt or a cold opening
asks the fork again, so no turn runs in the wrong directory. The move's phases
are written to the driver's binding file, and a backend that restarts takes the
move up where it stopped.

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
the tool on resumed and re-attached sessions as well. Grok declares it on every
session load, under a fresh Task-bound header.

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
present during creation, isolation, transfer, and restoration, including legacy
`creating` recovery, and both are null in `ready`. `removing` and `archived` can
also have no anchor when explicit discard could not inspect Git. A partial pair
is always invalid; an absent anchor prevents Restore.
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
- once the checks pass, the Task's [terminal](terminal.md#lifetime) closes
  before the worktree is removed, and a refused Archive leaves it running;
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

Ordinary permanent deletion requires archive. The archived managed worktree
path is already absent, so deletion removes its ownership record without
removing any Git ref.

A failed removal is reinspected against the recorded repository and anchor
branch. An intact checkout returns to `ready` and clears the anchor, even if
it has become dirty. A verified missing UUID slot completes `archived`; scoped
administrative cleanup is best effort when the original repository is missing.
A broken or unverifiable checkout stays in `removing`. Startup uses the same
reconciliation; it does not automatically delete broken worktrees.

### Explicit Discard And Archive

When ordinary Archive refuses a dirty or broken managed checkout, its error
can offer `forceArchive` with the owned `worktreeId`. Task details offers
**Discard changes and archive**, which opens a native confirmation dialog with
the Task, worktree path, loss explanation, and retained conversation/branches.
The dialog defaults to Cancel. Task Detail rechecks the captured Task/worktree
identity before sending a confirmed request. Its POST to
`/api/tasks/{thread_id}/archive/force` requires that `expectedWorktreeId`.

The operation reserves the Task, rechecks active membership and UUID ownership,
refuses running Tasks, and closes its native conversation before deletion.
It removes the owned folder, including staged, unstaged, untracked, and ignored
files. It never removes an ordinary Task's original project folder. Git
connectivity is not required for deleting this owned slot; administrative
cleanup affects only verified backlinks. No local branch or conversation is
deleted. A readable checkout supplies its actual branch/HEAD anchor; if Git
cannot supply one, `archived` retains no anchor and Restore reports that limit.

A failed discard keeps its completed filesystem and record steps. A retry
accepts the same owned `removing` slot, or an already `archived` absent slot,
without recreating discarded files. Native, filesystem, and Task membership
changes are not one transaction.

### Broken Task Deletion

Detail checks the managed slot before acquiring the provider. For `ready` and
`removing`, HTTP and `task-sync` errors carry the same `code`, `message`, and
`allowedActions`. Verified `TargetMissing`, `NotRepository`, and
`MissingMetadata` failures can allow `deleteTask` with `worktreeId`,
`worktreePath`, and `worktreeMissing`. The UUID slot and repository
administration must pass ownership checks. Git execution and permission
failures are not proof of absence. Detached or mismatched branches,
repository mismatches, symlinks, and unowned paths do not grant deletion.

`DELETE /api/tasks/{thread_id}` accepts an active broken Task only with
`confirmBrokenWorktreeDeletion: true` and its `expectedWorktreeId`. A Task
mutation reservation serializes the operation. The server reinspects before
native deletion and filesystem cleanup; confirmation does not bypass a
healthy checkout's dirty protection, or apply to a changed or archived Task.

Deletion closes the terminal, deletes the recorded agent's conversation,
removes the owned UUID folder, and removes only Git administrative entries
whose `gitdir` backlink names that slot's `.git`. It does not prune unrelated
worktrees or remove branches. Task and worktree rows are deleted in one store
transaction without requiring an anchor or a new persisted state. Grok retains
its existing native session references through local cleanup and the store
commit so an interrupted cleanup can repeat native deletion, then drops the
binding. Conversation, filesystem, and store failures are reported; they are
not treated as successful deletion. If unlinking a private provider reference
fails after the store commit, Caffold logs that cleanup failure and still
publishes the committed Task removal. The reference does not retain the
deleted conversation or Caffold membership.

If a later coordinated step fails, Caffold attempts the inverse worktree
transition. It reverses the provider archive only when that provider operation
actually succeeded in the same request, so a failed or unattempted provider
operation is never treated as state that must be undone. This keeps the visible
Task state and filesystem state aligned without guessing provider state.
Interrupted transfer, `removing`, and `restoring` states are reconciled on
startup from the ownership record and actual filesystem state. A mismatched or
otherwise unsafe target remains in its persisted non-ready state without
preventing unrelated Tasks or the Caffold server from starting.

## Reconnect A Moved Section Folder

When a Section's original directory is verified missing, its inline picker
accepts the user-selected current location. Permission and inspection errors
remain unavailable. Ordinary folders and Git repositories without managed
worktrees use the same operation; neither Git nor a retained worktree is a
prerequisite for reconnecting the Section itself.

For surviving active managed worktrees, the candidate must contain the moved
repository's existing administrative evidence. Reconnection verifies each owned
UUID slot, forward pointer, administrative backlink, common directory, and
attached HEAD. It changes only verified owned markers and their repository
records, without broad repair, pruning external worktrees, switching branches,
or changing the index or working files. Missing individual worktrees are not
recreated, and in-progress lifecycle records prevent reconnection.

Direct active Tasks under the old directory retain their relative subpaths.
Each provider confirms the same Task at the destination: Codex updates native
thread settings and reads effective cwd; Claude resumes existing history and
moves its session/transcript; Grok switches its durable native binding while
keeping the Caffold Task identity. Independently moved Task directories outside
both source and target stay unchanged. Caffold persists Claude/Grok's new cwd;
Codex remains the owner of its native cwd. Moved Task terminals close.

Affected active Task mutations are reserved in stable order. Running or unknown
Task state blocks repair. Each successful Task repair is persisted separately;
a later failure retains those successes, keeps the Section's old path, and
names the failing Task. Repeating with the same selected folder recognizes
already repaired pointers and native directories. No recovery job or movement
history is stored. The Section commits last after rechecking membership,
records, and destination uniqueness, then closes its terminal. Task identities,
placement, history, and worktree Task directories are preserved.

Before that final commit, matching Archived worktree repository records and
direct Archived conversations are updated best effort. Codex requires native
unarchive, cwd update, and rearchive; its native read, not its potentially stale
archived list cwd, identifies the directory. Caffold Archived membership stays
unchanged. Failures are recorded in server diagnostics and do not create a
Section warning or a mandatory Git/provider gate for completion. Later Restore uses the surviving
records and reports an error while keeping Archived membership when the folder,
repository, or checkout anchor is unavailable. There is no additional Restore
folder picker, empty-Section retention, or mapping from historical paths.

Git markers, native sessions, and store writes are not atomic together. A retry
can finish an interrupted repair, but replacement clones without the evidence
needed by surviving managed worktrees are not adopted. A repeated completed
request to the same destination is harmless.

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
- Git mutation verifies the repository common directory and applicable checkout
  anchor. Explicit discard can remove an owned UUID folder with broken Git
  links; it never invents a checkout anchor or deletes Git refs.
- Ordinary Archive never removes a dirty ready worktree. Explicit discard
  requires a separate user action after a loss explanation. Recovery never
  resets an existing dirty target automatically; the exact dirty snapshot remains
  protected by its transfer ref for manual recovery. Clean isolation recovery
  likewise never resets a dirty target.
- A `ready` record accepts its live named branch after verifying the owned path,
  symlink boundary, repository common directory, and attached HEAD. Task detail,
  prompt, restart reconciliation, and serialization reads do not persist the
  observed branch or HEAD.
- Detached checkouts and repository mismatches block ordinary Git operations.
  Unowned paths and symlinked owned slots also block explicit discard.
- Normal archive preserves the branch that was live when archive began.
- Caffold never manages or deletes an external worktree merely because a Task
  uses it as cwd.
