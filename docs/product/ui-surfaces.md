# UI Surfaces

This document maps the implemented browser surfaces and their product
boundaries. Caffold is Task-first: the selected Task is the stable context for
conversation, local review, Git inspection, and GitHub inspection.

## Task workspace

`caffold-task-workspace` is the only routed application workspace. It contains
the Task navigator, New Task, Task Detail, and Settings. The application shell
owns bootstrap, route forwarding, settings application, and build-update
presentation.

Desktop reading surfaces may keep the Task navigator visible. Code surfaces
use the available detail width. Foldable and phone layouts use the same
master-detail system and show one contextual Back appropriate to the deepest
visible route.

## Task Navigator

The Task navigator provides:

- active and Archived sections;
- repository grouping derived from canonical Task cwd/worktree state;
- task title, recency, availability, and unseen-completion state;
- New Task, Archive, Restore, and eligible delete actions.

Selecting a Task opens its Conversation. Direct Task URLs load by `threadId`
without requiring the Task to appear in the currently loaded navigator page.

## New Task

New Task owns:

- its selected cwd and route representation;
- model, reasoning, speed, and approval choices;
- the prompt draft, attachments, and voice input;
- its scoped Directory Picker;
- the setup-only isolated-worktree guide.

A New Task intent from an existing Task starts at that Task's repository root,
not its managed worktree root. The bootstrap initial path and `.` are later
fallbacks. The current New Task owns directory selection and its route value.

## Task Detail

Task Detail owns the selected thread, canonical Task snapshot, Codex event
stream, selected outer child, Task-scoped route intents, and child
activation/deactivation. It hosts four stable sibling surfaces.

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

Integrated Review is the only owner of Working Tree and current Task Branch
review. It combines:

- Working Tree or Branch scope;
- Changes or Files navigator;
- Diff or Source viewer;
- one selected task-root-relative path;
- one root filesystem watch while active;
- current-branch base normalization.

This is also the product path for general file/source inspection through the
reusable file navigator, source viewer, text viewer, and supported image viewer.

### Git

The Task-owned Git child contains only behavior not duplicated by Integrated
Review:

- arbitrary-ref Compare, where both base and head may differ from the Task's
  current branch;
- bounded Log, commit detail, changed files, diff, and source inspection.

Git is read-only. It does not expose stage, commit, checkout, reset, merge,
rebase, stash, or publication controls. Its active repository watch reacts to
ref-derived invalidation only; it does not own Working Tree status or the
Integrated Review selected path.

### GitHub

The Task-owned GitHub child derives its repository from canonical Task context
and the authenticated GitHub CLI. It provides:

- Issue list and detail;
- Pull Request list and detail;
- Pull Request changed files, unified diff, and source inspection;
- the same explicit Start Task action on Issue and Pull Request detail;
- scoped availability, loading, error, and Retry states.

Activation or meaningful re-entry performs a fresh canonical query while
retained DOM-local state may remain visible. GitHub does not poll, create a
filesystem watcher, or refresh while hidden. It does not publish comments,
reviews, Pull Requests, or other GitHub mutations.

The Task's GitHub root mounts one shared Task Start dialog rather than separate
Issue and Pull Request workflows. Each detail owns its visible action and
canonical source payload; the root owns dialog lifetime, while the dialog owns
Task turn options, Task creation, focus return, and source-specific setup.

For Issues, the user chooses the base ref and the setup turn creates a new
Issue branch from it. For Pull Requests, the dialog shows the canonical
base/head relationship as read-only context and verifies the exact canonical
head commit. Same-repository and fork PRs are supported; a stale or unavailable
head remains an explicit recoverable error instead of selecting another ref.
Both prompts treat source metadata as untrusted, leave source-checkout changes
in place, stop after worktree preparation, and wait for the user's next request
instead of beginning review or implementation.

### Child lifetime

Within one selected Task, Git and GitHub DOM remains mounted while hidden so
selection, disclosure, scroll, and pane widths can survive. Inactive children
release watchers, pending requests, and other active work, and activation
performs a fresh canonical sync. Switching to a different Task destroys the
Git/GitHub children, so each domain DOM lifetime is bounded to the selected
Task.

Integrated Review uses a bounded per-thread cache, with active work tied to
connection and activation. Canonical repository-context changes invalidate
repository-bound data even when `threadId` is unchanged.

## Settings

Settings includes:

- Appearance controls for System/Light/Dark theme, typeface, Interface scale,
  Conversation text, and Code text;
- Codex runtime status, Refresh, restart, and diagnostics;
- About Caffold application and build information, including shared
  checking/ready/settled update status and a **Reload to update** action while
  a prepared PWA generation remains ready.

Normal update checking and readiness are distinct from the viewport-fixed red
build-mismatch alert. That exceptional alert appears only after update checking
has settled without a prepared replacement for a differing server build.

Appearance choices are persisted in browser-local settings rather than Task or
server state.

Settings Codex owns its status requests and request generations. It refreshes
on activation and invalidates pending work when hidden.

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

Planned additions belong in the [Roadmap](roadmap.md) and
[Product Workflows](workflows.md), not in this description of implemented
surfaces.
