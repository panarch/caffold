# Navigation Routing

## Default entrypoint

`/` is the canonical Codex-first Tasks home and the durable application
entrypoint. The `/tasks` compatibility URL is accepted on direct entry and
canonicalized to `/` with history replacement. The wide Tasks home keeps the
task navigator visible and renders the New Task composer as its default detail
surface. Narrow viewports keep the list as the first surface while active or
archived tasks exist. Once both lists are loaded and empty, the same Tasks home
shows New Task as its default detail instead of requiring a separate empty-state
action.

Codex availability does not decide the top-level surface. Connection failures
remain visible inside Tasks, where the user can retry or browse local files;
they must not cause a transient or automatic switch to Files.

This document defines Caffold's browser routing and navigation ownership.

Caffold uses URLs to preserve review orientation across reloads, bookmarks, and
browser back/forward. URLs describe semantic review state only. They do not
encode mobile, foldable, or desktop layout state.

## Route Shape

- `/`
- `/tasks/new?cwd=...`
- `/tasks/:threadId`
- `/tasks/:threadId/review?scope=...&nav=...&view=...&file=...&base=...`
- `/files?cwd=...&file=...`
- `/git/diff?cwd=...&file=...`
- `/git/compare?cwd=...&base=...&head=...&file=...`
- `/git/log?cwd=...&page=...&sha=...&file=...`
- `/github/issues?cwd=...&page=...`
- `/github/issues/:number?cwd=...`
- `/github/pulls?cwd=...&page=...`
- `/github/pulls/:number?cwd=...`
- `/github/pulls/:number/files?cwd=...&file=...`

Files, Git, and GitHub routes use a RootedFs logical `cwd` query. File and
review paths are relative to that context. Git and GitHub routes canonicalize
`cwd` to the live repository root before replacing the current history entry,
so reload and copied URLs use one stable repository context.

When a standalone route omits `cwd`, the app fills it before route preparation
using this precedence: the selected Task worktree/thread context, the current
Files directory, then the server initial path. Review routes prefer the current
live repository root when one is already loaded.

Codex remains the content/runtime source of truth and Caffold does not require a
local project registry. `/` is the explicit Caffold Tasks route, split into
active and Archived Caffold-managed threads. Unmanaged app-server threads are
outside this navigation model; direct Task URLs do not import them implicitly.
The Codex action in the Files surface always enters `/`. Task rows are grouped
by repository and worktree context derived from each thread cwd; cwd never
filters the list.
`/tasks/new?cwd=...` is the only Tasks route that carries cwd, because it selects
where the new thread starts. Compatibility list and detail URLs containing cwd are
canonicalized to their cwd-free forms.

Tasks route targets describe semantic detail ownership rather than responsive
layout: `/` is `home`, `/tasks/new` is `new`, and a thread route is `detail` or
`review`. The `home` target owns both the task navigator and the default New Task
detail. Viewport and the combined active-and-archived list state decide which of
those two panes is visible on compact layouts; they never change the URL. The
Navigator header owns the New Task action. Its explicit `new` target preserves
cwd from an existing task context when one is selected, so both context and
browser history remain durable.

Task Conversation keeps `/tasks/:threadId`. Integrated Task Review uses
`/tasks/:threadId/review` and carries five independent semantic fields:

- `scope=working|branch`
- `nav=changes|files`
- `view=diff|source`
- `file=<task-root-relative-path>`
- `base=<branch-base-ref>`

The defaults (`working`, `changes`, `diff`, no file, no base) are omitted.
Unknown enum values, parent traversal, and root-escaping file paths normalize
to safe defaults with history replacement. If Branch has no explicit base,
the Git refs response supplies the default and the resolved base is replaced
into the URL. Async Git and filesystem responses fill the prepared Review but
do not decide its selected path or axes.

## Route Definitions

`frontend/navigation-routes.js` keeps the route schema in an internal
`ROUTE_DEFINITIONS` table. Each entry is a concrete URL pattern such as
`/git/log` or `/github/pulls/[number]/files`. A route entry owns parsing, path
generation, query parameters, parent-route behavior, and
surface/domain/target metadata for that URL variant. `routeMode(route)` returns
the route kind as the domain-local mode.

Route object matching is generated from the route kind, URL pattern parameters,
rest path segments, and target metadata. Add a custom matcher only for a route
variant that cannot be described by those fields.

The exported helpers remain the public interface:

- `parseRoute(url)`
- `routeUrl(route)`
- `parentRoute(route)`
- `routeEquals(left, right)`
- `routeSurface(route)`
- `routeDomain(route)`
- `routeMode(route)`
- `routeTarget(route)`

Adding a route variant should mean adding one route definition plus route helper
tests. The table is an implementation detail and is not exported.

## Parent Routes

Back and close controls use deterministic parent routes:

- file viewer -> file list at the parent path
- diff file -> diff list
- compare file -> compare list with the same refs
- commit file -> commit detail
- commit detail -> log list
- issue detail -> issue list
- PR file -> PR files
- PR files -> PR detail
- PR detail -> PR list
- task detail -> Tasks home
- task Review file -> the same Review route without `file`
- task Review list -> the same task Conversation
- new task -> Tasks home
- Tasks home -> no parent
- standalone review workspace close -> standalone files at the same cwd

Task detail routes use Codex app-server `threadId` values directly. Caffold does
not mint a separate durable task ID. A direct route for an unmanaged thread
performs a metadata-only read and shows the Continue gate without resuming or
subscribing to the thread.

Browser back/forward should produce the same state transitions as the visible
controls.

Conversation -> Review pushes a history entry. Scope, navigator, viewer, and
base changes replace the current Review entry because they refine one review
workspace rather than open a new destination. The first file selection pushes
the file parent boundary; later file selections replace that file entry. On
phone, the visible Review Back control removes only `file`, matching the
semantic parent returned by `parentRoute`.

## Browser API

The Navigation API is the primary integration point. Initial page load is handled
explicitly because the Navigation API does not fire `navigate` for the first
document load. A small History API fallback keeps the same route interface usable
in older browsers.

Navigation entry state is reserved for ephemeral UI state such as scroll
restoration. Durable review state must be recoverable from the URL and current
backend APIs.

## Route Lifecycle

Every routed surface follows the same lifecycle:

1. Parse the URL into a semantic route.
2. Prepare the target synchronously with `prepareRoute(route)`.
3. Load cwd context, status, and content asynchronously.
4. Refresh the already-prepared target with the loaded data.

`prepareRoute(route)` must not call APIs. It may only set the active surface,
domain mode, subview, selected placeholder, shared chrome title/subtitle/back
state, and mobile detail state implied by the route.

The URL is the source of truth for whether the target is a list, detail, files,
or file viewer surface. Async loading results may fill that target, but they
must not be required to decide which target is visible.

This matters most for reload and direct URL entry. A PR file route such as
`/github/pulls/:number/files?cwd=...&file=...` should prepare the PR files
viewer immediately. It should not show the file browser, PR list, or PR detail
while GitHub status, PR file lists, or diffs are loading.

GitHub status setters must not implicitly load Issues or Pull Requests lists.
List loading belongs to list routes only. Detail and file routes must remain
independently reloadable even when no list cache exists.

## Server Fallback

The Rust server serves the app shell for `/`, `/settings`, and known frontend
routes under `/files`, `/git`, `/github`, and `/tasks`. API and asset routes stay explicit
and should continue returning their real errors when a path is missing.

## Test Contract

Routing changes should be covered by Playwright tests for direct entry, reload,
and browser back/forward across desktop, foldable, and phone projects when the
view affects mobile review behavior.
