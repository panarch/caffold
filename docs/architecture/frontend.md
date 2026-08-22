# Frontend Architecture

The frontend is a small Light-DOM Web Component application. Application
navigation enters one Task workspace. Its Tasks Detail layout binds a Task or
Section subject and owns the shared Integrated Review, Git, and GitHub
surfaces; subject-specific work stays below the matching Task or Section
layout.

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

An expanded non-page module uses a same-stem file and directory pair. The root
`name.js` is its public feature entry point; `name/` owns private model and
lifecycle implementation, plus a `components/` directory for Web Components
mounted by the feature's outside owner. Non-visual consumers import only the
explicit public API from `name.js`. A mounting owner imports the component path
directly so custom-element registration remains visible. Unlike page ownership
directories, an expanded module directory contains no `page.js` or `layout.js`.

## Routed hierarchy

```text
caffold-app-shell
|-- caffold-task-workspace
    |-- Task navigator
    |-- Tasks
    |   |-- Global New Task
    |   |   `-- Directory Picker
    |   `-- Detail Layout
    |       |-- Task subject
    |       |   `-- Conversation
    |       |-- Section subject
    |       |   `-- Fixed-context New Task
    |       |-- Integrated Review
    |       |-- Git
    |       |   |-- Compare
    |       |   `-- Log
    |       `-- GitHub
    |           |-- Issues
    |           `-- Pull Requests
    `-- Settings
|-- caffold-build-mismatch-alert
`-- caffold-update-dialog
```

Task Workspace stays mounted while Tasks switches among home, Global New, Task
Detail, and Section Detail. A Task `threadId` or Managed Section ID is the
subject identity throughout shared child transitions.

## App Shell

`frontend/pages/layout.js` defines `caffold-app-shell`. It owns only
application-lifetime coordination:

- bootstrap health and initial-path loading;
- parsing and forwarding top-level routes;
- Navigation API and History fallback integration;
- foreground/resume recovery coordination;
- settings application;
- build-update presentation.

The app shell owns one `ForegroundRecoveryLifecycle` behind the public
`foreground-recovery.js` entry point. It normalizes browser activation and
connectivity observations into one idempotent recovery request. Raw listener
wiring, the finite control model, and effectful lifecycle work remain private
under that same-stem boundary; consumers receive semantic operations and an
already derived presentation rather than private nodes, events, or selectors.

The control graph separates attachment and visibility, ordered recovery work,
bounded retry, known offline state, and exhausted recovery. Every node change
passes through one complete transition table. Activation intent, diagnostic
trigger, retry attempt, and in-flight generation remain control data instead of
duplicating graph nodes. Hidden observations stay pending without starting
HTTP or SSE work, overlapping visible observations share the current
generation, and retry stops on success, hide, disconnect, or budget exhaustion.

A visible `offline` signal is a pause, not a recovery attempt. It invalidates
in-flight foreground work, releases Task transports, stops retry timers, and
keeps the current workspace useful behind the shared no-network notice. No
HTTP, SSE, or backoff polling restarts on its own. A later visible lifecycle or
connectivity hint may re-enter the ordinary recovery sequence. A fresh
same-origin API response or current EventSource open is stronger reachability
evidence and re-enters that same sequence even when the browser omits an
`online` edge. The evidence never jumps directly to ready: status, list, and
detail still validate through the current foreground generation.

Browser-specific connectivity APIs such as `navigator.connection` are optional
hints rather than a second connectivity owner. Definite offline state takes the
same pause path, restoration requests the same canonical recovery, and
unsupported browsers continue through standard lifecycle and transport paths.
Every completion still has to match the active recovery generation.

Foreground recovery refreshes the workspace's canonical backend status first,
after which the Tasks page asks its navigator and selected detail to reconcile
their separately owned transports. Parents call public child methods; the app
shell does not inspect Task transport internals. Async completions must still
match both the foreground generation and the active route.

The app shell also owns the single viewport-level recovery notice. Task list
and detail expose whether an active transport needs recovery; they do not render
independent connection Retry controls. Initial foreground validation remains
silent and preserves canonical Task status chips. The notice appears only after
a real transport failure or foreground backoff. Once the retry budget is
exhausted it exposes one Retry action that re-enters the same status,
pending-route, list, and detail recovery operation. Known offline state uses
the same notice without a spinner or Retry action. Initial bootstrap and
domain-specific requests such as older-history loading retain their separately
scoped failure UI.

The app shell owns one `PwaUpdateLifecycle` instance. That lifecycle is the
single owner of service-worker registration and build handoff, and publishes
`checking`, `ready`, or `settled` state. The shell uses the same snapshot for
the update dialog and About Caffold; presentation components emit user intent
without inspecting service-worker state.

A replacement is `ready` only after its complete shell cache is available, and
Reload explicitly transitions to that prepared generation. The viewport-fixed
`caffold-build-mismatch-alert` remains a separate exceptional diagnostic and
appears only when UI and server builds differ after the lifecycle is `settled`.

The private update-handoff graph contains `detached`, `idle`, `activating`,
`claiming`, and `applying`. Prepared-worker metadata, registration and
update requests, server diagnostics, and the public checking/ready/settled
presentation remain orthogonal control data. An explicit update action selects
one target generation in the current page while that worker moves through
waiting, activating, active, and temporarily unowned registration observations.
A later prepared generation replaces that target without accepting stale
controller completion.

The browser's current registration and controller are authoritative for worker
phase. The worker's custom controlled message only requests another controller
reconciliation. Once the intended generation controls the old document, the
graph enters `applying` and requests navigation. It remains retryable on explicit
Reload while the old document remains alive; a later page-resume rechecks worker
phase but does not repeat an already attempted navigation. The handoff target is
deliberately page-local and is not persisted. A discarded page reconstructs
update availability from the server and browser registration, then allows the
user to request Reload again. Shell-cache pruning remains disabled
until no handoff target or prepared generation remains and the active worker
controls the page. About Caffold copy diagnostics includes the handoff node,
target and observed worker build IDs, and navigation-attempt count.

The service worker also validates terminal Web Push payloads, presents system
notifications in foreground and background states, and limits notification
click navigation to canonical same-origin Task routes. It does not infer Task
completion or subscription state; those remain backend and Settings lifecycle
responsibilities. When an already displayed matching Task client is focused,
the worker posts its validated route to that page; the page applies it if needed
and uses the same foreground recovery entrypoint. Navigated and newly opened
documents continue through normal bootstrap.

All known routes are forwarded to `caffold-task-workspace`. Tasks resolves the
active Task or Section subject; its common Detail owns shared child instances
and context binding. Git and GitHub own repository reconciliation and
domain-specific Back and Refresh behavior after activation.

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

The workspace also owns the one browser lifecycle for backend-owned Codex
readiness requests and forwards a request snapshot to Tasks, Settings, and the
workspace navigation. That snapshot keeps frontend request phase (`checking`,
`loaded`, or `failed`) separate from the canonical backend status payload. A
refresh may retain the previous status while the request is checking.

The snapshot carries two separate blocking axes, consumed as derived
presentation rather than routing state. Task-store readiness gates every Task
operation — it is the shared store — and alone presents the takeover recovery
surface while it blocks. Codex readiness gates only Codex surfaces: the setup
card renders beside the New Task surface, and routes always open — a Task's
conversation stays readable from the store while its agent is unready. No
surface pre-guesses an operation's fate from the snapshot: a Codex-run
operation tried while Codex is unready is refused by the server, and the
refusal is the answer shown. Claude surfaces never consult either Codex axis.
Settings remains routable. Retry refreshes the canonical diagnosis; frontend
code does not compare versions or classify stderr.

One workspace-scoped Codex status lifecycle owns that request, the confirmed
runtime-restart mutation, its request generations, and the post-restart status
refresh. Tasks and Settings emit the same restart intent and render its shared
request snapshot. The workspace mounts one long-lived native confirmation
dialog. A successful restart response does not release the Codex surfaces it
holds; only the refreshed backend readiness snapshot can do that.

This request ownership is scoped to the mounted browser component tree. It is
not exclusive ownership of Codex settings or actions across Caffold clients.
The macOS wrapper may consume the same backend status and capability APIs for a
native compact surface. The backend remains the shared owner of meaning and
mutation semantics; neither client recreates those rules locally.

## Tasks Layout and Detail Layout

`caffold-tasks-page` owns the home, Global New, Task Detail, and Section Detail
choice and connects the Task navigator. Task routes use their path schema. A
Section route is a root query route whose Managed Section ID is resolved from
the navigator projection; a missing Section replaces the destination with Tasks
home.

`caffold-detail-layout` owns:

- the active Task or Section subject identity;
- shared Summary actions and the subject-aware view switch;
- shared Integrated Review, Git, and GitHub child activation;
- translation between shared child intents and Task or Section routes;
- a bounded Integrated Review cache keyed by subject identity.

`caffold-task-detail` is the canonical owner of the selected Task
snapshot and live event application, Conversation, Command dialog, follow-up
Composer, and Task mutations. It publishes a subject snapshot upward; it does
not mount Integrated Review, Git, GitHub, or their Summary controls.

The adjacent task-scoped Detail session owns snapshot acquisition while Detail
keeps canonical Task, event, revision, and rendering state.

The session phases are inactive, waiting for bootstrap, waiting for readable
sync, streaming, REST fallback, and unavailable. It alone transitions the
active attempt, while shared `tasks/stream.js` owns `EventSource` connection
generations, timers, and transport state. Cursor pagination stays outside the
session, and a Task switch replaces the attempt before a late response can
update Detail. The wire-level bootstrap, revision, and fallback contract is
defined in [Codex App Server](codex-app-server.md#frontend-ownership).

`caffold-section-detail` owns fixed-context Task creation for one Section.
Switching Section context replaces its Task Create instance. The shared Task
Create and cwd contracts are defined in
[New Task and directories](#new-task-and-directories).

A Task deep route is prepared before canonical Task loading. Shared repository
surfaces activate only after the Task snapshot is available. Section repository
capability comes from the local Section projection and needs no backend Section
detail endpoint. The selected Section follows projection changes to its logical
path and repository capability. Same-subject surface switches retain safe local
DOM state; subject or repository-context changes hard-rebind external context.
If a Section loses repository capability, an active repository surface returns
to its fixed-context New Task route.

The browser reads only `readiness.state`, `blocksTaskOperations`, and
diagnostic facts supplied by the backend. The compact workspace Settings action
reflects that state and enters Codex Settings directly while setup is required.

Same-Task switches do not interrupt or recreate the Task stream. A Task switch
invalidates Task generations before the new Task can render. Task and Section
Summary components send intents upward and do not own repository requests.

## Detail children

### Conversation

Conversation owns transcript rendering, disclosure and scroll state, and the
follow-up Composer. It exists only under the Task subject. Stateful children
are preserved by Task identity through incremental shell updates. Moving from
Tasks to Settings ends active editing and transport work without destroying a
retained Composer draft.

### Integrated Review

`caffold-task-review` is the sole owner of Working Tree and current Task Branch
review. It owns:

- scope, navigator, viewer, base ref, and selected path;
- Git status, branch refs/compare, file, diff, and source requests;
- one root watch while active;
- Changes/Files and Diff/Source reconciliation;
- pane width, disclosure, selection, and scroll.

Integrated Review uses a bounded cache keyed by explicit Task or Section
identity. Disconnecting an inactive entry invalidates its requests and releases
its root watch. Selected path and current-branch root watch remain unique to
that cached review instance.

### Git

`caffold-task-git-layout` is a direct shared Detail child under the pathless
`tasks/(detail)/(git)` directory. It owns arbitrary Compare and bounded Log modes,
repository ref status, canonical reconciliation, domain-local routes, request
generations, and a refs-only watch while active. Log owns an explicit Fetch
request that updates the selected remote-tracking default branch and publishes
its relationship to the current checkout; activation and watch invalidation do
not start that request, and Fetch does not alter the active watch lifetime.

It does not own Working Tree status, current Task Branch comparison, or a Diff
mode. Compare and Log leaves retain their own list, commit, file, diff, and
source state.

### GitHub

`caffold-task-github-layout` is a direct shared Detail child under
`tasks/(detail)/(github)`. It owns GitHub availability, Issues/Pulls mode, route-local
list/detail/files selection, canonical reconciliation, nested request
generations, domain-local Back intents, and the shared GitHub Task Start dialog.
Issue and Pull Request detail emit the same source-neutral intent with canonical
payloads; the GitHub root owns dialog reset/deactivation, and the dialog owns
Task creation and its pending/error/focus lifecycle. Dialog-local GitHub Issue
and Pull Request source children own their respective ref preparation, prompt
construction, request invalidation, DOM, and CSS.

GitHub performs no polling and creates no filesystem watcher. Activation,
meaningful re-entry, Retry, and explicit actions request current canonical
state. Hidden DOM may remain visible when reactivated, but it is never treated
as proof that remote data is current.

### Activation contract

Connection and activation are separate concepts for shared Detail domain children.

- `prepareRoute(route)` selects DOM and chrome without APIs.
- `activate(route, snapshot)` binds canonical Task or Section repository context and
  performs a fresh reconciliation.
- `deactivate()` invalidates requests and releases watches/timers while keeping
  safe DOM-local state.
- disconnection/destroy performs deactivation plus instance cleanup.

Git and GitHub instances stay mounted in hidden shared sibling slots while the
Detail layout is connected. A subject or repository-context change is a hard
data-rebind boundary even though the outer surface may stay selected.

Every async writer checks an owner generation, route identity, context identity,
or nested request token. A late response cannot reactivate an inactive child,
write into a new Task, or restore a stale route.

## Data flow

Parent-to-child data crosses as snapshots or public methods. Child actions
cross upward as intents.

```text
Task snapshot or local Section projection
                  |
                  v
          Detail Layout --context snapshot--> active child
                  ^                              |
                  `-------- route intent --------'
```

