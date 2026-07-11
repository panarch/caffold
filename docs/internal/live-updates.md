# Live Updates

Caffold uses a native filesystem watcher for local Files and Git refreshes. The
watcher is an invalidation source, not a second filesystem or Git model: every
visible update is still loaded through the existing Files and Git APIs.

## Scope

- A Git repository is watched recursively from its worktree root. Linked
  worktree Git directories and the common Git directory are watched as
  additional metadata roots.
- A directory outside Git is watched non-recursively. Navigating to another
  directory replaces that scope.
- Canonical scopes are shared and reference counted by the backend, so Files,
  Codex Files, and Git can subscribe without creating duplicate native
  watchers.
- Paths outside the configured filesystem root, including symlink escapes, are
  rejected by the same `RootedFs` boundary used by the Files API.

Native watcher startup failures do not fall back to polling. The UI keeps its
current content, marks its Refresh controls with a warning, and remains usable
through manual refresh.

## Event Contract

`GET /api/watch?path=<logical-directory>` is an SSE stream. It starts with a
`ready` event containing the logical scope and optional repository root. A
`change` event contains a monotonic revision, up to 128 changed logical paths,
Git status/ref invalidation flags, and an `overflow` flag.

Filesystem event kinds are deliberately not exposed as domain semantics.
Create, modify, remove, and rename events all invalidate affected paths. Events
are quiet-debounced for 250 ms, with a maximum batch latency of one second.
Overflow or unclassifiable events request a full refresh of the currently
loaded scope.

Git worktree paths are checked in one `git check-ignore --stdin` batch. An
ignored-only batch can refresh Files but does not invalidate Git status. Git
index changes invalidate status; `HEAD`, refs, and `packed-refs` invalidate
status plus Compare/Log ref-derived data. Other internal Git object and lock
events do not refresh the UI.

The stream sends a comment heartbeat every 15 seconds. Event replay is not
provided. A disconnected client reconnects through `EventSource` and performs
one full sync after the next `ready` event. Returning a hidden tab to visible
also performs one full sync.

## Frontend Refresh Rules

`watch.js` shares one `EventSource` for each logical scope and
coalesces overlapping refresh requests. If another invalidation arrives while
a request is active, one additional refresh runs after the active request.

Files refreshes only directories already present in the tree cache and reloads
only the selected file when its exact path changes. Overflow refreshes cached
directories with at most four concurrent list requests. Selection, expanded
directories, list/viewer scroll, and panel width remain in place. Image URLs
include the watcher revision to bypass browser caches.

Git status remains subscribed while repository context exists, independent of
the current Files, Git review, or Codex surface. Worktree invalidation refreshes
status and an open working-tree patch. Ref invalidation refreshes Compare or
Log only when that mode is active.

Successful live updates are intentionally silent. Files and Git surfaces
always expose a manual Refresh control; the icon rotates only while a refresh
request is active. Watch failures change the control to a warning state with
the tooltip `Live updates unavailable. Refresh manually.`
