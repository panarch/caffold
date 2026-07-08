# Navigation Routing

> Internal planning note. This document describes the first URL routing layer for
> Caffold's browser UI.

Caffold uses URLs to preserve review orientation across reloads, bookmarks, and
browser back/forward. URLs describe semantic review state only. They do not
encode mobile, foldable, or desktop layout state.

## Route Shape

Registered projects are addressed by stable project ID. Project names remain
display-only because they can be renamed.

- `/tasks`
- `/tasks?cwd=...`
- `/tasks/new?cwd=...`
- `/tasks/:threadId?cwd=...`
- `/projects/:projectId/files`
- `/projects/:projectId/files/*path`
- `/projects/:projectId/tasks`
- `/projects/:projectId/tasks/new`
- `/projects/:projectId/tasks/:threadId`
- `/projects/:projectId/diff`
- `/projects/:projectId/diff/*path`
- `/projects/:projectId/compare?base=...&head=...`
- `/projects/:projectId/compare/*path?base=...&head=...`
- `/projects/:projectId/log?page=...`
- `/projects/:projectId/log/:sha`
- `/projects/:projectId/log/:sha/*path`
- `/projects/:projectId/issues?page=...`
- `/projects/:projectId/issues/:number`
- `/projects/:projectId/pulls?page=...`
- `/projects/:projectId/pulls/:number?page=...`
- `/projects/:projectId/pulls/:number/files?page=...`
- `/projects/:projectId/pulls/:number/files/*path?page=...`

Route paths under `/projects/:projectId` are project-relative. The frontend
resolves the project ID through the existing project API, then maps the route
path onto the project's registered root path before calling file, git, or
GitHub APIs.

Codex Tasks use Codex app-server threads as the source of truth and do not
require a registered project. `/tasks` is the explicit all-threads route.
Header `Open Tasks` enters `/tasks?cwd=...`, which filters to threads whose
`cwd` exactly matches the current browser directory; header `All Tasks` enters
plain `/tasks`. Project-scoped task routes remain as filters/context routes:
they restrict the thread list to threads whose `cwd` is under the project root
and provide a project-root default cwd for new turns.

## Route Definitions

`frontend/navigation-routes.js` keeps the route schema in an internal
`ROUTE_DEFINITIONS` table. Each entry is a concrete URL pattern such as
`/projects/[projectId]/log/[sha]/[...path]` or
`/projects/[projectId]/pulls/[number]/files`. A route entry owns parsing, path
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

## Project IDs

Project IDs are URL identities, not user-facing names. They should stay opaque
and stable even when a project is renamed.

Project IDs use short opaque lowercase hex values. Eight hex digits are enough
for this local single-user project registry when paired with collision retries.
Avoid making names globally unique just to use them in URLs; duplicate project
names can remain a display concern.

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
- project task list -> project files
- review workspace close -> project files

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
3. Load project context, status, and content asynchronously.
4. Refresh the already-prepared target with the loaded data.

`prepareRoute(route)` must not call APIs. It may only set the active surface,
domain mode, subview, selected placeholder, shared chrome title/subtitle/back
state, and mobile detail state implied by the route.

The URL is the source of truth for whether the target is a list, detail, files,
or file viewer surface. Async loading results may fill that target, but they
must not be required to decide which target is visible.

This matters most for reload and direct URL entry. A PR file route such as
`/projects/:projectId/pulls/:number/files/*path` should prepare the PR files
viewer immediately. It should not show the file browser, PR list, or PR detail
while GitHub status, PR file lists, or diffs are loading.

GitHub status setters must not implicitly load Issues or Pull Requests lists.
List loading belongs to list routes only. Detail and file routes must remain
independently reloadable even when no list cache exists.

## Server Fallback

The Rust server serves the app shell for known frontend routes under
`/projects` and `/tasks`. API and asset routes stay explicit and should
continue returning their real errors when a path is missing.

## Test Contract

Routing changes should be covered by Playwright tests for direct entry, reload,
and browser back/forward across desktop, foldable, and phone projects when the
view affects mobile review behavior.