No global store coordinates this hierarchy. Canonical Task, Git, GitHub, and
filesystem projections remain independent because their external sources and
revision lifetimes are independent.

## Route ownership

`frontend/navigation-routes.js` owns the pure schema and metadata. App Shell
forwards; Task Workspace selects Tasks/Settings; Tasks selects its subject; the
common Detail layout selects the subject or shared child; Git and GitHub select
their domain-local modes and leaves.

Task-scoped Git/GitHub routes always carry `threadId` and never route `cwd`.
Section routes carry a Managed Section ID in the root query and resolve
repository context from the navigator projection. See
[Navigation Routing](navigation.md) for exact route and Back contracts.

## New Task and directories

Global New owns its editable cwd and Directory Picker. Section New owns a fixed
cwd and exposes no picker. Both mount the same Tasks-owned Task Create behavior,
which owns the Composer, request, and error lifecycle. Only Global New represents
its selected directory in `/tasks/new?cwd=...`.

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
Conversation, and Code scales. Settings Codex renders the shared status and
runtime-restart request snapshots, repair guidance, diagnostics, and intents
for Refresh or restart. The workspace Codex status lifecycle remains active
across Tasks and Settings route changes and owns the HTTP request generations.

Remote Access owns a route-scoped Tailscale request lifecycle. Server responses
are the only writers of canonical status, `canManage`, diagnostics, and the
Tailnet URL. The browser retains the last canonical status while tracking its
request phase, retry intent, and transport error separately. During a Serve
mutation it starts the constrained PUT and polls status concurrently so only a
server-published configuring or disabling state appears as domain progress.

