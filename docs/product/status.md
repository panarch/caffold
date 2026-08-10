# Current Product Status

This document summarizes Caffold's implemented product and current support
boundaries.

## Available today

- `caffold serve` and the macOS menu-bar server wrapper;
- browser/PWA access on the trusted host and tailnet-only Tailscale Serve;
- managed, thread-backed Tasks with canonical app-server lifecycle;
- persistent app-server daemon plus replaceable proxy connection;
- prompts, steering, interruption, command approvals, images, and local voice
  input in the Conversation surface;
- cwd-derived repository/worktree grouping and integrated Files, Git, GitHub,
  Diff, source, and log review surfaces;
- same-Task preparation of a Caffold-managed worktree through
  `isolate_current_task`;
- opt-in transfer of staged, unstaged, and untracked changes with bounded
  recovery;
- archive/restore of Tasks and verified clean managed worktrees;
- responsive desktop, foldable, and phone layouts.

## Current boundaries

- Codex app-server is the required execution and thread-state integration.
- Deployment is limited to a trusted host reached locally or through a trusted
  private network; direct public-internet exposure is not supported.
- Git and GitHub surfaces are read/review-oriented. Caffold does not expose
  stage, commit, checkout, merge, rebase, reset, stash, publication, or review
  mutation controls.
- Worktree isolation is explicit and setup-only. Caffold does not automatically
  recognize an Issue or PR and continue the original request after preparation.
- Caffold owns cleanup only for worktrees it created and recorded. It does not
  adopt external worktrees or force-delete dirty managed worktrees.
- Conversation presents command and tool output but does not provide a full
  terminal, tmux, or Zellij workspace.
- Review uses unified diffs without durable hunk comments or annotations.
- Caffold does not duplicate Codex transcript or lifecycle state as a local
  source of truth.

## Supported scenarios

The current product supports these flows:

1. Start a Task in a selected cwd and see live repository/worktree context.
2. Continue and steer real Codex work through reconnects without replacing
   app-server-owned thread state.
3. Review files, diffs, Git state, and GitHub context on desktop, foldable, and
   phone layouts.
4. Approve or deny a command request and see the canonical outcome.
5. Explicitly prepare the same Task in an isolated worktree without moving dirty
   source changes by default.
6. Archive a clean managed worktree, restore it, and preserve the same Task,
   branch, and thread.
7. Return later and identify the Task, thread, branch, worktree, and current
   review state without remembering a terminal session.
