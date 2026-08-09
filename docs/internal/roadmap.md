# Roadmap

> Internal working plan. Ordering reflects product risk and workflow value, not
> a release commitment.

## Current foundation

The following foundation exists and should be hardened rather than rebuilt:

- Rust host, browser/PWA shell, and macOS menu-bar packaging;
- persistent Codex app-server daemon integration and thread-backed Tasks;
- Conversation controls, approvals, reconnect recovery, and local voice input;
- integrated Files, Git, GitHub, Diff, source, and log review;
- responsive desktop, foldable, and phone layouts;
- same-Task managed-worktree isolation, dirty transfer recovery, archive, and
  restore;
- public review policy plus contributor development and verification guides.

## Next: close one outer-loop workflow

Close review of someone else's PR before adding broader mutation:

1. identify repository and PR without allocating a worktree;
2. explicitly prepare or reuse an isolated review worktree;
3. attach integrated Review and optional Codex analysis/tests;
4. detect a changed remote head without replacing the active review;
5. explicitly sync while protecting dirty state and review position;
6. finish or dismiss review;
7. archive the Task and safely clean up only Caffold-owned resources.

This provides the shared Prepare, Sync, Close, and cleanup substrate for Issue
implementation and owned-PR follow-up.

## Then

- Issue implementation bootstrap, branch preparation, and PR linkage;
- owned-PR follow-up with comments, checks, and base movement;
- clearer test/command summaries attached to review context;
- richer reconnect, unavailable, and recovery actions;
- hunk-level review state and review-summary generation;
- test-failure links to relevant files or hunks;
- controlled GitHub mutations after their approval and recovery contracts are
  explicit.

## Later

- split diff;
- full PTY, tmux, or Zellij escape hatch;
- central multi-host dashboard;
- optional external-worktree adoption only if ownership and cleanup can be
  proven safely;
- broader controlled Git mutation UI.

Automatic Issue/PR recognition, worktree isolation, and continuation of the
original request is orchestration around existing capabilities. It must not
weaken the explicit setup-only `isolate_current_task` contract or silently move
dirty checkout state.