The lifecycle nodes and complete allowed edges are:

- `inactive -> refreshing`;
- `idle -> refreshing | mutating | inactive`;
- `refreshing -> idle | polling | inactive`;
- `mutating -> idle | polling | inactive`; and
- `polling -> refreshing | inactive`.

`refreshing` owns one status GET, `mutating` owns one Serve PUT plus periodic
status polling, and `polling` owns the timer for canonical reconciliation.
Entering `inactive` invalidates the request generation and clears its timer.
Transport failure preserves the last canonical status and publishes a separate
retryable request error instead of inventing a Tailscale state or management
capability. That retained snapshot remains visible but cannot authorize a Serve
control until a later server response makes it current again. The page retains
one DOM and renders the ready URL into text and link actions. Its QR image uses
the same canonical URL as input to the server's constrained SVG resource; the
browser owns when and where that derived image is presented.

## Physical hierarchy

Relevant source ownership follows the routed hierarchy:

```text
frontend/
|-- navigation-routes.js
|-- pages/
|   |-- layout.js
|   |-- foreground-recovery.js
|   |-- foreground-recovery/...
|   |-- pwa-update-lifecycle.js
|   |-- pwa-update-lifecycle/...
|   `-- (task-workspace)/
|       |-- layout.js
|       |-- codex-status.js
|       |-- codex-status/...
|       |-- settings/...
|       `-- tasks/
|           |-- layout.js
|           |-- stream.js
|           |-- new/
|           |   |-- page.js
|           |   `-- components/directory-picker.js
|           |-- recovery/page.js
|           |-- components/
|           |   |-- navigator.js
|           |   |-- active-task-list.js
|           |   |-- active-task-list/
|           |   |   `-- components/
|           |   |       |-- section.js
|           |   |       `-- section/components/row.js
|           |   |-- task-create.js
|           |   `-- composer.js
|           `-- (detail)/
|               |-- layout.js
|               |-- components/
|               |   |-- detail-view-switch.js
|               |   |-- git-menu.js
|               |   `-- github-menu.js
|               |-- (task)/
|               |   |-- layout.js
|               |   |-- session.js
|               |   `-- components/
|               |       |-- summary.js
|               |       |-- conversation.js
|               |       |-- command-dialog.js
|               |       `-- conversation/...
|               |-- (section)/
|               |   |-- layout.js
|               |   `-- components/
|               |       |-- github-shortcuts.js
|               |       `-- summary.js
|               |-- (review)/layout.js
|               |-- (git)/
|               |   |-- layout.js
|               |   |-- compare/page.js
|               |   `-- (log)/...
|               `-- (github)/
|                   |-- layout.js
|                   |-- components/task-start-dialog.js
|                   |-- (issues)/...
|                   `-- (pulls)/...
`-- components/
    |-- file-navigator.js
    |-- file-viewer.js
    |-- git-compare-browser.js
    `-- review-panel-resizer.js
