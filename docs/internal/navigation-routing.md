# Navigation Routing

> Internal planning note. This document describes the first URL routing layer for
> Caffold's browser UI.

Caffold uses URLs to preserve review orientation across reloads, bookmarks, and
browser back/forward. URLs describe semantic review state only. They do not
encode mobile, foldable, or desktop layout state.

## Route Shape

Registered projects are addressed by stable project ID. Project names remain
display-only because they can be renamed.

- `/projects/:projectId/files`
- `/projects/:projectId/files/*path`
- `/projects/:projectId/diff`
- `/projects/:projectId/diff/*path`
- `/projects/:projectId/compare?base=...&head=...`
- `/projects/:projectId/compare/*path?base=...&head=...`
- `/projects/:projectId/log?page=...`
- `/projects/:projectId/log/:sha`
- `/projects/:projectId/log/:sha/*path`
- `/projects/:projectId/issues?page=...`
- `/projects/:projectId/issues/:number`

Route paths are project-relative. The frontend resolves the project ID through
the existing project API, then maps the route path onto the project's registered
root path before calling file, git, or GitHub APIs.

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
- review workspace close -> project files

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

## Server Fallback

The Rust server serves the app shell for known frontend routes under
`/projects`. API and asset routes stay explicit and should continue returning
their real errors when a path is missing.

## Test Contract

Routing changes should be covered by Playwright tests for direct entry, reload,
and browser back/forward across desktop, foldable, and phone projects when the
view affects mobile review behavior.
