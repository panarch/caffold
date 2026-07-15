# Navigation Routing

## Default entrypoint

`/` is an entrypoint alias, not a durable application surface. On startup the
app replaces it with `/tasks` so browser history starts at the Codex-first Tasks
home. The wide Tasks home keeps the task navigator visible and renders the New
Task composer as its default detail surface. Narrow viewports keep the list as
the first surface and open the composer through `/tasks/new`.

Codex availability does not decide the top-level surface. Connection failures
remain visible inside Tasks, where the user can retry or browse local files;
they must not cause a transient or automatic switch to Files.

> Internal planning note. This document describes the first URL routing layer for
> Caffold's browser UI.

Caffold uses URLs to preserve review orientation across reloads, bookmarks, and
browser back/forward. URLs describe semantic review state only. They do not
encode mobile, foldable, or desktop layout state.

## Route Shape

- `/tasks`
- `/tasks?cwd=...`
- `/tasks/new?cwd=...`
- `/tasks/:threadId?cwd=...`
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

Codex Tasks use Codex app-server threads as the source of truth and do not
require a local project registry. `/tasks` is the explicit all-threads route.
Header `Open Tasks` enters `/tasks?cwd=...`. Inside Git, the backend resolves the
cwd to its common Git directory and includes threads from every worktree of that
repository; outside Git it uses canonical cwd exact matching. Header `All Tasks`
enters plain `/tasks`.

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
- task detail -> task list
- new task -> task list
- global task list -> `/`
- standalone review workspace close -> standalone files at the same cwd

Task detail routes use Codex app-server `threadId` values directly. Caffold does
not mint a separate durable task ID in the first thread-backed slice.

Browser back/forward should produce the same state transitions as the visible
controls.

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

The Rust server serves the app shell for known frontend routes under `/files`,
`/git`, `/github`, and `/tasks`. API and asset routes stay explicit
and should continue returning their real errors when a path is missing.

## Test Contract

Routing changes should be covered by Playwright tests for direct entry, reload,
and browser back/forward across desktop, foldable, and phone projects when the
view affects mobile review behavior.
