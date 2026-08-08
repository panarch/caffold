# Frontend Structure

> Internal architecture note. This document describes the current frontend
> component hierarchy and ownership boundaries.

Caffold does not use filesystem routes. `frontend/pages` should not be treated
as a URL router like Next.js. It is a hierarchy for page-level custom elements:
large Light DOM Web Components that own a major app surface or layout container.

Use `layout.js` and `layout.css` for containers that own nested surfaces,
shared chrome, state transitions, or pane behavior. Use `page.js` and
`page.css` for leaf app surfaces. The directory path carries the meaning; the
filename communicates whether the custom element is a layout or a leaf page.

Example:

```text
frontend/pages/layout.js
frontend/pages/layout.css
```

defines the app-level `<caffold-app-shell>` layout. Nested page directories
represent UI ownership rather than URL paths.

## Current Ownership Model

The current runtime hierarchy is:

```text
caffold-app-shell
  app main route slot
    file browsing surface
      app header
        caffold-app-menu
        caffold-header-actions
          caffold-git-header-action
          caffold-github-header-action
          caffold-codex-header-action
      caffold-pathbar
      caffold-files-page
        caffold-file-browser
          caffold-file-list
          caffold-file-viewer
    task workspace
      caffold-task-workspace
        workspace navigation
          Tasks
          Settings
        caffold-tasks-page
          caffold-task-navigator
          caffold-task-new
            caffold-task-composer
            caffold-file-browser
              caffold-file-list
              caffold-file-viewer
          caffold-task-detail
            caffold-task-conversation
            caffold-task-composer
            caffold-task-review
              caffold-git-diff-changes-tree
              caffold-git-compare-tree
              caffold-file-navigator
                caffold-file-list
              caffold-review-file-viewer
        caffold-settings-workspace
          caffold-settings-navigator
          caffold-settings-appearance-page
          caffold-settings-codex-page
          caffold-settings-about-page
    caffold-review-workspace
      git
        caffold-git-review-layout
          diff
            caffold-git-diff-page
              caffold-git-diff-browser
                caffold-git-diff-changes-tree
                caffold-review-file-viewer
          compare
            caffold-git-compare-page
              caffold-git-compare-browser
                caffold-git-compare-tree
                caffold-review-file-viewer
          log
            caffold-git-log-layout
              caffold-git-log-list-page
              caffold-git-log-commit-page
                caffold-commit-changes-tree
                caffold-review-file-viewer
      github
        caffold-github-review-layout
          issues
            caffold-github-issues-layout
              caffold-github-issues-list-page
              caffold-github-issue-detail-page
          pulls
            caffold-github-pulls-layout
              caffold-github-pulls-list-page
              caffold-github-pull-detail-page
              caffold-github-pull-files-page
                caffold-github-pull-files-tree
                caffold-review-file-viewer
```

`frontend/pages/layout.js` is the app root layout and defines
`<caffold-app-shell>` directly. `frontend/pages` is the one exception to the
parenthesized grouping rule because wrapping the root app shell would only
repeat the root hierarchy.

`settings.js` owns browser-local preferences and applies their CSS variables
before the app shell renders. `(task-workspace)/settings` is a routed
master-detail surface reached from the task-workspace navigation, the
Files-only `caffold-app-menu`, or the compact Codex status action. Its
Appearance page persists device-specific UI preferences in `localStorage`
rather than the server database. Codex and About Caffold are sibling Settings
pages, not popovers or global dialogs.

Appearance has three independent semantic axes:

- Interface size is a 90–120% scale over a 16px fine-pointer base or a 17px
  coarse-pointer/narrow-screen base. It owns UI text, controls, rows, icons,
  and spacing. Coarse pointers and screens at or below 520px keep important
  targets at least 40px tall.
- Conversation text is a device-independent 13–20px value. It owns Tasks
  messages and work prose, the Composer textarea, and GitHub issue/PR prose.
- Code text is a device-independent 12–20px value. It owns source and diff
  viewers, command/tool output, and inline or fenced code inside Tasks and
  GitHub prose.

