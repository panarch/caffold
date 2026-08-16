# UI Surfaces

This document maps the implemented browser surfaces and their product
boundaries. The Tasks workspace selects either a Task or a managed Section as
the stable context for local work.

## Task workspace

The Task workspace is the only routed application workspace. It contains the
Task navigator, Global New, Task/Section Detail, and Settings.

Desktop reading surfaces may keep the Task navigator visible. Code surfaces
use the available detail width. Foldable and phone layouts use the same
master-detail system and show one contextual Back appropriate to the deepest
visible route.

## Task Navigator

The Task navigator provides:

- active and Archived sections;
- repository grouping derived from canonical Task cwd/worktree state;
- task title, recency, availability, and unseen-completion state;
- exclusive Task and Section reorder modes for the persistent Active order;
- New Task, Archive, Restore, and eligible delete actions.

Managed Section headers are selectable and open Section Detail. Recovery group
headings remain labels only. The selected Section is represented by local id;
its managed logical path supplies the fixed cwd and its repository capability
controls which shared review surfaces are available.

Task reorder mode moves Tasks within their current Section. Section reorder
mode presents the managed Section headers without their Task rows and moves the
Sections as units. Only one mode is active at a time; recovery and Archived
content are not reorderable.

Selecting a Task opens its Conversation. Direct Task URLs load by `threadId`
without requiring the Task to appear in the currently loaded navigator page.

## New Task

Global New owns:

- its selected cwd and route representation;
- model, reasoning, speed, and approval choices;
- the prompt draft, attachments, and voice input;
- its scoped Directory Picker;
- the setup-only isolated-worktree guide.

A New Task intent from an existing Task starts at that Task's repository root,
not its managed worktree root. The bootstrap initial path and `.` are later
fallbacks. The current New Task owns directory selection and its route value.

Before New Task is available, a blocking canonical Codex readiness state
replaces the Tasks content with persistent install, update, sign-in, restart,
or recovery guidance. A stale runtime exposes the same explicit restart
confirmation available from Codex Settings. Retry rechecks the backend
diagnosis and Settings stays available throughout setup.

Task creation starts a Codex thread in the selected cwd. Managed-worktree
preparation happens explicitly from the resulting Task; it is not an implicit
side effect of task creation.

Global New and Section New provide the same Composer, turn options, and error
behavior. Section New fixes cwd to the Section's managed logical path, omits
directory browsing and setup guidance, and preserves its draft across
same-Section surface switches.

## Detail

Detail provides Summary actions, the subject-aware view switch, Integrated
Review, Git, and GitHub. A Task adds Conversation; a Section adds fixed-context
New Task. Switching Task or Section context reloads repository data, while safe
local state may survive surface switches within one context. If a Section loses
repository capability, it returns to New Task.

## Task Detail

Task Detail presents the selected thread, Conversation, command requests,
follow-up Composer, and Task actions. Integrated Review, Git, and GitHub remain
shared repository surfaces.

### Conversation

Conversation renders the canonical Codex thread as a review timeline:

- prompts and agent responses;
- reasoning summaries and tool activity;
- commands, output, and file-change records;
- approvals and canonical outcomes;
- interruption, failure, reconnect, completion, and unavailable states;
- follow-up Start or Steer behavior derived from canonical thread state.

The Composer owns its draft, attachments, selection, and voice capture. Task
child switching does not interrupt the selected Task's Codex stream.

### Integrated Review

Integrated Review is the product surface for Working Tree and current Task
Branch review. It combines:

- Working Tree or Branch scope;
- Changes or Files navigator;
- Diff or Source viewer;
- one selected task-root-relative path.

This is also the product path for general file/source inspection through the
reusable file navigator, source viewer, text viewer, and supported image viewer.

### Git

The shared Git child contains only behavior not duplicated by Integrated
Review:

- arbitrary-ref Compare, where both base and head may differ from the Task's
  current branch;
- bounded Log, commit detail, changed files, diff, and source inspection.

Git is non-authoring. Log exposes an explicit Fetch action that updates the
selected repository's remote-tracking default branch and reports its
relationship to the current checkout; it never fetches automatically. Git does
not expose stage, commit, checkout, reset, merge, rebase, stash, or publication
controls. Its active repository watch reacts to ref-derived invalidation only;
it does not own Working Tree status or the Integrated Review selected path.

### GitHub

The shared GitHub child derives its repository from the active Task or Section
context and the authenticated GitHub CLI. It provides:

- Issue list and detail;
- Pull Request list and detail;
- Pull Request changed files, unified diff, and source inspection;
- scoped availability, loading, error, and Retry states.

GitHub refreshes remote state when the user enters or retries a surface. It does
not publish comments, reviews, Pull Requests, or other GitHub mutations.

Issue and Pull Request detail expose the same Start Task action. For an Issue,
the user chooses a base ref. For a Pull Request, the canonical base/head is
read-only and an arbitrary base cannot be selected. Both create a setup-only
Task. The complete sequence and safety boundary are defined in
[Product Workflows](workflows.md).

### Surface state

Switching among Integrated Review, Git, and GitHub may preserve selection,
disclosure, scroll, and pane widths within the same Task or Section. Returning
to a surface reconciles current source state. Changing Task, Section, or
repository context discards retained external context. The implementation
contract is defined in [Frontend Architecture](../architecture/frontend.md).

## Settings

Settings includes:

- Appearance controls for System/Light/Dark theme, typeface, Interface scale,
  Conversation text, and Code text;
- Notifications controls for the current browser's permission and subscription,
  plus the active browser-installation count, labels, short IDs, and removal;
- Codex installation readiness, repair guidance, runtime status, Refresh,
  restart, and diagnostics;
- About Caffold application and build information, including shared
  checking/ready/settled update status and a **Reload to update** action while
  a prepared PWA generation remains ready. Copied diagnostics also include the
  private handoff node, target and observed worker builds, and navigation-attempt
  count for stalled-update investigation.

Normal update checking and readiness are distinct from the viewport-fixed red
build-mismatch alert. That exceptional alert appears only after update checking
has settled without a prepared replacement for a differing server build.

Appearance choices are persisted in browser-local settings rather than Task or
server state.

Notifications reconcile a browser-owned `PushSubscription` and local
installation ID with server-owned registration or revocation state. Permission
is requested only by the explicit **Enable** action. Removing another browser
revokes that installation; opening Notifications there applies the revocation
locally instead of silently subscribing again.

Tasks and Codex Settings present the same backend readiness and restart outcome.
Only refreshed readiness restores Task actions. The browser is the complete
settings surface, while the macOS menu may expose a compact control when both
surfaces use the same server state and action.

## Product boundaries

The browser UI does not provide:

- a full terminal or PTY workspace;
- automatic Task creation from Issue/PR context without an explicit user
  action;
- automatic continuation after the setup turn;
- external-worktree adoption or force cleanup;
- force deletion of dirty managed worktrees;
- split diff, hunk comments, or durable review annotations;
- a Caffold-owned duplicate of the Codex transcript.

Planned additions belong in the [Roadmap](roadmap.md), not in this description
of implemented surfaces.