```

Parenthesized directories are pathless ownership nodes. A directory with its
own `page.js`, such as Global New or Git Compare, remains a leaf surface.
Routed `page.js` and `layout.js` files register the page or layout owner they
represent; child Web Components use the nearest `components/` namespace. Names
describe the current owner and role: Task-only Conversation and Command stay
below `(task)`; shared review and repository domains are siblings below
`(detail)`; reusable leaves stay outside `pages`.

Within the Task navigator, `caffold-task-navigator` owns the exclusive Task or
Section reorder mode selection. `caffold-active-task-list` owns the canonical
active projection and serialized local reorder mutations. Each
`caffold-active-task-section` owns its Section header and Task list, while each
private `caffold-active-task-row` owns one Task row's selection and reorder
interaction. Section and row components raise semantic intents to their parent
instead of acquiring list API or persistence ownership.

## Styling and assets

Components render in Light DOM, so CSS remains one cascade. Each stylesheet
must scope internal selectors below the owning custom element. A parent may
size or hide a child host, but descendant styling belongs to the child.

Every production JavaScript/CSS asset must be registered consistently in:

- module imports;
- `frontend/styles.css`;
- `frontend/service-worker.js`;
- `caffold/src/static_assets.rs`;
- static asset and CSS ownership tests.

The service-worker cache and Rust static-asset table are exact manifests of the
assets imported by the active application hierarchy.

## Test ownership

Focused Node unit tests live beside the production module that owns their
behavior, using the same stem and a `.test.js` suffix. Internal tests import
their owning module directly; public feature entry points do not expose private
APIs for tests.

Frontend contracts — policy, complete inventories, and browser-test
infrastructure — live in `frontend/tests/contracts/`. Playwright regression
tests live under `frontend/tests/e2e/`. Contracts on another owner's boundary
belong to that owner, not here.

Colocated tests are source files for Node only. Production JavaScript scans,
the production static import graph, the service-worker asset inventory, and the
Rust static-asset table exclude every `*.test.js` file.

Reusable file/source/diff/image behavior is covered through its active Task
owners. Browser coverage must exercise direct entry/reload, Back and browser
history, child switching, Task switching during pending work, activation
freshness, stale response rejection, watch cleanup, retained DOM-local state,
and desktop/foldable/phone presentation.
