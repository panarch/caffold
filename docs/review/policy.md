# Review Policy

Caffold is scaffolding for agent-assisted development. Changes to Caffold
should be reviewed with the same bias the product gives its users: make the
relevant state visible, keep the workflow inspectable, and avoid trusting
generated output until the behavior has been checked.

This document is the repository engineering policy, not a fixed roadmap or
compatibility contract. It defines the common review rules and links to the
area-specific policies that apply to a change.

## Review Priorities

Review changes in this order:

1. Preserve the review workflow.
2. Keep the source of truth clear.
3. Keep the interface dense, readable, and mobile-usable.
4. Prefer narrow, observable changes over broad rewrites.
5. Verify behavior in the browser, not only in code.

## Review Workflow

Caffold exists to make review-heavy agent work practical from a browser. A
change should not make these actions harder:

- understand what changed and why it matters
- inspect diffs and surrounding source files
- keep project, task, and repository context visible
- review agent, command, and test state when available
- return later without losing orientation
- use the same review flow on desktop, mobile, and foldable-width screens

When a change affects layout, navigation, scrolling, or review surfaces, the
review should include desktop, foldable, and phone viewports.

## Source of Truth

Caffold should present state without pretending to own state it does not own.

- git is the source of truth for file changes, diffs, logs, and repository
  state.
- Codex app-server is the source of truth for Codex thread and turn behavior.
- Caffold storage is for Caffold-owned metadata, indexes, recovery data, and
  UI-facing summaries.
- The browser UI is a view and control surface, not durable state.

External domain state must not be reconstructed from Caffold databases,
derived events, watched files, pending UI requests, or browser state. A copied
snapshot may support diagnostics or indexing, but it must not decide the
current lifecycle, badge, or whether a control is available. If the owning
source is unavailable, expose an unavailable or error state instead of a
guessed state.

Keep domain state, transport state, and UI request state separate. Subscription
leases, revisions, cache invalidations, optimistic submissions, and loading
indicators may coordinate communication, but they do not change the external
domain state being displayed.

Every review that changes state handling must trace:

- the owner of each state field;
- every writer and the source that authorizes it;
- whether the value is persisted;
- every backend and frontend consumer.

A state change is not ready while an unowned writer, stale fallback, or
cross-layer status overlay remains.

## Policy Areas

Apply every area affected by the change. The split is for reviewability, not a
permission to ignore a boundary that crosses files or processes.

- [Frontend Review](frontend.md) covers layout, responsive
  behavior, integrated review navigation, Web Components, CSS ownership,
  component lifecycles, appearance ownership, browser tests, and frontend
  verification.
- [Backend and API Review](backend.md) covers backend ownership,
  route and capability boundaries, external state writers, path safety, and
  mutation policy, including Rust tests, coverage, and backend verification.

## Verification Across Boundaries

Verification belongs with the production owner. Apply both area policies when
a change crosses the frontend and backend, and test their integration at the
actual HTTP, storage, process, or browser boundary affected by the change.

Do not claim behavior was verified from a unit test, coverage percentage, or
browser assertion that does not exercise the relevant boundary. Record what was
run or inspected and identify any supported environment that remains
unverified.

## Review Output

Review comments should lead with concrete risks and observed behavior.

- Point to the affected file, component, API, or workflow.
- Separate must-fix regressions from follow-up improvements.
- Avoid broad summaries when one specific boundary is the problem.
- Do not claim behavior was verified unless it was actually run or inspected.
- When the evidence is uncertain, say what remains unverified.