Interface controls use two semantic size tiers. Page-level navigation,
application-wide actions, and primary submissions use
`--interface-control-size`. Contextual toolbars and inline secondary actions
use `--interface-compact-control-size`. Feature ownership does not choose the
tier: equivalent actions in Tasks, Files, Git, and GitHub use the same tier.
The responsive target floor still raises either tier to at least 40px on
coarse pointers and narrow screens.

Control geometry and label typography are separate contracts. A regular
page-level target may keep `--interface-control-size` while its visible action
label uses `--interface-meta-font-size`; making a target easier to hit must not
silently turn its label into page-body text. Context menus, path navigation,
and compact toolbar labels use the same Interface metadata scale unless their
owner defines a distinct content-row typography.

The shared root variables expose values; they do not transfer selector
ownership to the root stylesheet. Each component consumes the semantic token
inside its existing CSS boundary, including the Task and GitHub Markdown
Shadow DOM styles. Mixed components keep their boundaries explicit: Composer
chrome is Interface while its textarea is Conversation; approval prose is
Conversation, its command is Code, and its controls are Interface. Timestamps,
status, disclosure labels, loading/retry actions, and errors remain Interface
even inside a conversation.

`settings.js` normalizes and writes `appearanceVersion: 2` on initial load
without emitting a change event. The Settings page uses stable native range
elements and patches their values in place so live updates do not replace the
focused control or lose pointer capture. User updates and resets publish one
`caffold:settings-change` snapshot.

`files/page` is the app root's route-level file browsing page. It renders
`caffold-file-browser` and delegates the file browser API that app-shell uses.
`components/file-navigator` owns reusable directory loading/cache, expanded
tree state, selected-row presentation, list scroll, delayed loading feedback,
and its optional live-update subscription. `components/file-browser` composes
that navigator with the shared file viewer and owns file-preview loading,
files-route path materialization, list/viewer mode, mobile switching, and the
left file-panel resizer. The app root coordinates cwd context, URL navigation,
pathbar, and header actions around that surface instead of owning file browser
internals. `watch.js` shares an SSE subscription with other consumers of the
same filesystem scope; integrated Task Review disables the navigator's own
watch and supplies one Review-owned root watch instead.

`(task-workspace)/layout` is the app root's default task workspace and `/` is
its canonical Tasks home. It fills the app main route slot, so Tasks and
Settings do not inherit the Files-only app header, pathbar, or pane shell. Its
bottom navigation switches between two stable-mounted children: the Tasks page
and the Settings workspace. The layout remembers the last route in each mode,
preserves both DOM trees while the other mode is visible, and hides the bottom
navigation on compact task-detail routes where conversation space is primary.
It is separate from `(review-workspace)` because task control is not only a
review surface.

`(task-workspace)/tasks/page` is only the task route and master-detail
coordinator. It owns the selected route/thread, responsive visibility, list
width, and the Conversation/Review outer layout. It does not fetch task data,
subscribe to task streams, send Codex mutations, or render child internals.
`(task-workspace)/settings/layout` owns the Settings list/detail transition and
keeps Appearance, Codex, and About pages mounted while selecting one with the
route. On compact screens `/settings` is the list and a selected section is a
detail with a back control; wide screens keep both panes visible.

The Tasks runtime hierarchy deliberately separates state with different
lifetimes:

- `caffold-task-navigator` owns the managed and History REST pages, list SSE,
  list revisions, Continue requests, repository grouping, list DOM, and list
  scroll.
- `caffold-task-new` owns cwd selection and the create request.
  `caffold-task-composer` owns its create draft, images, focus, option pickers,
  and voice capture state. Voice capture saves the current selection before it
  releases textarea focus, locks prompt submission while recording or
  transcribing, and inserts returned text without submitting or restoring
  focus.
