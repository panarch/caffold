# Current Product Baseline

> Internal scope document. This records the current shallow product boundary,
> not a public feature commitment.

Caffold's minimum useful shape is a web/PWA review console, Codex app-server
integration, and repository review workspace together. Scope reduction should
keep those pillars and limit the depth of each rather than turn Caffold into a
standalone diff viewer.

## Implemented baseline

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
- responsive desktop, foldable, and phone layouts;
- deterministic browser suites and opt-in real Codex live verification.

## Deliberately shallow boundaries

- unified diff before a full split-diff and hunk-comment workflow;
- read/review-oriented Git UI while mutation remains Codex-directed or manual;
- explicit setup-only worktree isolation before Issue/PR bootstrap automation;
- Caffold-created worktree ownership without adoption of external worktrees;
- clean managed-worktree archive removal without force deletion;
- one host/runtime owner before a central multi-host dashboard;
- command and tool output in Conversation rather than a full PTY workspace;
- GitHub review projection without automatic PR publication or mutation.

## Not in the current baseline

- stage, unstage, commit, merge, rebase, reset, checkout, or stash buttons;
- automatic Issue/PR recognition followed by worktree preparation and request
  continuation;
- automatic PR creation or review-comment publication;
- external worktree adoption or cleanup;
- force deletion of dirty managed worktrees;
- a full terminal, tmux, or Zellij workspace;
- durable duplication of Codex transcript or lifecycle state;
- a central multi-host dashboard;
- rich hunk review/comment state and test-failure-to-hunk linking.

## Acceptance scenarios

The current baseline is useful when these flows work:

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
