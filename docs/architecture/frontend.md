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
    |       |   |-- Conversation
    |       |   |-- Current plan
    |       |   `-- Follow-up Composer
    |       |-- Section subject
    |       |   |-- Fixed-context New Task
    |       |   `-- Existing-conversation shortcuts
    |       |-- Integrated Review
    |       |-- Git
    |       |   |-- Compare
    |       |   `-- Log
    |       `-- GitHub
    |           |-- Issues
    |           `-- Pull Requests
    |-- Workspace Action Hint dialog
    |-- Workspace Scroll selector
    |-- Workspace Scroll HUD
    `-- Settings
        `-- Keyboard
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
target and observed worker build IDs, and navigation-attempt count. Invoking
Copy diagnostics also requests the existing Codex proxy's on-demand MCP
snapshot and appends its runtime generation, app-server version, and per-thread
server runtime/authentication states. Opening About does not make that request,
and an unavailable MCP snapshot is recorded without preventing the build and
update diagnostics from being copied.

The service worker also validates finished-turn and waiting-Task Web Push
payloads, presents system notifications in foreground and background states, and
limits notification click navigation to canonical same-origin Task routes. It
does not infer Task completion, a pending approval, or subscription state; those
remain backend and Settings lifecycle responsibilities. When an already displayed matching Task client is focused,
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
- the one physical live-update connection for this browser tab;
- the one keyboard-navigation coordinator, Action Hint dialog, Scroll selector,
  and workspace-local Scroll HUD;
- forwarding routes to Tasks or Settings.

The workspace consumes the semantic presentation snapshot published by Tasks:
`reading` or `code`, current Task target, and Task-detail child. It does not
query nested Git/GitHub DOM or read their private state.

Reading surfaces keep the Task navigator on desktop. Code surfaces use the full
workspace width. Foldable and phone presentation is owned by the same
master/detail layout system.

The workspace keyboard-navigation coordinator is the only document-level key
owner. It derives normal versus editing state from focus and composition, and
stores at most one mutually exclusive Action Hint, Scroll selection, or active
Scroll mode. Keyboard navigation being disabled closes the stored mode and
leaves both `F` and `S` unhandled. Route changes, disconnect, competing native
overlay ownership, and composition changes run through the same cleanup
authority.

Workspace, registered modal, and registered popover owners publish one thin
keyboard-navigation context identified by stable ID, ownership kind, and exact
retained root. Action Hint and Scroll remain separate optional capabilities on
that context. The same fresh context resolution serves both `F` and `S`: one
open registered popover wins over the workspace, including when it is an exact
descendant of the currently open product modal; otherwise an unknown or
unrelated open overlay, duplicate root, or ambiguous popover rejects entry. The
coordinator reads native
`:popover-open` and `dialog:modal` state only to validate ownership. It does not
infer actions or scrollports from overlay descendants.

The coordinator enters Action Hint mode from a non-editing `F` key and
pulls one-shot semantic descriptors from explicitly participating owners.
Each participating component provides its retained native control, stable
semantic identity, action meaning, accessible name, anchor, and clip
dependencies. This includes Workspace and Settings navigation and page
buttons; Task and Section selection; archived-list, recovery, and Codex
readiness buttons; Composer Model, Permission, Prompt, attachment, voice,
cancel, submit, and interrupt actions; Conversation retry, image-preview, and
approval actions; Section Fork; Current Plan document openers; and direct
Integrated Review, Git, GitHub, file-navigation, and file-viewer actions. Git
declares Refresh, while GitHub detail declares Start Task and Pull Files.
Activation reuses each owner's existing native button click, form, or
product-intent path.

Product-owned disclosure uses the same one-shot flow through a distinct
`disclosure.toggle` action and `disclosure` control kind. The shared File Tree
declares only expandable directory buttons; non-expandable Directory Picker
rows keep their existing navigation meaning. Work Details declares its root
summary, active Command declares its summary while terminal Command keeps View
output, Conversation declares only the exact Thinking summaries it rendered,
and Git Log declares its commit-body toggle. Target identity stays stable
across open state while the accessible Hint label changes between Expand and
Collapse. The Hint overlay closes before the retained summary or button
receives focus and its existing click path. Opening or closing never starts a
second Hint session; the user presses `F` again against the new visible state.

Custom children retain their own action knowledge. Work Details merges its own
summary with its direct retained children. Command declares active disclosure
or terminal View output from the same provider, Markdown Code Block declares
Wrap and Copy, and Conversation merges those public scopes through its
retained Assistant Message, Markdown, and Work Details children. Reusable
controls such as the segmented control, file tree, pagination, file navigator,
and file viewer expose public scope providers; their screen owner supplies the
semantic action and scope context. Ancestors never discover these actions by
scanning descendant buttons, `summary` elements, or `aria-expanded`.

Checkboxes, radios, ranges, general native selects, external or Markdown
links, arbitrary Markdown or third-party `summary` disclosures, and reorder
handles remain outside Action Hint. A native summary participates only when its
product component explicitly owns and declares that disclosure. Explicitly
registered dialog selects and textboxes keep their existing owner-specific
behavior. Popover and dialog openers are ordinary workspace actions, but after
either opens the user presses `F` again to enter the new retained context; the
coordinator never predicts or automatically hands off to it. File details
deliberately declares no internal Action Hint target.

Provider collection is hierarchical: each layout merges its own actions with
only its active direct child scopes through `action-hint-scope.js`. Ancestors
do not enumerate or reach through descendant DOM. A retained pane with no
layout box is omitted before merge, so its hidden mutation and scroll
dependencies cannot invalidate the visible pane's session.

The nine registered Task Workspace product dialogs follow the same owner-first
contract: Codex restart, Claude restart, archived-task deletion, image preview,
directory picker, Conversation fork, command output, Current Plan document,
and GitHub Task Start. Every currently visible and enabled button has an owner
declaration, without semantic deduplication, and controls owned by a direct
child compose through the same public scope interface. Fork additionally
declares its Thread-ID textbox, while the Task Start issue child declares its
native Base branch select. Textbox activation only focuses the retained input.
Select activation focuses and calls native `showPicker()` synchronously in the
original trusted key stack, falling back to focus only when that API is absent
or throws; native options and change handling remain with the browser and
product state owners. These registrations do not create a generic dialog
registry or DOM discovery path. The App Shell update dialog is outside this
Task Workspace context set and retains native keyboard ownership.

The controller validates every action and control kind against a closed central
policy. Task selection retains generated `T*` codes and New Task, Model, and
Prompt retain `N`, `M`, and `P`. All other supported actions receive
same-width automatic codes in `ASDFGHJKLQWERTYUIOPZXCVBNM` order after visual
sorting; the `N`, `M`, `P`, and `T` prefix namespaces remain reserved. The full
result must be unique and prefix-free. A session freezes target identity,
binding, and code, intersects anchors directly with the visual viewport and
every owning scrollport, and renders buttons in one viewport-sized native
modal dialog. Scroll, viewport, route, target topology, geometry,
actionability, or competing modal/popover ownership closes the session. A
presentation-only accessible-name change refreshes the existing badge without
changing its code, while equivalent presentation patches do not retarget it.
A partial prefix keeps Hint open while at least one frozen code still
matches. A character that leaves no match is consumed and closes Hint while
restoring its invoking focus; Scroll selection retains its separate input
policy.

Each registered popover retains a small shared presentation host containing its
own Action Hint dialog and Scroll HUD. Dynamic Model and Permission rendering
replaces only an option-content child, preserving the popover root and
presentation identity. If a frozen option control is replaced, the current
Hint session closes even when its semantic value is unchanged; a later `F`
collects a fresh binding. Product owners continue to own native open, light
dismiss, deactivation, and focus-return lifecycle, while the coordinator only
cleans its current keyboard session.

Each registered product dialog likewise retains one shared presentation host
as a direct child of its exact native `<dialog>`. The host owns only that
context's Action Hint dialog and Scroll HUD; it neither discovers product
controls nor owns product open, close, return-value, submission, mutation, or
external focus-return behavior. Product content patches preserve the dialog,
presentation, and declared control or scrollport identities unless a real
topology change requires a fresh session.

`normal` and `editing` are derived from current focus and composition; `hint`,
`scroll-selecting`, and `scroll-active` are the stored keyboard-navigation
nodes. The complete node edges are
`normal -> normal | editing | hint | scroll-selecting | scroll-active`,
`editing -> editing | normal`, `hint -> hint | normal`,
`scroll-selecting -> scroll-selecting | scroll-active | normal`, and
`scroll-active -> scroll-active | normal`. One transition table gates session
creation, input, cancel, selection, commands, and activation close. Closing a
stored mode releases its scoped listeners and observers before an existing
route, model popover, document dialog, or prompt-focus owner takes control.
Composition and unregistered modal or popover owners keep their own key and
Escape ownership.

An editable inside a registered modal may publish one exact same-modal Editing
escape destination. A non-composing `Escape` received by the coordinator ends
Editing by focusing that retained control without changing the input value or
closing the product dialog; a following `Escape` is left to the native dialog
close path. An open browser-native picker may consume its own `Escape` before
the document receives it. Fork and Task Start use their own Cancel button for
this handoff. Missing, stale, hidden, disabled, outside-root, composing, or
unregistered destinations do not cause the coordinator to infer a fallback or
consume the key.

Scroll mode enters from a non-editing `S` key and uses only vertical surfaces
explicitly published through `scroll-scope.js`; it does not discover generic
scrollable DOM. The reusable contract lives at `frontend/scroll-scope.js` so
page and shared-component owners use one empty, merge, layout, and vertical
overflow policy.

Settings publishes its navigator plus the exact active page surface. Tasks
publishes its navigator plus the visible New, Recovery, Codex-readiness,
Section, or Task Detail child. Detail delegates to the exact active
Conversation, Integrated Review, Git, or GitHub domain. Integrated Review, Git
Compare and Commit, and GitHub Pull Files merge their simultaneously visible
tree and viewer leaves on desktop and omit the pane without a layout box on
single-pane layouts. File tree, source, diff, Markdown preview, image stage,
and scrollable notice owners publish their actual retained leaf rather than
having a screen parent reach into their DOM.

Git Log, GitHub Issue and Pull lists, GitHub Issue Markdown or raw body, and
Pull Request detail publish their exact vertical scrollports. The GitHub
Markdown Shadow-DOM component publishes its scrolling host; the coordinator
does not inspect its shadow descendants. Five registered product dialogs
publish one exact vertical surface each: directory picker `.file-tree-scroll`,
Conversation fork body, command-output body, Current Plan Markdown preview,
and Task Start body. Each registered popover publishes only its own root as an
optional surface. Actual overflow is always required, and no CSS overflow is
manufactured for short pages, dialogs, or menus. Composer textareas, native
editable controls, horizontal code/table surfaces, and other undeclared
scrollports remain with their native owner.

Containers merge only active direct-child scopes. Workspace, an open
registered modal, and an open registered popover are exclusive interaction
contexts, so overlay scrolling never shares a selection set with background
workspace surfaces.

Eligibility directly checks the bound element, vertical overflow, layout box,
visual viewport, clip roots, and owner revalidation. One eligible surface
enters active mode directly. Multiple workspace surfaces receive temporary
same-width `ASDFGHJKLQWERTYUIOPZXCVBNM` codes in visual order and appear in a
native modal selector; multiple surfaces in a modal context are rejected.
The selector session freezes the context, surface IDs, element bindings,
geometry, and codes. Scroll, viewport, zoom, geometry, visibility, overflow,
topology, route, or context changes close that session instead of reallocating
or retargeting it.

Active Scroll mode sends `J/K` by 10 percent and `D/U` by 50 percent of the
selected scrollport height, clamps immediately at its boundaries, and accepts
key repeat without chaining into a parent or the window. `Escape` closes only
Scroll mode. A non-repeated, non-composing `F` without Ctrl, Alt, or Meta first
closes active Scroll mode and releases its scoped observers, then captures a
fresh Action Hint snapshot in the current context. A context with no eligible
action leaves no stored keyboard mode. Scroll selection continues to treat `F`
as a possible surface code rather than switching modes. Active revalidation
preserves the exact context, surface ID, and element binding; label or layout
changes on that binding reposition its HUD, while loss of visibility, overflow,
or ownership closes the mode. The reusable non-interactive HUD and outline are
mounted by the active context itself: the workspace owns one for Task list or
Conversation, while each registered product dialog or popover owns one inside
its retained root. Native scroll events, focus, Conversation anchoring, popover
light dismiss, and product-dialog refresh/close lifecycle remain owned by those
components.

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

The adjacent workspace-scoped live-update owner keeps one physical EventSource
while the document is visible and injects logical Task List, Task Detail, and
Watch capabilities into their existing domain owners. Task versus Settings
navigation does not replace that connection. Task changes replace only the Task
Detail generation, and independently active filesystem scopes remain separate
logical Watch subscriptions. See [Live Updates](live-updates.md) for the wire,
ordering, and recovery contract.

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
snapshot and live event application, Conversation, Command dialog, current-plan
strip, follow-up Composer, and Task mutations. It publishes a subject snapshot
upward; it does not mount Integrated Review, Git, GitHub, or their Summary
controls.

For keyboard navigation, each of these layout owners merges only the public
scope of the child it currently presents. `caffold-tasks-page` composes Task
Navigator with the visible New, Recovery, readiness, or Detail owner;
setup-beside is an independent sibling when it is actually visible. The common
Detail layout delegates Action and Scroll scopes to Conversation, Section New,
Integrated Review, Git, or GitHub without rebuilding child descriptors.

One pending prompt per Task belongs to Detail, whether it originated in the
Task Composer or was transferred from a New Task or GitHub creation surface.
For Global and Section New, Task Create gives the persistent Tasks page an
exact submission snapshot before that page starts creation. The page owns the
creation request and snapshot across Task and Section route changes. The source
Composer retains only its local in-flight state for pending presentation and
definitive-rejection rollback; it cannot issue a second request. When the empty
Task answer arrives, the page hands its snapshot to Detail. Detail then owns
the text, attachments, options, optimistic entry, and retry state. Creation and
prompt submission are separate HTTP requests, while this in-page handoff
preserves the one-action experience and prevents a duplicate request between
them.

Detail shows every prompt optimistically. The prompt response returns the
user-item identity established by the agent adapter; only a backend Detail or
live stream event carrying that exact item identity retires the optimistic
entry. Event content is presentation, not submission identity, so an equal
prompt from another client cannot answer for it, and an exact-identity event
that races ahead of the HTTP response waits for the response to identify it.
The first message has no exception: Task creation carries title-source metadata
but no submitted conversation item, and the later ordinary prompt response
supplies its accepted identity.

When the identity is established, the accepted event inherits that browser's
existing optimistic position until a Detail snapshot supplies the
provider-history position; confirming one item must not make it jump behind an
answer already on screen.

If transport fails before a prompt response supplies its identity, a later
equal provider-projected message does not erase that outcome-unknown
submission: there is no evidence they are one event, so both remain visible. A
definitive rejection restores the owning Composer; no first-turn-specific
failure event or content-based recovery path exists.

Detail receives the backend's already-reconciled conversation projection. The
provider evidence, history/live authority, exact-identity requirement, and
publication contract are owned by
[Agent Runtimes](agent-runtimes.md#conversation-and-event-ownership). The
browser does not compare provider payloads, message text, timestamps, or
arrival order to reconstruct those decisions.

The backend publishes that projection through a Task-scoped `eventRevision`.
Each Task-event delta carries the revision captured when it entered the
projection, while each Detail snapshot carries the watermark covering its
events. For conversation events, Detail applies snapshots at the current or a
newer watermark and applies only strictly newer deltas. Deltas buffered before
a readable bootstrap pass through the same check, so a snapshot cannot be
followed by a stale intermediate render. A new stream bootstrap resets this
process-local baseline for its connection generation. The separate Task
session `revision` orders canonical Task reads and metadata; it does not
substitute for conversation publication order.

A complete current-page Detail snapshot owns projection membership. A
`historyLoading` snapshot owns records under the exact identities it contains
but retains absent readable records until a complete snapshot arrives. Older
cursor pages and optimistic submissions remain separate visible layers rather
than inputs to source arbitration. Within the current projection, a delta is a
backend-authored patch under exact identity and a snapshot is a
backend-authored replacement.

For canonical Task events, `position.anchorMs` places an event group in the
projected timeline, and `position.index` orders events sharing that anchor.
Both are backend-owned position rather than display time. A browser-created
optimistic entry carries only provisional request-state position until exact
identity handoff and Detail reconciliation replace it with canonical position.
If a malformed event has no readable position, the browser preserves the
projection order it received instead of manufacturing an anchor or update time.
`observedMs` is the direct per-event time shown by Conversation and Work
details, including a provider-history item time when one exists; `null`
suppresses a timestamp when history supplied order but no individual time.
Conversation keys entries by exact identity and versions them from rendered
content, not projection revision or position. A canonical reorder therefore
moves an existing entry instead of replacing its DOM and state.

The adjacent task-scoped Detail session owns snapshot acquisition while Detail
keeps the canonical Task, conversation projection, Task-session and
conversation-publication revision baselines, and rendering cache.

The session phases are inactive, waiting for bootstrap, waiting for readable
sync, streaming, REST fallback, and unavailable. It alone transitions the
active attempt, while shared `tasks/stream.js` owns logical subscription
generations, bootstrap timers, reconciliation, and transport presentation. The
workspace live-update owner separately owns the physical EventSource. Cursor
pagination stays outside the session, and a Task switch replaces the attempt
before a late response can update Detail. Provider transport and history
acquisition remain in their native architecture.

`caffold-section-detail` owns fixed-context Task creation and
existing-conversation shortcuts for one Section. Switching Section context
replaces its Task Create instance and closes any read-only source preview. The
shared Task Create and cwd contracts are defined in
[New Task and directories](#new-task-and-directories).

`caffold-section-conversation-shortcuts` derives only capability presentation
from the workspace Codex-status snapshot. It remains hidden while capability
is unknown, exposes one provider-specific Codex row once known, and gives a
blocked row the backend diagnostic instead of removing it. Its private native
dialog owns Thread-ID input, cancellable preview generations, read-only preview
DOM, fork request state, focus restoration, and the synchronous created-Task
handoff. Input changes invalidate the preview. Preview loading may be cancelled;
once the provider mutation begins, Cancel and native dismissal stay locked
until the request settles.

An external preview whose provider status is `notLoaded` displays **Live status
unavailable** without inferring idle state, but it may still invoke Codex's
native stored-history fork. Idle previews are also forkable. Active,
system-error, and unrecognized statuses keep the action disabled.

The dialog sends the selected Managed Section ID rather than a cwd. The backend
resolves the current Section project root and returns the child placement. The
browser accepts only a distinct child ID placed in that Section, then hands the
Detail response to the existing `caffold:task-created` owner. It does not infer
source ownership, status, cwd, or conversation lineage.

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

Conversation owns transcript rendering, disclosure, and scroll state. Task
Detail owns the follow-up Composer as its stable sibling. Both exist only under
the Task subject and are preserved by Task identity through incremental shell
updates. Moving from Tasks to Settings ends active editing and transport work
without destroying a retained Composer draft.

Conversation also owns its delegated retry, attachment-preview, approval, and
exact rendered Thinking disclosure controls. A custom child owns its own
controls: Command owns its active disclosure or terminal View output, Work
Details owns its root disclosure, and Markdown Code Block owns Wrap and Copy.
Thinking Markdown intentionally remains outside code-block controls. Assistant
Message, Markdown, and Work Details merge only the direct retained children
they mount, so stream patches can invalidate a frozen topology without
introducing a descendant-DOM scan.

### Current plan

`caffold-task-current-plan` is another stable child of Task Detail inside the
stable follow-up Composer dock. The Composer alone determines the dock's flow
height; the current-plan host is positioned above it, so plan presentation does
not move the Composer. Conversation keeps a projection-independent bottom
scroll allowance large enough for the compact floating control. The parent
supplies the selected Task identity, that Task's canonical `cwdPath`, the Task
project root used only for file-path presentation, and the workspace live
updates capability. A missing or unresolved Task cwd deactivates the feature;
the browser does not substitute the project root or initial workspace path for
the filesystem query.

The component reads `GET /api/current-plan?path=...` and owns the resulting
`absent`, `ready`, or `problem` domain projection. It separately owns the
`inactive`, `resolving`, `subscribed`, and `degraded` control graph, request and
context generations, the accepted `watchPath` subscription, and cleanup.
Task/cwd replacement rejects stale completions. Watch events and transport
recovery trigger a fresh REST read instead of changing plan state directly;
the first ready event also rereads once to close the gap between the initial
read and Watch registration. An equivalent projection leaves the DOM alone,
and `absent` has zero layout height.

The Plan and Checklist actions share the feature-private
`caffold-current-plan-document-dialog`. It reads current bytes through the
ordinary Files API whenever a document opens, aborts stale loads, refreshes an
open document on invalidation while preserving scroll when possible, and
restores focus on close. The dialog keeps the Files path as request identity and
uses the shared Task file-path presentation rule to show a project-root-relative
label only when that path is contained by the root. In the ready summary, the
Plan title and checklist progress are the two padded action segments; the
visible `Current plan` label and duplicate document buttons do not form a
second control row. Rendering delegates to the reusable
`caffold-markdown-preview`, whose task-list controls are disabled. Neither
component writes plan files. The product-level file convention belongs to
[Product Workflows](../product/workflows.md#current-plan-documents).

### Integrated Review

`caffold-task-review` is the sole owner of Working Tree and current Task Branch
review. It owns:

- scope, navigator, viewer, base ref, and selected path;
- Git status, branch refs/compare, file, diff, and source requests;
- one root watch while active;
- Changes/Files, Diff, and file-capability-aware Source/Preview reconciliation;
- pane width, disclosure, selection, and scroll.

The Integrated Review owner resolves file-open intents to a path and supported
representation together. Text files support Source, Markdown adds text-only
Preview, raster images use Preview, and SVG supports both its source text and
image Preview. The file viewer owns representation chrome and image rendering,
and delegates Markdown rendering, sanitization, fallback, and local scroll to
the shared `caffold-markdown-preview` component also used by the current-plan
dialog.

The shared file stack owns keyboard surfaces at the same boundaries. File List
merges its Refresh button with the public file-tree selection and directory
disclosure scope, File Navigator forwards caller semantics, and File Viewer
publishes its current source, diff, Markdown, image, or notice leaf plus its
existing Back, Details, Source/Preview, and conditional Refresh actions.
Integrated Review chooses the current navigator and viewer roles and merges
those public scopes; it never queries a child's `.file-tree-scroll`,
`.code-lines`, `.diff-lines`, or directory buttons.

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
which owns the Composer and its creation-rejection presentation. On submit, Task
Create passes an exact submission snapshot to the persistent Tasks page without
removing the Composer's local in-flight state. The page owns the creation
request across Task and Section route changes, so replacing a Section Task
Create cannot abandon the first prompt. When the empty Task answer arrives, the
page gives its snapshot to Detail before navigation; Detail then sends it
through the ordinary prompt API. A definitive creation rejection resolves the
source Composer's existing submission and restores its draft when that surface
is still present. Only Global New represents its selected directory in
`/tasks/new?cwd=...`.

The Section-owned Existing conversations card is adjacent to, but independent
of, Task Create. Its external Codex preview and native fork requests do not
reuse the Composer submission lifecycle. A fork creates an already inherited
zero-prompt child, so the handoff carries no pending submission.

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
Conversation, and Code scales. Keyboard owns the persisted Keyboard navigation
On/Off control; Off closes active Action Hint or Scroll mode and leaves their
keys unhandled. Settings Codex renders the shared status and runtime-restart
request snapshots, repair guidance,
diagnostics, and intents for Refresh or restart. The workspace Codex status
lifecycle remains active across Tasks and Settings route changes and owns the
HTTP request generations.

Each Settings page explicitly provides its current visible native buttons and
exact page scrollport. The Settings workspace merges responsive Back with only
the presented page, and the Task Workspace merges that result with the visible
Settings navigator. Desktop may therefore expose independent navigator and
page Scroll surfaces, while foldable and phone layouts contribute only the pane
with a layout box. Checkbox, radio, range, and select controls keep their native
editing or choice behavior and are not promoted to ordinary button actions.

`caffold-settings-detail-list` renders the label and value rows that Codex,
Claude, and About report. It owns row identity, the placeholder a row shows
before its value is known, and the width at which a label and its value
stack. Each page publishes a row snapshot and owns its wording.

Settings Claude owns a route-scoped diagnostic request for the installed
binary, account, usage windows, and runner. Each block can fail independently
without turning the report into a readiness gate. Its confirmed Restart intent
is forwarded to the workspace's single Claude restart dialog; that mutation
ends every runner-held session, starts a replacement runner, and refreshes the
diagnostic report. The page does not read credentials or call provider APIs
itself.

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
|-- action-hint-scope.js
|-- scroll-scope.js
|-- navigation-routes.js
|-- pages/
|   |-- layout.js
|   |-- foreground-recovery.js
|   |-- foreground-recovery/...
|   |-- pwa-update-lifecycle.js
|   |-- pwa-update-lifecycle/...
|   `-- (task-workspace)/
|       |-- layout.js
|       |-- action-hints.js
|       |-- action-hints/
|       |   |-- control.js
|       |   |-- model.js
|       |   `-- components/dialog.js
|       |-- keyboard-navigation.js
|       |-- keyboard-navigation-context.js
|       |-- keyboard-navigation/
|       |   |-- control.js
|       |   |-- model.js
|       |   `-- components/...
|       |-- components/keyboard-navigation-presentation.js
|       |-- live-updates.js
|       |-- live-updates/lifecycle.js
|       |-- codex-status.js
|       |-- codex-status/...
|       |-- settings/
|       |   |-- keyboard/page.js
|       |   `-- ...
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
|           |   |-- task-turn-options.js
|           |   |-- composer.js
|           |   `-- composer/action-hints.js
|           `-- (detail)/
|               |-- layout.js
|               |-- components/
|               |   |-- git-menu.js
|               |   `-- github-menu.js
|               |-- (task)/
|               |   |-- layout.js
|               |   |-- session.js
|               |   `-- components/
|               |       |-- summary.js
|               |       |-- conversation.js
|               |       |-- command-dialog.js
|               |       |-- current-plan.js
|               |       |-- current-plan/
|               |       |   |-- model.js
|               |       |   `-- components/document-dialog.js
|               |       `-- conversation/...
|               |-- (section)/
|               |   |-- layout.js
|               |   `-- components/
|               |       |-- conversation-shortcuts.js
|               |       |-- conversation-shortcuts/components/fork-dialog.js
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
    |-- file-tree.js
    |-- file-navigator.js
    |-- file-viewer.js
    |-- git-compare-browser.js
    |-- markdown-preview.js
    |-- pagination.js
    |-- review-panel-resizer.js
    `-- segmented-control.js
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

`caffold-segmented-control` is the shared compact single-choice presentation
owner. It patches value-keyed buttons from a choices snapshot, owns pressed
semantics and visual separators, and emits value intent. Task Detail and
Integrated Review retain route state, choice availability, and host placement.

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