- `caffold-task-detail` owns the selected thread's canonical REST read and
  application, detail revisions, event cache, history requests, prompt
  reconciliation, approvals, interrupt actions, and review-route coordination.
  Its private `detail/stream.js` module owns only the selected thread's
  `EventSource`, reconnect/visibility refresh scheduling, connection generation,
  and transport state. Raw stream messages and a guarded refresh request go to
  Detail; the module has no task/event cache or revision writer. Detail checks
  both its route generation and the stream-provided current-generation guard
  before applying a refresh response.
- `caffold-task-detail-summary` owns the stable header DOM, task-info and
  Git/GitHub menu disclosure, and GitHub availability requests scoped to the
  current worktree. It receives raw task/transport/review snapshots and emits
  intents; it cannot mutate canonical task state or invoke Codex actions.
- `caffold-task-conversation` owns transcript rendering, disclosure state,
  scroll anchors, Markdown reflow handling, and the canonical active-turn
  clock.
- The follow-up `caffold-task-composer` owns thread-local drafts, images,
  focus/selection, textarea sizing, voice capture, and explicit
  model/permission overrides.
  Detail still owns the prompt mutation and canonical reconciliation.
- `caffold-task-review` is the integrated Task Review owner. It owns one
  selected path plus the independent Working Tree/Branch, Changes/Files, and
  Diff/Source axes. It composes the two Git change-tree presentations, one
  reusable file navigator, and one shared source/diff viewer instead of
  mounting complete Files, Diff, and Compare browsers. It also owns Git
  status/compare requests, the one root filesystem watch, refresh generations,
  panel width, navigator/viewer scroll, and expanded file directories. Task and
  event inputs are read-only context for that component.

Navigator and Detail are independent browser projections. Each owns its own
REST/SSE baseline and revision map; neither revision can invalidate the other.
Detail emits canonical task snapshots upward, the Tasks page forwards those
snapshots to Navigator, and Navigator updates only through its public
`upsertCanonicalTask` boundary. New Task similarly emits the canonical create
response, which the page adopts into Detail and Navigator before requesting the
new route.

Data crosses these boundaries as snapshots or method calls from parent to
child. Actions cross upward as intent events. Leaf components do not mutate
sibling state or call Codex mutation APIs on behalf of their canonical owner.
The Tasks page mounts Navigator, New Task, and Detail once and switches them
with visibility and activation methods. Tasks home owns Navigator plus New Task
as its default detail; on compact layouts the combined loaded active-and-archived
state chooses the list when either section has tasks and New Task only when both
are empty. Navigator owns the New Task action in its active-section header; the
active-task count is not a separate control. The explicit `/tasks/new` route
selects the same New Task instance and inherits the selected task context when
one exists. Detail likewise preserves Summary,
Conversation, and Composer instances. It keeps up to six thread-local Review
instances in an explicit LRU cache (`CLEAN_REVIEW_CACHE_LIMIT = 6`). An inactive
Review is disconnected so its watcher and requests stop, while its DOM-local
panel width, scroll, and disclosure state remain available for a quick return.
Switching Conversation and Review therefore preserves the composer draft and
transcript position without letting inactive review work continue in the
background.

Task Review semantic state comes from `/tasks/:threadId/review`: selected path,
scope, navigator, viewer, and branch base are route-owned. The Review component
is the only writer that turns UI intents into changes to those route fields;
the Tasks page and Detail only forward the route and intent. Scroll, expanded
directories, and resizer width remain component-local and do not enter the URL.
The worktree root is used when Git is available, with the thread cwd as the
non-Git Files/Source root. Live repository and worktree context is derived from
each canonical thread cwd rather than stored by the frontend.

When a loaded directory enters or leaves a Git repository, the app root decides
the current repository context and reloads the active review route if needed.
The review workspace applies or clears that repository context across review
domains and asks the active domain for the route to reload. The Git and GitHub
layouts own their own status refresh requests. Git and GitHub review route entry
stays domain-specific: the app root prepares cwd-based path options and
file-browser cleanup callbacks, the review workspace decides active-domain
cleanup and chrome lifecycle, and the Git/GitHub layouts own their own route
execution semantics.
The two flows should not be hidden behind one generic helper because GitHub
availability/status refresh has different semantics from Git review state.

