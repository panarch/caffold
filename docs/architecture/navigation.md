# Navigation Routing

This document defines Caffold's browser routes and navigation ownership.
Routes preserve semantic Task orientation across reload, bookmarks, and browser
Back/forward. They do not encode desktop, foldable, or phone presentation.

## Application route boundary

`caffold-task-workspace` is the only routed workspace below
`caffold-app-shell`. The App Shell parses and forwards routes, owns the browser
history and each tab's last route behind `frontend/pages/navigation-history.js`,
applies application bootstrap data, and presents build updates. It does not
select a Task child, derive repository context for Git or GitHub, or implement
domain-local Back behavior.

Readiness does not change the top-level route, and no readiness state causes
a transient or automatic route switch. A blocking Task-store readiness state
replaces the ordinary Tasks content with persistent retry guidance; a blocking
Codex readiness state shows its setup guidance beside the New Task surface and
holds only Codex surfaces. Settings remains reachable.

`/` is the canonical Tasks home. `/tasks` canonicalizes to `/` with history
replacement. A selected Section also remains on the root path and uses a
canonical query route; Task URLs use path routes:

```text
/
/?section=<managed-section-id>
/?section=<managed-section-id>&surface=review&scope=...&nav=...&view=...&file=...&base=...
/?section=<managed-section-id>&surface=git&tool=compare&base=...&head=...&file=...
/?section=<managed-section-id>&surface=git&tool=log&page=...&sha=...&file=...
/?section=<managed-section-id>&surface=github&tool=issues&page=...&number=...
/?section=<managed-section-id>&surface=github&tool=pulls&page=...&number=...&files=true&file=...
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
/notes
/notes/:noteId
/settings
/settings/appearance
/settings/keyboard
/settings/files
/settings/notifications
/settings/remote-access
/settings/voice
/settings/codex
/settings/claude
/settings/grok
/settings/about
```

Section routes are frontend-only projections over the locally managed Section
list; they do not imply a backend Section detail endpoint. The route list above
is the complete frontend schema. Any other frontend path uses the server's
general unknown-route response.

## Tasks home presentation

`/` owns both the Task navigator and the default New Task detail without
encoding a responsive pane choice in the URL. Wide layouts keep the navigator
visible and render New Task as the default detail. Compact layouts show the
navigator first while either the active or Archived list contains Tasks. Once
both lists finish loading and are empty, the same `/` route shows New Task
instead of requiring a separate empty-state action.

Agent availability does not select the top-level surface. Codex readiness and
Claude or Grok operation failures remain visible inside their own Task or
Settings surfaces and must not cause a transient or automatic switch to another
workspace.

Selecting a managed Section opens its fixed-context New Task surface. Recovery
group headings are not selectable. A Managed Section ID that is absent after
the active list loads is not a recoverable remote resource and replaces the
route with Tasks home.

## Notes routes

`/notes` shows the Notes tree with no Note open. `/notes/:noteId` names the
open Note by its id and carries nothing else. Wide layouts show the tree and
the Note together. Compact layouts show the tree for `/notes` and the Note for
`/notes/:noteId`, whose visible Back requests `/notes`. A Note id that no longer
exists stays on its route and reports the missing Note.

## Canonical Task context

Every Git and GitHub route includes the selected Task's `threadId`. The field
name is the stable browser/API name for the Task's agent conversation ID; it
does not imply that every Task is a Codex thread. Task Detail loads that
canonical Task independently of navigator pagination and derives the
repository/worktree context from its Task snapshot. Git and GitHub routes never
carry `cwd` and must not borrow another selected Task or an app-level fallback
when context resolution fails.

`/tasks/new` is the sole route whose `cwd` query has application meaning. New
Task owns that selected directory. Its precedence is:

1. explicit `/tasks/new?cwd=...`;
2. the selected Task's canonical repository root for a New Task intent;
3. the bootstrap `initialPath` snapshot;
4. `.`.

The Directory Picker owns only its transient traversal while open. Cancel does
not change New Task; `Use This Folder` updates New Task and its route.

