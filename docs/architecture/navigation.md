# Navigation Routing

This document defines Caffold's browser routes and navigation ownership.
Routes preserve semantic Task orientation across reload, bookmarks, and browser
Back/forward. They do not encode desktop, foldable, or phone presentation.

## Application route boundary

`caffold-task-workspace` is the only routed workspace below
`caffold-app-shell`. The App Shell parses and forwards routes, applies
application bootstrap data, and presents build updates. It does not select a
Task child, derive repository context for Git or GitHub, or implement
domain-local Back behavior.

`/` is the canonical Tasks home. `/tasks` canonicalizes to `/` with history
replacement. All other active application routes are either Settings or
Task-scoped routes:

```text
/
/tasks/new?cwd=...
/tasks/:threadId
/tasks/:threadId/review?scope=...&nav=...&view=...&file=...&base=...
/tasks/:threadId/git/compare?base=...&head=...&file=...
/tasks/:threadId/git/log?page=...&sha=...&file=...
/tasks/:threadId/github/issues?page=...
/tasks/:threadId/github/issues/:number?page=...
/tasks/:threadId/github/pulls?page=...
/tasks/:threadId/github/pulls/:number?page=...
/tasks/:threadId/github/pulls/:number/files?page=...&file=...
/settings
/settings/appearance
/settings/codex
/settings/about
```

The route list above is the complete frontend schema. Any other frontend path
uses the server's general unknown-route response.

## Tasks home presentation

`/` owns both the Task navigator and the default New Task detail without
encoding a responsive pane choice in the URL. Wide layouts keep the navigator
visible and render New Task as the default detail. Compact layouts show the
navigator first while either the active or Archived list contains Tasks. Once
both lists finish loading and are empty, the same `/` route shows New Task
instead of requiring a separate empty-state action.

Codex availability does not select the top-level surface. Connection failures
remain visible inside Tasks and must not cause a transient or automatic switch
to another workspace.

## Canonical Task context

Every Git and GitHub route includes the selected Codex `threadId`. Task Detail
loads that canonical Task independently of navigator pagination and derives
the repository/worktree context from its Task snapshot. Git and GitHub routes
never carry `cwd` and must not borrow another selected Task or an app-level
fallback when context resolution fails.

`/tasks/new` is the sole route whose `cwd` query has application meaning. New
Task owns that selected directory. Its precedence is:

1. explicit `/tasks/new?cwd=...`;
2. the selected Task's canonical repository root for a New Task intent;
3. the bootstrap `initialPath` snapshot;
4. `.`.

The Directory Picker owns only its transient traversal while open. Cancel does
not change New Task; `Use This Folder` updates New Task and its route.

## Task Detail routes

`/tasks/:threadId` selects Conversation. Task Detail exposes four stable
sibling surfaces:

- Integrated Review owns Working Tree and current Task Branch review.
- Git owns arbitrary-ref Compare and bounded Log/commit inspection.
- GitHub owns Issues and Pull Requests.

Integrated Review carries independent semantic axes:

- `scope=working|branch`
- `nav=changes|files`
- `view=diff|source`
- `file=<task-root-relative-path>`
- `base=<branch-base-ref>`

Defaults (`working`, `changes`, `diff`, no file, no base) are omitted. Invalid
enums and root-escaping paths normalize to safe defaults. A Branch response
may replace an absent or invalid base with the normalized current base, but
asynchronous data does not decide the selected scope, navigator, viewer, or
path.

Git Compare preserves `base`, `head`, and `file`. Git Log preserves `page`,
`sha`, and `file`. GitHub lists and details preserve `page`; Pull Request Files
also preserves `file`. Paths are repository-relative and reject parent
traversal.

## Route definitions

`frontend/navigation-routes.js` is the pure central schema. Its internal
`ROUTE_DEFINITIONS` entries own parsing, URL generation, query normalization,
parent calculation, and surface/domain/target metadata. They do not own API
requests, selected Task state, or component activation.

The public helpers are:

- `parseRoute(url)`
- `routeUrl(route)`
- `parentRoute(route)`
- `routeEquals(left, right)`
- `routeSurface(route)`
- `routeDomain(route)`
- `routeMode(route)`
- `routeTarget(route)`

Git and GitHub route objects preserve their domain-local `kind` (`compare`,
`log`, `issues`, or `pulls`) and add the mandatory `threadId`; they are not
flattened into synthetic `kind: "tasks"` objects. Every canonical definition
reports `task-workspace` as its surface.

## Preparation and activation

Route handling is deliberately split:

1. parse the URL;
2. synchronously prepare the requested Task/domain/list/detail/file shell;
3. load the canonical Task by `threadId`;
4. derive its repository/worktree snapshot;
5. activate the requested child and reconcile canonical domain data.

`prepareRoute(route)` is API-free. A deep reload therefore presents the final
destination shell without flashing Tasks home, Conversation, or a domain list.
Missing Task, repository, or GitHub context remains in the requested shell with
Retry instead of redirecting elsewhere.

Task switches, route changes, repository-context changes, and child
deactivation invalidate the relevant request generations. A late response may
not patch or reactivate a stale destination.

## Parent and Back behavior

`parentRoute(route)` defines deterministic visible parents:

- Integrated Review file -> the same Review route without `file`;
- Git Compare file -> Compare list with the same refs;
- Git Log file -> commit; commit -> Log list;
- Issue detail -> Issues list;
- PR file -> PR Files; PR Files -> PR detail; PR detail -> PR list;
- Task child root or Conversation -> Tasks home;
- New Task -> Tasks home;
- Settings section -> Settings list.

Browser Back remains ordinary history traversal. Visible Back is a semantic
parent action and follows the explicit history policy below. On compact layouts
exactly one contextual Back is shown, with deepest-visible priority: file,
domain detail, then Task. Desktop does not add a file Back when the
corresponding navigator is simultaneously visible.

Conversation, Integrated Review, Git, and GitHub share the same parent. A root
child Back therefore targets Tasks home; switching siblings uses the Task
Summary controls.

## History policy

Route requests push by default. Opening a Task child, Git/GitHub list or detail,
Compare or Log file, PR Files, changing Compare refs, and changing Log/GitHub
pages therefore create replayable history entries. Domain-local visible Back
and file-close actions also request their semantic parent through the default
push policy; browser Back remains ordinary traversal of the entries already
visited.

Replacement is explicit and limited to cases that refine or canonicalize the
current destination: `/tasks` canonicalization, invalid-route normalization,
compact Task exit, and Integrated Review axis/base changes. Integrated Review's
first file selection pushes its file boundary; later file selections replace
that file entry, and clearing the selected file replaces it with the same
Review route without `file`.

Every route writer preserves all fields owned by the active domain when
changing one field.

Navigation entry state is reserved for ephemeral browser state such as scroll
restoration. Durable semantic state must be recoverable from the URL and
canonical Task/domain APIs.

## Server fallback and tests

The Rust server serves the application shell for `/`, `/settings*`, and known
`/tasks*` frontend routes. API and asset paths retain their own errors. Unknown
frontend paths return the general unknown-route response.

Route changes require pure route-helper coverage plus browser coverage for
direct entry, reload, internal navigation, deterministic Back, browser
Back/forward, stale-response rejection, and desktop/foldable/phone presentation
where layout changes the visible controls.