`caffold-header-actions` owns Files-header-only action status derivation. The app
root supplies only the loaded repository context plus raw Git/GitHub status
payloads, and the header actions component maps those into Git/GitHub button
availability, labels, messages, and badges. Codex app-server status is
header-local and is loaded directly by the header actions component, then
passed to `caffold-codex-header-action`. The compact action navigates to
Settings/Codex; it does not own a details popover. The app root forwards the
raw status snapshot to the stable Settings/Codex page but does not fetch Codex
status or assemble its display state.

`(review-workspace)` is a pathless review surface in the app main route slot. It owns
the active review domain, shared review chrome, close/back behavior, panel
resizing, and mobile list/detail transitions. It refreshes shared chrome by
reading details from the active child layout rather than receiving chrome
details from the app root. Back controls ask the active child layout for a
domain route before falling back to the app root's browser-parent route. It is
not a Git-only or GitHub-only page.
Nested layouts own their own list/detail flow once they have a clear domain
boundary. `(git)/layout` owns Git status loading, Git submode switching,
Compare controls, Diff, Compare, and Log list/detail state. It also translates
Git-domain open, close, and back events from child pages into Git route intents,
and derives Git workspace chrome metadata such as branch, dirty marker, and
changed-file count from its own repository/status state.
It keeps the repository watch subscription active while repository context is
available, so header status and the selected review detail stay current even
when another top-level surface is visible.
`(github)/layout` owns GitHub status loading, GitHub submode switching, and
delegates issue and pull request internals to their nested layouts. It
translates GitHub-domain open, close, and back events from child pages into
GitHub route intents. For example,
`(github)/(issues)/layout` owns issue list loading, pagination state, issue
detail loading, and selected issue state; `app-shell` keeps cwd-based URL
execution and top-level workspace coordination.
Likewise, `(github)/(pulls)/layout` owns pull request list/detail/files mode
switching, PR pagination, and selected PR summary state. Its `files/page` owns
PR changed-file loading, PR file diff state, and PR file list scroll
restoration.

CSS follows the same ownership boundary. A layout may expose shared variables
such as pane header height, but it should style only its own chrome and direct
layout children. Nested pages/components own their panel headers, titles, and
detail selectors. If a domain-owned control is rendered into shared chrome, keep
its CSS in the owning domain's stylesheet and scope the selector to the shared
slot instead of adding broad descendant rules to the parent layout.

## Browser Test Structure

The Playwright suite mirrors the runtime owner rather than the historical
screen where a flow was first tested:

```text
tests/e2e/
  app-shell.spec.js
  settings.spec.js
  task-workspace.spec.js
  files/
    navigation.spec.js
    live.spec.js
    presentation.spec.js
  review/
    git.spec.js
    github.spec.js
    routing.spec.js
  tasks/
    ...
  support/
    file-browser-fixtures.js
    header-actions.js
    review-layout.js
    review-route-fixtures.js
    review-context-fixture.js
    task-fixtures.js
    ...
```

The spec owns the observable user contract: clicks, browser navigation, route
transitions, responsive DOM, and assertions. Support modules own deterministic
inputs and observation controls such as API responses, request counters,
filesystem fixture values, delayed-request gates, and reusable layout
measurements. They must not hide a surface's user flow behind a generic page
object.

`review/routing.spec.js` is intentionally a routing-owner suite. Each Git or
GitHub route lifecycle and each cwd-context reload mode is an independent
test. The one cross-domain case is a narrow smoke test for switching route
owners without retaining stale layout state. Git and GitHub product behavior
otherwise remains in their domain specs.

All mutable fixture state is created inside one Playwright test. Specs must
remain valid under normal parallel execution and under `--workers=1`; serial
configuration is not a substitute for isolating filesystem paths, request
counters, delay gates, or browser-local state.

## Page/Layout Skeleton

The current page-level skeleton is:

```text
frontend/pages/
  layout.js
  layout.css
  components/
    pathbar.js
    pathbar.css
    header-actions.js
    header-actions.css
    header-actions/
      shared.js
      git-status.js
      github-status.js
      codex-status.js
      codex-status-model.js

  files/
    page.js
    page.css

  (task-workspace)/
    layout.js
    layout.css
    tasks/
      page.js
      page.css
      runtime-state.js
      task-events.js
      task-format.js
      task-list-model.js
      components/
        navigator.js
        navigator.css
        task-new.js
        task-new.css
        composer.js
        composer.css
        task-status.js
        task-status.css
        detail.js
        detail.css
        detail/
          stream.js
          summary.js
          summary.css
          conversation.js
          conversation.css
          conversation/
            render.js
            markdown.js
          review.js
          review.css
    settings/
      layout.js
      layout.css
      navigator.js
      navigator.css
      appearance/
        page.js
        page.css
      codex/
        page.js
        page.css
      about/
        page.js
        page.css

  (review-workspace)/
    layout.js
    layout.css

    (git)/
      layout.js
      layout.css
      diff/
        page.js
        page.css
      compare/
        page.js
        page.css
      (log)/
        layout.js
        layout.css
        list/
          page.js
          page.css
        commit/
          page.js
          page.css
          components/
            changes-tree.js
            changes-tree.css

    (github)/
      layout.js
      layout.css
      (issues)/
        layout.js
        layout.css
        list/
          page.js
          page.css
        detail/
          page.js
          page.css
      (pulls)/
        layout.js
        layout.css
        list/
          page.js
          page.css
        detail/
          page.js
          page.css
        files/
          page.js
          page.css
          components/
            tree.js
            tree.css
```

Keep reusable building blocks in `frontend/components`:

- `file-browser.js`
- `file-browser.css`
- `file-browser/list.*`
- `pagination.*`
- `code-viewer.*`
- `diff-viewer.*`
- `file-viewer.*`
- `icons.js`
- `dom.js`

Page-specific helper components can live under that page's `components/`
directory when moving them to shared `frontend/components` would hide the
ownership boundary. For example, the Git log list belongs only to
`(git)/(log)/list/page`, the commit changes tree belongs only to
`(git)/(log)/commit/page`, and the PR files tree belongs only to
`(github)/(pulls)/files/page`. GitHub-only helpers shared by GitHub pages,
such as the Markdown renderer, belong under `(github)/components`. The file
browser is different: it is now a reusable surface used by `files/page` and
task-workspace integrations, so it lives under `frontend/components`
with its list implementation in `frontend/components/file-browser/`.
Layout-specific helper components follow the same rule. App chrome such as the
pathbar and header actions belongs to `frontend/pages/layout`.

## Naming Rules

- `layout.js` means a container Web Component, not a URL layout.
- `page.js` is a leaf surface entrypoint. If the surface itself is page-owned,
  define its custom element in `page.js` instead of leaving an import-only
  wrapper.
- Existing custom element names stay stable when a reusable component remains a
  reusable component. When a surface is promoted to a page-owned element, use
  the page-level custom element name.
- Do not move lower-level or reusable components under `pages` just to mirror
  the current screen. Components such as `pagination`, `file-viewer`, and
  `diff-viewer` stay component-level.
- Wrap intermediate `frontend/pages` directories that do not contain `page.js`
  in parentheses, such as `(review-workspace)`, `(git)`, or `(github)`. These
  are pathless grouping/layout nodes, not URL segments. Do not wrap the
  `frontend/pages` root layout itself.

## Migration Rules

- Do not mix file movement with behavior changes.
- When extracting a stateful component, move its state, every writer,
  subscription/timer/watcher cleanup, DOM, component-scoped CSS, and regression
  tests in the same change.
- Keep stateful children mounted. A container should show, hide, and call their
  public methods instead of rebuilding their internal DOM and attempting to
  restore local state afterward.
- Update imports, `styles.css`, `service-worker.js`, `src/static_assets.rs`,
  and asset tests in the same commit.
- Prefer stable custom element names. Moving a file should not require changing
  `<caffold-*>` names.
- Treat `pages` as a Web Component hierarchy, not a URL hierarchy.
