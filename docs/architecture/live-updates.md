# Live Updates

Caffold multiplexes backend-owned live observations through one physical SSE
connection per visible Task Workspace tab. REST remains the canonical boundary
for reads and mutations; live events invalidate or advance the projections
owned by Task List, Task Detail, and filesystem Watch consumers.

## Gateway contract

`GET /api/live` opens the tab's physical stream. Its first event is
`gateway-ready` with a server-generated `connectionId`. The browser publishes
the complete desired logical subscription snapshot to
`PUT /api/live/{connectionId}/subscriptions`:

```json
{
  "controlRevision": 4,
  "taskList": { "generation": 1 },
  "taskDetail": { "generation": 3, "threadId": "thread-id" },
  "watches": [
    {
      "subscriptionId": "watch-1",
      "generation": 2,
      "path": "logical/path"
    }
  ]
}
```

The control request must be same-origin. `controlRevision` is positive and
orders complete snapshots for one connection; an older or repeated revision
does not replace newer desired state. Task List and Task Detail each have at
most one logical subscription. Watch is a set because independently active
consumers may watch different canonical scopes. A Watch `subscriptionId` is
unique within the snapshot.

Each logical subscription carries its own positive generation. Replacing a
Task, retrying one channel, or changing a Watch scope advances only that
channel's generation. A late event or disposer cannot affect the replacement
generation. A physical reconnect receives a new `connectionId`, and the
browser republishes its current complete snapshot without changing logical
generations.

All logical output uses the `live-update` SSE event. Its JSON envelope contains
`channel`, `generation`, `type`, and an optional `payload`. Watch output also
contains `subscriptionId`. `channel-open` makes one logical channel ready;
`channel-error` terminates only the named channel generation. Task and Watch
event types and payloads otherwise retain their domain contracts.

The physical stream sends one comment heartbeat every 15 seconds. Replay and
`Last-Event-ID` are not provided. Reconnection reconstructs current state from
the full subscription snapshot and each domain's initial snapshot or ready
event.

The backend owns one independently cancellable producer and bounded queue per
logical subscription. A changed descriptor replaces only its producer; an
unrelated producer error does not end the physical stream. Dropping the SSE
response unregisters the `connectionId`, cancels all channel producers, and
makes later control requests for that ID fail.

## Task channels

Task List subscribes to its event receivers before loading the canonical
runtime snapshot. Its first domain event is `task-list-snapshot`, followed by
Task update, removal, placement, Section composer-setting, refresh, and sync
events observed after that boundary.

Task Detail retains the existing viewer lease, agent subscription, bootstrap,
sync, and event projection owners. Its first readable sequence starts with the
same `task-sync` bootstrap contract used by the adjacent Detail session. A Task
switch replaces the logical Task Detail generation while the physical SSE
connection remains open.

## Filesystem Watch

Native filesystem watches are invalidation sources, not a second filesystem or
Git model. Visible state is always reconciled through the RootedFs and Git APIs.
A Watch `ready` event contains the canonical logical scope and optional
repository root. A `change` event contains a monotonic revision, up to 128
changed logical paths, Git status/ref invalidation flags, and an overflow flag.
Native events are quiet-debounced for 250 ms with a maximum batch latency of
one second. Overflow or an event that cannot be classified requests a full
reconciliation of the active scope.

Repository worktrees are watched recursively together with relevant linked
worktree/common Git metadata. Non-repository directory scopes are watched
non-recursively. Canonical scopes are reference counted by the backend, so
multiple logical subscribers may share one native watcher without sharing
selection or request state.

Paths outside the configured RootedFs boundary, including traversal and symlink
escapes, are rejected. Native watcher failure does not start polling. Active
surfaces retain current content and expose manual Refresh or Retry.

Filesystem event kinds are not domain semantics. Create, modify, remove, and
rename events invalidate affected file data. Repository worktree paths are
checked in one `git check-ignore --stdin` batch: an ignored-only batch may
invalidate loaded file data but does not invalidate Git status. Index changes
invalidate status; `HEAD`, refs, and `packed-refs` invalidate status plus
ref-derived Compare or Log data. Other internal Git object and lock events do
not refresh the UI.

The Task current-plan projection uses the same invalidation contract. Its REST
response supplies the deepest existing logical directory on the path from the
Task cwd through `.caffold/plans/current`. The browser watches that
`watchPath`, rereads `GET /api/current-plan` after relevant changes, and moves
the subscription deeper as directories appear or back outward as they are
removed. A Watch event never supplies plan existence, title, or progress. The
first ready event triggers one reconciliation to close the initial
read-to-registration gap; reconnect recovery also rereads before clearing a
degraded presentation. Leaving Conversation or replacing the Task releases the
subscription and invalidates pending reads.

## Frontend ownership and recovery

`frontend/pages/(task-workspace)/live-updates.js` is the workspace-scoped public
owner. Its private lifecycle graph owns physical connection attachment,
visibility suspension, native reconnection grace, bounded replacement, and
exhaustion. The Task Workspace injects this capability into Task List, Task
Detail, Integrated Review, and Git; no global store or browser-wide worker owns
the connection.

Task List and Task Detail keep their domain lifecycles. Shared
`tasks/stream.js` adapts those lifecycles to logical gateway subscriptions,
including bootstrap timeout, canonical reconciliation, and stale-generation
rejection. `frontend/watch.js` reference-counts listeners by gateway and
logical scope, then maps each scope to one Watch subscription.

Hiding the document or entering the App Shell's definite offline suspension
closes the physical SSE while retaining desired logical subscriptions.
Returning to visible or starting foreground recovery opens a new connection
and republishes the snapshot. The existing App Shell foreground-recovery owner
still performs the canonical status, Task List, and selected Task Detail
reconciliation; the gateway adds no second recovery UI. A physical error is
reported to every logical consumer, while a `channel-error` affects only its
named subscription.

Integrated Review uses filesystem invalidation for Files and Source,
`gitStatusChanged` for Working Tree, and `gitRefsChanged` for current-branch
comparison. Shared Git listens only for ref-derived Compare and Log
invalidation. GitHub creates no filesystem Watch and performs no polling.
Switching shared Detail children releases the inactive child's logical Watch
subscription and invalidates its pending refresh generation.
