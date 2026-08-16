# Current Product Status

This document summarizes Caffold's implemented product and current support
boundaries.

## Available today

- `caffold serve` on supported macOS and glibc Linux hosts, plus the macOS
  menu-bar server wrapper and Linux Homebrew user service;
- native Linux x86_64 and aarch64 release archives and Homebrew Formula;
- browser/PWA access on the trusted host and tailnet-only Tailscale Serve;
- optional collision-safe `caffold tailscale enable`, `status`, and `disable`
  commands backed by an independently installed Tailscale CLI;
- managed, thread-backed Tasks with canonical app-server lifecycle;
- persistent app-server daemon plus replaceable proxy connection;
- prompts, steering, interruption, command and permission approvals, images,
  and local voice input in the Conversation surface;
- selectable managed Sections with fixed-directory Task creation;
- shared integrated Working Tree/Branch, file/source, Git Compare/Log, and
  GitHub review surfaces for repository-backed Tasks and Sections;
- explicit Task creation from GitHub Issue and Pull Request detail;
- same-Task preparation of a Caffold-managed worktree through
  `isolate_current_task`;
- opt-in transfer of staged, unstaged, and untracked changes with bounded
  recovery;
- archive/restore of Tasks and verified clean managed worktrees;
- explicit per-browser Web Push subscription and system notifications when a
  managed Task turn completes, fails, or is interrupted;
- responsive desktop, foldable, and phone layouts.

## Current boundaries

- Codex app-server is the required execution and thread-state integration.
- Deployment is limited to a trusted host reached locally or through a trusted
  private network; direct public-internet exposure is not supported.
- Git and GitHub surfaces are read/review-oriented. Caffold does not expose
  stage, commit, checkout, merge, rebase, reset, stash, publication, or review
  mutation controls.
- Worktree isolation is explicit and setup-only. Issue and Pull Request detail
  can explicitly start a Task that prepares a worktree, and Caffold does not
  automatically continue review or implementation after preparation.
- Caffold owns cleanup only for worktrees it created and recorded. It does not
  adopt external worktrees or force-delete dirty managed worktrees.
- Conversation presents command and tool output but does not provide a full
  terminal, tmux, or Zellij workspace.
- Review uses unified diffs without durable hunk comments or annotations.
- Caffold does not duplicate Codex transcript or lifecycle state as a local
  source of truth.
- Web Push is best-effort while the backend is running. It has no durable
  delivery queue, provider retry, or startup catch-up.
- Linux package verification targets Ubuntu 24.04 on x86_64 and aarch64.
  Other glibc distributions are not part of the direct CI contract; musl,
  ARM32, and 32-bit x86 are unsupported.
- Linux voice acceleration supports Vulkan with CPU fallback or explicit
  CPU-only execution. CUDA is not distributed.

## Supported scenarios

The current product supports these flows:

1. Start a Task from Global New or a managed Section's fixed directory and see
   live repository/worktree context.
2. Continue and steer real Codex work through reconnects without replacing
   app-server-owned thread state.
3. Select a repository Section or Task and review files, diffs, Git state, and
   GitHub context on desktop, foldable, and phone layouts.
4. Approve or deny a command or permission request and see the canonical
   outcome.
5. Start a Task from GitHub Issue or Pull Request detail and review its prepared
   managed worktree.
6. Explicitly prepare the same Task in an isolated worktree without moving dirty
   source changes by default.
7. Archive a clean managed worktree, restore it, and preserve the same Task,
   branch, and thread.
8. Return later and identify the Task, thread, branch, worktree, and current
   review state without remembering a terminal session.