Section New never routes `cwd` and exposes no Directory Picker. Its fixed cwd is
the managed Section logical path. The Section's local repository capability
determines whether Working Tree, Branch, Git, and GitHub controls are available.

## Section Detail routes

`/?section=<id>` selects fixed-context New Task. Repository Sections also expose
the same shared Integrated Review, Git, and GitHub implementations used by Task
Detail. `surface` selects `review`, `git`, or `github`; `tool` selects the Git or
GitHub domain mode. Review and domain query fields retain the same meaning and
normalization as their Task counterparts.

After the local projection resolves, a repository surface for a Section without
repository capability replaces the route with that Section's fixed-context New
Task surface. A capability change for the selected Section follows the same
rule and clears retained repository context before navigation settles.

The root query carries durable semantic state because Managed Section IDs and
ordering are locally owned. It never carries a synthetic `threadId`, and shared
child route intents are translated back to the Section query schema by the
common Detail layout.

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
- `routeRelation(from, to)`
- `routeAscentSteps(from, to)`
- `routeEquals(left, right)`
- `routeSurface(route)`
- `routeTab(route)`
- `routeDomain(route)`
- `routeMode(route)`
- `routeTarget(route)`

`routeRelation` reports whether the second route descends below the first,
ascends above it, swaps with it at the same place, or belongs to another tab.
`routeAscentSteps` counts the parents between a route and one it sits under.
Both read only the declared parents and tabs, so they stay independent of
browser history and component state.

Git and GitHub route objects preserve their domain-local `kind` (`compare`,
`log`, `issues`, or `pulls`) and add the mandatory `threadId`; they are not
flattened into synthetic `kind: "tasks"` objects. Every canonical definition
reports `task-workspace` as its surface.

Section Detail remains `kind: "tasks"` and carries `sectionId` plus its
subject-local surface fields. `routeDomain`, `routeMode`, and `routeTarget`
derive shared-child metadata from those fields.

## Preparation and activation

Route handling is deliberately split:

1. parse the URL;
2. synchronously prepare the requested subject/domain/list/detail/file shell;
3. resolve a Section from the loaded local projection, or load a canonical Task
   by `threadId`;
4. derive repository context from that subject;
5. activate the requested shared child and reconcile canonical domain data.

`prepareRoute(route)` is API-free. A deep reload therefore presents the final
destination shell without flashing Tasks home, Conversation, or a domain list.
Missing Task repository or GitHub context remains in the requested Task shell
with Retry instead of redirecting elsewhere. Section repository capability is
resolved from the local projection and follows the Section normalization rule
above.

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
- Section child root or fixed-context New Task -> Tasks home;
- New Task -> Tasks home;
- Note -> Notes list;
- Settings section -> Settings list.

Visible Back requests the parent route. Browser Back traverses the entries the
history policy below left behind, which reach the same parents. On compact
layouts exactly one contextual Back is shown, with deepest-visible priority:
file, domain detail, then the active Task, Section, or New Task. Desktop does
not add a file Back when the corresponding navigator is simultaneously visible.

Conversation, fixed-context New Task, Integrated Review, Git, and GitHub share
the same parent for their active subject. A root child Back therefore targets
Tasks home; switching siblings uses the common Detail controls.

## Workspace tabs

`routeTab(route)` assigns every route to the bottom-tab surface that presents
it. `/notes*` belongs to Notes and `/settings*` to Settings; every Task,
Section, Git, and GitHub route belongs to Tasks. The Task Workspace reads its
current mode from that assignment rather than deriving one from route shape.

Each tab keeps the last route it showed. Selecting a tab reopens that route, so
a tab returns to the depth it was left at. A tab that has not been visited
opens the route its owner supplies: Tasks and Notes open their own home, and
Settings opens its Codex page while blocked Codex operations need repair.

Selecting the tab already shown requests no route. Its route stays, an open
Task included, and the Task Workspace scrolls that tab's navigator back to the
top.

## History policy

A route request decides its own history treatment from `routeRelation(from,
to)`, which reads the declared parents above. Individual screens request a
route and do not choose whether it is worth a history entry.

