# Frontend Architecture

The frontend is a small Light-DOM Web Component application. Its primary
ownership rule is Task-first: application navigation enters one Task workspace,
and a selected Task owns its Conversation, Integrated Review, Git, and GitHub
children.

## Source organization

Caffold does not use filesystem routing. `frontend/pages` is a hierarchy of
page-level custom-element ownership, not a URL router such as Next.js. The
directory path expresses ownership even when it does not appear in the browser
URL.

Use `layout.js` and `layout.css` for container components that own nested
surfaces, shared chrome, state transitions, or pane behavior. Use `page.js` and
`page.css` for leaf app surfaces. Intermediate `frontend/pages` directories
without their own `page.js` are wrapped in parentheses, such as `(git)`,
`(log)`, and `(github)`; these are pathless ownership/layout nodes, not URL
segments. The root `frontend/pages/layout.js` is the sole exception because an
additional parenthesized root would repeat the application hierarchy.

Lower-level or reusable leaves stay in `frontend/components` even when they are
rendered by one current screen. Page-specific helpers may live in that page's
`components/` directory when moving them to the shared directory would hide
their owner. A reusable component does not become a page merely because it
occupies most of a surface.

## Routed hierarchy

```text
caffold-app-shell
`-- caffold-task-workspace
    |-- Task navigator
    |-- New Task
    |   `-- Directory Picker
    |-- Task Detail
    |   |-- Conversation
    |   |-- Integrated Review
    |   |-- Git
    |   |   |-- Compare
    |   |   `-- Log
    |   `-- GitHub
    |       |-- Issues
    |       `-- Pull Requests
    `-- Settings
```

Task Workspace stays mounted while Task Detail switches among Conversation,
Integrated Review, Git, and GitHub. The selected `threadId` remains the
canonical Task identity throughout those child transitions.

## App Shell

`frontend/pages/layout.js` defines `caffold-app-shell`. It owns only
application-lifetime coordination:

- bootstrap health and initial-path loading;
- parsing and forwarding top-level routes;
- Navigation API and History fallback integration;
- settings application;
- build-update presentation.

All known routes are forwarded to `caffold-task-workspace`. Task Detail owns
the selected child and Task context; Git and GitHub own their layout instances,
repository reconciliation, and domain-specific Back and Refresh behavior.

The Rust shell fallback serves only the known Tasks and Settings frontend
routes. Every other frontend path receives the general unknown-route response.

## Task Workspace

`frontend/pages/(task-workspace)/layout.js` is the only routed workspace. It
owns:

- the shared master/detail presentation;
- Task versus Settings mode;
- Task and Settings navigators;
- the user-resizable desktop navigation pane;
- compact top-level Task/New Task Back or Close controls;
- forwarding routes to Tasks or Settings.

The workspace consumes the semantic presentation snapshot published by Tasks:
`reading` or `code`, current Task target, and Task-detail child. It does not
query nested Git/GitHub DOM or read their private state.

Reading surfaces keep the Task navigator on desktop. Code surfaces use the full
workspace width. Foldable and phone presentation is owned by the same
master/detail layout system.

## Tasks Page and Task Detail

`caffold-tasks-page` owns the home/new/detail choice and connects the Task
navigator. It identifies any route with `threadId` as Task Detail, including
Git and GitHub domain routes.

`caffold-task-detail` owns:

- the selected `threadId` and canonical Task snapshot;
- the selected outer surface;
- Task-scoped route intents;
- the selected Task's Codex event stream;
- Task-level Summary and Conversation state;
- child creation, activation, deactivation, and disposal.

A deep route is prepared synchronously before canonical Task loading. Task
Detail loads the Task independently of navigator pagination, derives the
worktree/repository snapshot, and activates the requested domain only after
that snapshot is available. Errors remain in the requested shell.

Same-Task switches do not interrupt or recreate the Task stream. A Task switch
invalidates Task and child generations before the new Task can render. Task
Summary sends intents upward and does not own GitHub availability requests.

## Task Detail children

### Conversation

Conversation owns transcript rendering, disclosure and scroll state, and the
follow-up Composer. Stateful children are preserved by identity through Task
Detail's incremental shell updates. Moving from Tasks to Settings ends active
editing and transport work without destroying a retained Composer draft.

### Integrated Review

`caffold-task-review` is the sole owner of Working Tree and current Task Branch
review. It owns:

- scope, navigator, viewer, base ref, and selected path;
- Git status, branch refs/compare, file, diff, and source requests;
- one root watch while active;
- Changes/Files and Diff/Source reconciliation;
- pane width, disclosure, selection, and scroll.

Integrated Review uses a bounded per-thread component cache. Disconnecting an
inactive entry invalidates its requests and releases its root watch. Its
selected path and current-branch root watch remain unique to that cached review
instance.

### Git

`caffold-task-git-layout` is a direct Task Detail child under the pathless
`detail/(git)` directory. It owns arbitrary Compare and bounded Log modes,
repository ref status, canonical reconciliation, domain-local routes, request
generations, and a refs-only watch while active.

It does not own Working Tree status, Task-related paths, current Task Branch
comparison, or a Diff mode. Compare and Log leaves retain their own list,
commit, file, diff, and source state.

### GitHub

`caffold-task-github-layout` is a direct Task Detail child under
`detail/(github)`. It owns GitHub availability, Issues/Pulls mode, route-local
list/detail/files selection, canonical reconciliation, nested request
generations, and domain-local Back intents.

