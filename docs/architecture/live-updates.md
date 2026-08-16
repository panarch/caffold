# Live Updates

Caffold uses native filesystem watches as invalidation sources, not as a second
filesystem or Git model. Visible state is always reconciled through the
RootedFs and Git APIs.

## Backend event contract

`GET /api/watch?path=<logical-directory>` is an SSE stream. A `ready` event
contains the logical scope and optional repository root. A `change` event
contains a monotonic revision, up to 128 changed logical paths, Git status/ref
invalidation flags, and an overflow flag. Native events are quiet-debounced for
250 ms with a maximum batch latency of one second. Overflow or an event that
cannot be classified requests a full reconciliation of the active scope.

Repository worktrees are watched recursively together with relevant linked
worktree/common Git metadata. Non-repository directory scopes are watched
non-recursively. Canonical scopes are reference counted by the backend, so
active frontend consumers may share one native watcher without sharing their
selection or request state.

Paths outside the configured RootedFs boundary, including traversal and symlink
escapes, are rejected. Native watcher failure does not start polling. Active
surfaces retain current content and expose manual Refresh/Retry.

Filesystem event kinds are not domain semantics. Create, modify, remove, and
rename events invalidate affected file data. Repository worktree paths are
checked in one `git check-ignore --stdin` batch: an ignored-only batch may
invalidate loaded file data but does not invalidate Git status. Index changes
invalidate status; `HEAD`, refs, and `packed-refs` invalidate status plus
ref-derived Compare/Log data. Other internal Git object and lock events do not
refresh the UI.

The stream sends a comment heartbeat every 15 seconds. Event replay is not
provided. `EventSource` reconnects after a disconnect, and the owner performs
one full canonical sync after the next `ready`. Hiding the document closes the
shared connection; returning it to visible performs one recovery sync and
reconnects.

## Frontend ownership

`frontend/watch.js` shares `EventSource` connections by logical scope and
coalesces overlapping refresh work. UI owners still subscribe and unsubscribe
according to their own activation lifetime.

### Integrated Review

The active `caffold-task-review` owns one subject-root subscription. It uses:

- filesystem invalidation for its Files/Source presentation;
- `gitStatusChanged` for Working Tree;
- `gitRefsChanged` for current-branch/base comparison.

It refreshes only loaded directories and the relevant selected viewer where
possible. Overflow requests a bounded full reconciliation of the active
surface. Selection, disclosure, scroll, and pane width remain component-local.

### Shared Git

The active `caffold-task-git-layout` owns one repository-root subscription for
arbitrary Compare and Log. It ignores ordinary file and status-only
invalidations and reconciles ref-derived data on `gitRefsChanged`, recovery, or
explicit Compare Refresh. Log Fetch is a separate user action; watch and
recovery reconciliation never start it. The Git child does not load Working
Tree status or patches.

### Shared GitHub and inactive children

GitHub creates no filesystem watcher and performs no polling. It refreshes on
activation, meaningful route re-entry, Retry, or explicit actions.

Switching Integrated Review -> Git -> GitHub releases the previous child's
subscription and invalidates pending refresh generations before activating the
next child. Same-subject DOM may remain mounted while hidden, but hidden children
perform no active watch or refresh work. The common Detail keeps one Git and one
GitHub instance mounted; switching Task or Section subject deactivates them and
clears external repository context before either can reactivate.

Successful live invalidation is intentionally quiet. Watch failures preserve
current DOM and indicate that manual refresh is available; they never silently
create a polling fallback.
