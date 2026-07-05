# Frontend Structure

> Internal planning note. This document describes the intended frontend file
> organization before broad component moves.

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
    scaffold-project-switcher
    scaffold-header-actions
      scaffold-git-header-action
      scaffold-github-header-action
      scaffold-codex-header-action
  scaffold-pathbar
  file browsing surface
    scaffold-files-page
      scaffold-file-list
      scaffold-file-viewer
  scaffold-review-workspace
    git
      scaffold-git-review-layout
        diff
          scaffold-git-diff-page
          scaffold-review-file-viewer
        compare
          scaffold-git-compare-page
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

`files/page` owns the file browser surface: directory loading, file preview
loading, files-route path materialization, list/viewer state, file-list scroll
restoration, delayed loading indicators, and the left file-panel resizer. The
app root coordinates project context, URL navigation, pathbar, and header
actions around that surface instead of owning file browser internals.

`scaffold-project-switcher` owns project record state and project candidate
state for the current directory. It performs project list/candidate refresh and
project CRUD requests, then emits selected project records upward. The app root
keeps only project-aware URL execution and project-relative path mapping.
When a loaded directory enters or leaves a Git repository, the app root decides
the current repository context and reloads the active review route if needed.
The review workspace applies or clears that repository context across review
domains and asks the active domain for the route to reload. The Git and GitHub
layouts own their own status refresh requests. Git and GitHub review route entry
stays domain-specific: the app root prepares project-aware path options and
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
`(github)/layout` owns GitHub status loading, GitHub submode switching, and
delegates issue and pull request internals to their nested layouts. It
translates GitHub-domain open, close, and back events from child pages into
GitHub route intents. For example,
`(github)/(issues)/layout` owns issue list loading, pagination state, issue
detail loading, and selected issue state; `app-shell` keeps project-aware URL
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

## Page/Layout Skeleton

The current page-level skeleton is:

```text
frontend/pages/
  layout.js
  layout.css
  components/
    pathbar.js
    pathbar.css
    project-switcher.js
    project-switcher.css
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
    components/
      list.js
      list.css

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

- `pagination.*`
- `code-viewer.*`
- `diff-viewer.*`
- `github-markdown.*`
- `file-viewer.*`
- `icons.js`
- `dom.js`

Page-specific helper components can live under that page's `components/`
directory when moving them to shared `frontend/components` would hide the
ownership boundary. For example, the file browser list belongs only to
`files/page`, the Git log list belongs only to `(git)/(log)/list/page`,
the commit changes tree belongs only to
`(git)/(log)/commit/page`, and the PR files tree belongs only to
`(github)/(pulls)/files/page`.
Layout-specific helper components follow the same rule. App chrome such as the
pathbar, project switcher, and header actions belongs to `frontend/pages/layout`.

## Naming Rules

- `layout.js` means a container Web Component, not a URL layout.
- `page.js` is a leaf surface entrypoint. If the surface itself is page-owned,
  define its custom element in `page.js` instead of leaving an import-only
  wrapper.
- Existing custom element names stay stable when a reusable component remains a
  reusable component. When a surface is promoted to a page-owned element, use
  the page-level custom element name.
- Do not move lower-level or reusable components under `pages` just to mirror
  the current screen. Components such as `pagination`, `file-viewer`,
  `diff-viewer`, and `github-markdown` stay component-level.
- Wrap intermediate `frontend/pages` directories that do not contain `page.js`
  in parentheses, such as `(review-workspace)`, `(git)`, or `(github)`. These
  are pathless grouping/layout nodes, not URL segments. Do not wrap the
  `frontend/pages` root layout itself.

## Migration Rules

- Do not mix file movement with behavior changes.
- Update imports, `styles.css`, `service-worker.js`, `src/static_assets.rs`,
  and asset tests in the same commit.
- Prefer stable custom element names. Moving a file should not require changing
  `<caffold-*>` names.
- Treat `pages` as a Web Component hierarchy, not a URL hierarchy.
