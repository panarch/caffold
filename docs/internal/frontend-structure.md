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
  app header
    scaffold-app-menu
    scaffold-header-actions
      scaffold-git-header-action
      scaffold-github-header-action
      scaffold-codex-header-action
  scaffold-pathbar
  file browsing surface
    scaffold-files-page
      scaffold-file-browser
        scaffold-file-list
        scaffold-file-viewer
  settings surface
    scaffold-settings-page
  codex workspace
    scaffold-codex-workspace
      scaffold-tasks-page
        caffold-task-navigator
        caffold-task-new
          caffold-task-composer
          scaffold-file-browser
            scaffold-file-list
            scaffold-file-viewer
        caffold-task-detail
          caffold-task-conversation
          caffold-task-composer
          caffold-task-review
            scaffold-file-browser
              scaffold-file-list
              scaffold-file-viewer
            scaffold-git-diff-browser
              scaffold-git-diff-changes-tree
              scaffold-review-file-viewer
            scaffold-git-compare-browser
              scaffold-git-compare-tree
              scaffold-review-file-viewer
  scaffold-review-workspace
    git
      scaffold-git-review-layout
        diff
          scaffold-git-diff-page
            scaffold-git-diff-browser
              scaffold-git-diff-changes-tree
              scaffold-review-file-viewer
        compare
          scaffold-git-compare-page
            scaffold-git-compare-browser
              scaffold-git-compare-tree
              scaffold-review-file-viewer
        log
          scaffold-git-log-layout
            scaffold-git-log-list-page
            scaffold-git-log-commit-page
              scaffold-commit-changes-tree
              scaffold-review-file-viewer
    github
      scaffold-github-review-layout
        issues
          scaffold-github-issues-layout
            scaffold-github-issues-list-page
            scaffold-github-issue-detail-page
        pulls
          scaffold-github-pulls-layout
            scaffold-github-pulls-list-page
            scaffold-github-pull-detail-page
            scaffold-github-pull-files-page
              scaffold-github-pull-files-tree
              scaffold-review-file-viewer
```

`frontend/pages/layout.js` is the app root layout and defines
`<caffold-app-shell>` directly. `frontend/pages` is the one exception to the
parenthesized grouping rule because wrapping the root app shell would only
repeat the root hierarchy.

`settings.js` owns browser-local preferences and applies their CSS variables
before the app shell renders. `settings/page` is a global app surface opened
from `scaffold-app-menu`; it persists device-
specific UI preferences in `localStorage` rather than the server database.

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
`scaffold-file-browser` and delegates the file browser API that app-shell uses.
`components/file-browser` owns the reusable file browser surface: directory
loading, file preview loading, files-route path materialization, list/viewer
state, file-list scroll restoration, delayed loading indicators, mobile
list/viewer switching, and the left file-panel resizer. The app root
coordinates cwd context, URL navigation, pathbar, and header actions around
that surface instead of owning file browser internals.
The file browser also owns its live-update subscription and refreshes only its
loaded directory cache and selected file. `watch.js` shares the SSE
subscription with other consumers of the same filesystem scope.

`(codex)/layout` is the app root's top-level Codex workspace. It renders as an
app-shell overlay sibling of `app-main` and `(review-workspace)`, so Codex
tasks do not inherit the file browser pathbar or pane shell. It is separate
from `(review-workspace)` because Codex is a work/control surface, not only a
review surface. The layout delegates its route-level work to a stable-mounted
Tasks page. `(codex)/tasks/page` is only the route and master-detail
coordinator. It owns the selected route/thread, responsive visibility, list
width, and the conversation/Files/Diff outer layout. It does not fetch task
data, subscribe to task streams, send Codex mutations, or render child
internals.

The Tasks runtime hierarchy deliberately separates state with different
lifetimes:

- `caffold-task-navigator` owns the managed and History REST pages, list SSE,
  list revisions, Continue requests, repository grouping, list DOM, and list
  scroll.
- `caffold-task-new` owns cwd selection and the create request.
  `caffold-task-composer` owns its create draft, images, focus, and option
  pickers.
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
  focus/selection, textarea sizing, and explicit model/permission overrides.
  Detail still owns the prompt mutation and canonical reconciliation.
- `caffold-task-review` owns Files/Diff/Compare selection, Git status,
  filesystem watches, refresh coordination, and the reusable review browsers.
  Task and event inputs are read-only context for that component.

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
with visibility and activation methods. Detail likewise preserves Summary,
Conversation, Composer, and Review instances. Switching conversation/Files/Diff
therefore does not require capture-and-restore code for header disclosure,
drafts, transcript scroll, or review selection.

Files opens the derived worktree root, falling back to the thread cwd outside
Git. Diff uses the same reusable tree/viewer implementation as the Git review
route and is available whenever a live worktree context exists. Live repository
and worktree context is derived from each canonical thread cwd rather than
stored by the frontend. The app root only routes cwd context into the Codex
workspace.

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

`scaffold-header-actions` owns header-only action status derivation. The app
root supplies only the loaded repository context plus raw Git/GitHub status
payloads, and the header actions component maps those into Git/GitHub button
availability, labels, messages, and badges. Codex app-server status is
header-local and is loaded directly by the header actions component, then
passed to `scaffold-codex-header-action`. The app root should not fetch Codex
status or assemble header display state.

`(review-workspace)` is a pathless review container inside the app root. It owns
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
      codex-status.css

  files/
    page.js
    page.css

  (codex)/
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
future Codex workspace integrations, so it lives under `frontend/components`
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