- A route under the current one pushes an entry. Opening a Task child from
  Tasks home, an Issue from its list, a commit from Log, PR Files from a PR,
  and a file from Review, Compare, Log, or PR Files all descend.
- A route at the same place replaces the current entry. Selecting another
  Task, Note, Settings section, Issue, or file, changing Log and GitHub pages,
  changing Compare or Review refs, changing Review axes, and switching between
  Conversation, Integrated Review, Git, and GitHub all stay at one entry.
- A route the current one sits under rewinds. Visible Back and file-close
  actions therefore consume the entry they leave instead of adding another.
- A route in another tab is an arrival there: that tab's own screens go in
  beneath it, so Back walks up the tab it landed in before leaving it. This
  covers both choosing a tab, which reopens the screen it last showed, and
  naming one of its pages directly, such as opening Voice Input setup from a
  Task.

Two kinds of request are exempt because their relation does not describe them.
Arrivals from outside are covered below. A correction always replaces: the
subject the route named is gone, so the route leaves for Tasks home without
consuming entries the person built. A Task that resolves to archived or
removed, and a Managed Section ID that is absent, are the only corrections.

Every other normalization follows the ordinary relation, because it lands where
the person already is: canonicalizing `/tasks`, sending a Task that needs
recovery to its recovery route, opening a restored Task, returning a Section
without repository capability to its fixed-context New Task, and normalizing
Review fields for the bound Task all resolve to the same replacement the
relation gives.

An arrival is a route that lands somewhere the person was not: an address the
browser loaded, a notification opening its Task, or any route in another tab,
reached by request or by native link. The screens it sits under are written
into the history beneath it, so Back walks up them instead of leaving the
application, returning to whatever the arrival interrupted, or standing on a
tab page with nothing of that tab below it.

Screens already under the route are not written again. An address the browser
loaded, and a link whose entry the browser already created, take that entry as
the chain grows from it; an arrival over a screen the route already sits under
adds only what is missing above it. A route with no parent, such as Tasks home
or either tab root, stays one entry.

Moves inside one tab keep their order. A native link followed there is a step
in that tab's flow, so the screen it was followed from stays under it: opening
a Review file from a Task's conversation returns to that conversation rather
than walking the file's parents.

Rewinding uses browser traversal only across entries the current route
descended through, including the ones written in beneath an arrival. A route
whose entry nothing descended onto replaces itself instead, so leaving it does
not traverse past what the person was doing.

Every route writer preserves all fields owned by the active domain when
changing one field.

Navigation entry state carries each tab's last route and how many preceding
entries the current route descended through, and every entry written beneath an
arrival carries its own record. Arriving at an entry restores that record; it
decides where a tab reopens and whether Back may traverse, not what a route
presents. Everything a route presents stays recoverable from the URL and
canonical Task/domain APIs.

An entry the browser created itself, following a native link, arrives without a
record and is given one once it is committed, which it is not yet while the
navigation is being intercepted. Inside one tab that record leaves the screen
the link was followed from under it, rewindable only when the route descended
onto it; across tabs the entry becomes the top of an arrival chain.

Writing an entry reports an arrival at it, so while a chain is being written
those reports are held off rather than read back as a person navigating.

Entries are written through the History API on both paths. A chain of entries
has to be written synchronously and repeatedly, and state written that way is
not readable through `navigation.currentEntry`, so one writer keeps the record
in one place. The Navigation API decides only which events report that the
browser reached an entry.

## Server fallback and tests

The Rust server serves the application shell for `/`, `/notes*`, `/settings*`,
and known `/tasks*` frontend routes. API and asset paths retain their own
errors. Unknown frontend paths return the general unknown-route response.

Route changes require pure route-helper coverage plus browser coverage for
direct entry, reload, internal navigation, deterministic Back, browser
Back/forward, stale-response rejection, and desktop/foldable/phone presentation
where layout changes the visible controls.

History changes additionally require pure coverage of the relation each request
resolves to, and browser coverage that counts entries: a descent adds one, a
same-place move adds none, visible Back leaves none behind, and returning to a
tab restores the depth it was left at.
