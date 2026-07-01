# Review Policy

Codger is a review console. Changes to Codger should be reviewed with the same bias the product gives its users: make the relevant state visible, keep the workflow inspectable, and avoid trusting generated output until the behavior has been checked.

This document is a public engineering policy, not a fixed roadmap or compatibility contract.

## Review Priorities

Review changes in this order:

1. Preserve the review workflow.
2. Keep the source of truth clear.
3. Keep the interface dense, readable, and mobile-usable.
4. Prefer narrow, observable changes over broad rewrites.
5. Verify behavior in the browser, not only in code.

## Review Workflow

Codger exists to make review-heavy agent work practical from a browser. A change should not make these actions harder:

- understand what changed and why it matters
- inspect diffs and surrounding source files
- keep project, task, and repository context visible
- review agent, command, and test state when available
- return later without losing orientation
- use the same review flow on desktop, mobile, and foldable-width screens

When a change affects layout, navigation, scrolling, or review surfaces, the review should include desktop, foldable, and phone viewports.

## Source of Truth

Codger should present state without pretending to own state it does not own.

- git is the source of truth for file changes, diffs, logs, and repository state.
- Codex app-server is the source of truth for Codex thread and turn behavior.
- Codger storage is for Codger-owned metadata, indexes, recovery data, and UI-facing summaries.
- The browser UI is a view and control surface, not durable state.

Duplicating external state is acceptable only when it supports recovery, indexing, or a clearer review experience. The copied data should be treated as a snapshot, not as the authority.

## Frontend Review

The UI is a work tool, not a marketing site. Review frontend changes for density, stability, and repeated use.

- Prefer component-level scrolling over global page scrolling.
- Preserve inspectability for long paths, file names, diffs, and code lines.
- Keep important context visible without forcing wide panels.
- Avoid hidden layout shifts during normal review navigation.
- Treat mobile and foldable layouts as first-class review surfaces.
- Check that labels, buttons, and headers do not clip text.
- Use visual evidence when layout or scrolling behavior is affected.

When changing layout, define the visual contract before accepting the implementation. The contract should describe how the surface uses space, not only which elements exist.

Examples:

- A control may be content-sized, fill available space, or share space with peers; do not leave that behavior implicit.
- Dynamic labels such as paths, branch names, and commit subjects should have an explicit growth and clipping rule.
- A desktop or foldable layout may allow wider content than the phone layout.
- A compact panel should not force unrelated controls to stretch just because the parent uses grid or flex.
- A loading, refresh, or selection state should not replace stable content unless the delay is meaningful.

Prefer browser-native intrinsic layout behavior over hand-computed widths. Use CSS primitives such as `max-content`, `minmax`, `field-sizing`, and viewport/container breakpoints before adding JavaScript string-length sizing. If a hard cap is needed, explain which viewport or neighboring control it protects.

Frontend fixtures should include inconvenient examples, not only normal labels:

- long file paths and file names
- long branch names, including remote branches
- many changed files or commits
- short content that does not fill the viewer
- narrow foldable and phone widths

## Web Components And CSS

Codger currently uses internal Web Components rendered in Light DOM. This keeps browser behavior, debugging, Playwright tests, shared theme variables, and small frontend modules straightforward. It also means CSS is still one global cascade.

Light DOM is the default until a component has a clear reason to isolate styles with Shadow DOM. Good reasons include reusable leaf widgets, third-party-like components, or a component whose styles cannot reasonably share the app cascade.

Because nested custom elements are still normal descendants in Light DOM, container selectors must be narrow.

Preferred patterns:

```css
codger-review-workspace > .review-workspace-panel {
  display: grid;
}

.review-workspace-title > h2 {
  font-weight: 600;
}

codger-log-list .log-entry {
  display: grid;
}
```

Avoid broad container selectors that can enter child components:

```css
codger-review-workspace h2 {
  font-weight: 600;
}

codger-app-shell button {
  font-size: 0.9rem;
}
```

Use these rules when reviewing CSS:

- Container components should style their own chrome and direct layout children.
- Prefer `>` for container layout selectors.
- Use component-local classes for internal chrome.
- Avoid raw tag selectors from shell or container components.
- Cross-component overrides must be narrow and intentional.
- If a selector looks convenient because it is broad, review it with suspicion.

## Backend And API Review

Backend changes should keep the browser API conservative unless the feature explicitly introduces a mutation.

- Keep path handling rooted and canonicalized.
- Do not allow path escape through symlinks or traversal.
- Return clear JSON errors for unsupported files and operations.
- Treat external tools and services as integration boundaries.
- Avoid mutation unless the feature explicitly asks for it.
- Shape responses for review surfaces instead of exposing raw implementation details by default.

## Verification

Verification should scale with the risk of the change.

For narrow backend changes:

- run Rust unit tests that cover the changed boundary
- run formatting and clippy checks when Rust code changes

For frontend layout or review-surface changes:

- run Playwright in desktop, foldable, and phone projects
- inspect screenshots when visual behavior is the point of the change
- test clipping, scrolling, and selection stability directly
- include edge-case fixture values that exercise the layout contract
- distinguish code changes from what the browser is actually serving

For CSS changes, tests should catch behavior, not just element presence:

- matching header heights where panels align
- no clipped header text
- preserved scroll positions where navigation should not move the viewport
- stable visual structure across supported viewport widths

When a local server is used for manual review, verify that the served assets include the intended change and say when a browser refresh is required. A passing unit or Playwright assertion does not prove that the currently open browser tab has the latest CSS or JavaScript.

## Review Output

Review comments should lead with concrete risks and observed behavior.

- Point to the affected file, component, API, or workflow.
- Separate must-fix regressions from follow-up improvements.
- Avoid broad summaries when one specific boundary is the problem.
- Do not claim behavior was verified unless it was actually run or inspected.
- When the evidence is uncertain, say what remains unverified.