GitHub performs no polling and creates no filesystem watcher. Activation,
meaningful re-entry, Retry, and explicit actions request current canonical
state. Hidden DOM may remain visible when reactivated, but it is never treated
as proof that remote data is current.

### Activation contract

Connection and activation are separate concepts for Task domain children.

- `prepareRoute(route)` selects DOM and chrome without APIs.
- `activate(route, snapshot)` binds canonical Task repository context and
  performs a fresh reconciliation.
- `deactivate()` invalidates requests and releases watches/timers while keeping
  safe DOM-local state.
- disconnection/destroy performs deactivation plus instance cleanup.

Within one Task, Git and GitHub instances stay mounted in hidden sibling slots.
Switching Tasks destroys both instances, so their DOM lifetime is bounded to
the selected Task. A repository/worktree context change within the same Task is
a hard data-rebind boundary even though the outer surface stays selected.

Every async writer checks an owner generation, route identity, context identity,
or nested request token. A late response cannot reactivate an inactive child,
write into a new Task, or restore a stale route.

## Data flow

Parent-to-child data crosses as snapshots or public methods. Child actions
cross upward as intents.

```text
canonical Task response
        |
        v
Task Detail --context snapshot--> active child
        ^                              |
        `-------- route intent --------'
```

No global store coordinates this hierarchy. Canonical Task, Git, GitHub, and
filesystem projections remain independent because their external sources and
revision lifetimes are independent.

## Route ownership

`frontend/navigation-routes.js` owns the pure schema and metadata. App Shell
forwards; Task Workspace selects Tasks/Settings; Task Detail selects the outer
Task child; Git and GitHub select their domain-local modes and leaves.

Task-scoped Git/GitHub routes always carry `threadId` and never route `cwd`.
Task Detail derives repository context from canonical Task state. See
[Navigation Routing](navigation.md) for exact route and Back contracts.

## New Task and directories

New Task owns its cwd, draft, and choices. The Directory Picker is a transient
child that returns a selected folder directly to New Task. The selected
directory is represented by New Task state and its route.

Reusable RootedFs capabilities remain shared:

- `caffold-file-navigator` and its list leaf;
- `caffold-review-file-viewer`;
- source, text, diff, and supported image presentation;
- shared watch subscription primitives;
- New Task Directory Picker;
- Integrated Review Files navigation;
- Git Compare/Log and GitHub PR Files leaves.

`caffold-review-file-viewer` hosts the reusable source, diff, text, and image
leaves used by review surfaces. Navigation, presentation, and filesystem-watch
primitives stay shared while each active surface owns its selection and request
lifetime.

## Settings

Settings lives inside Task Workspace. Appearance owns theme and Interface,
Conversation, and Code scales. Settings Codex owns `getCodexStatus`, loading,
error, Refresh, runtime restart, post-restart refresh, and its request
generations. It refreshes on activation, invalidates pending work when hidden,
and requests its runtime status directly.

## Physical hierarchy

Relevant source ownership follows the routed hierarchy:

```text
frontend/
|-- navigation-routes.js
|-- pages/
|   |-- layout.js
|   `-- (task-workspace)/
|       |-- layout.js
|       |-- settings/
|       |   `-- codex/
|       |       |-- page.js
|       |       `-- status-model.js
|       `-- tasks/
|           |-- page.js
|           `-- components/
|               |-- detail.js
|               `-- detail/
|                   |-- review.js
|                   |-- review/changes-tree.js
|                   |-- (git)/
|                   |   |-- layout.js
|                   |   |-- compare/page.js
|                   |   `-- (log)/...
|                   `-- (github)/
|                       |-- layout.js
|                       |-- (issues)/...
|                       `-- (pulls)/...
`-- components/
    |-- file-navigator.js
    |-- file-navigator/list.js
    |-- file-viewer.js
    |-- git-compare-browser.js
    `-- review-panel-resizer.js
```

A directory with its own `page.js`, such as `compare`, remains a leaf surface.
Names describe the current owner and role: nested Git Log and GitHub
Issues/Pulls layouts own domain state, while reusable components stay outside
`pages`.

## Styling and assets

Components render in Light DOM, so CSS remains one cascade. Each stylesheet
must scope internal selectors below the owning custom element. A parent may
size or hide a child host, but descendant styling belongs to the child.

Every production JavaScript/CSS asset must be registered consistently in:

- module imports;
- `frontend/styles.css`;
- `frontend/service-worker.js`;
- `src/static_assets.rs`;
- static asset and CSS ownership tests.

The service-worker cache and Rust static-asset table are exact manifests of the
assets imported by the active application hierarchy.

## Test ownership

Regression tests move with the active owner:

- pure route schema in `tests/navigation-routes.test.mjs`;
- Task Detail and Integrated Review in `tests/e2e/tasks/`;
- Task-owned Git in `tests/e2e/tasks/git-review.spec.js`;
- Task-owned GitHub in `tests/e2e/tasks/github-review.spec.js`;
- application shell boundaries in `tests/e2e/app-shell.spec.js`;
- Settings Codex behavior in `tests/e2e/settings.spec.js`;
- assets, CSS, appearance, and watch primitives in their focused Node/Rust
  suites.

Reusable file/source/diff/image behavior is covered through its active Task
owners. Browser coverage must exercise direct entry/reload, Back and browser
history, child switching, Task switching during pending work, activation
freshness, stale response rejection, watch cleanup, retained DOM-local state,
and desktop/foldable/phone presentation.
