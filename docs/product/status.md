# Current Product Status

This document summarizes Caffold's implemented product and current support
boundaries.

## Available today

- `caffold serve` and the macOS menu-bar server wrapper;
- browser/PWA access on the trusted host and tailnet-only Tailscale Serve;
- responsive **Settings → Remote Access** status, private URL/QR handoff, and
  localhost-only control of Caffold's Tailscale Serve mapping;
- Tasks backed by either Codex or Claude Code, with the agent selected by model
  when the Task is created and fixed for the Task's lifetime;
- native Codex app-server integration, including its persistent daemon and
  replaceable Caffold proxy;
- native Claude Code CLI integration, including transcript recovery and the
  Caffold runner that carries sessions across backend replacement;
- shared prompts, active-turn steering, interruption, command and permission
  approvals, images, model/effort/permission choices, and local voice input in
  the Conversation surface;
- an optional provider-neutral Markdown current plan in each Task working
  directory, with live checklist progress and read-only Plan/Checklist viewing
  above the follow-up Composer;
- agent-owned model and permission semantics rather than Caffold-defined
  provider profiles;
- separate Codex and Claude Settings diagnostics, including Claude account,
  plan usage, and runner state as the CLI reports them;
- selectable managed Sections with fixed-directory Task creation;
- shared integrated Working Tree/Branch, file/source, Git Compare/Log, and
  GitHub review surfaces for repository-backed Tasks and Sections;
- explicit Task creation from GitHub Issue and Pull Request detail;
- same-Task preparation of a Caffold-managed worktree through
  `isolate_current_task` for both supported agents;
- opt-in transfer of staged, unstaged, and untracked changes with bounded
  recovery;
- archive/restore of Tasks and verified clean managed worktrees, plus explicit
  permanent deletion of an archived Task and its agent conversation;
- explicit per-browser Web Push subscription and system notifications when a
  managed Task turn completes, fails, or is interrupted, or when a Task stops
  to wait for an approval; and
- responsive desktop, foldable, tablet, and phone layouts.

## Current boundaries

- Codex and Claude Code are the complete built-in agent set. Caffold has no
  runtime agent plugin registry or ACP driver.
- A Task belongs to one agent. It cannot switch from Codex to Claude or from
  Claude to Codex in place.
- The agents do not share one synthetic runtime. Codex owns its app-server
  threads; Claude owns its transcript and CLI behavior; Caffold owns only the
  product state and process glue each integration needs.
- Support does not imply feature identity. Caffold shares a control or display
  concept only where its semantics have been verified for both agents and
  otherwise keeps the behavior agent-specific.
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
- Caffold does not duplicate either agent's transcript or canonical lifecycle
  state as a local source of truth.
- Current plans are filesystem documents rather than database or native agent
  Plan-mode state. Caffold does not edit them, archive their history, select a
  provider Plan mode, or replace Composer conversation with structured
  clarification forms. The exact document contract is defined in
  [Product Workflows](workflows.md#current-plan-documents).
- Web Push is best-effort while the backend is running. It has no durable
  delivery queue, provider retry, or startup catch-up.

## Supported scenarios

The current product supports these flows:

1. Start a Task from Global New or a managed Section's fixed directory, choose
   an available Codex or Claude model, and see live repository/worktree context.
2. Continue, steer, interrupt, and approve real work through the selected
   agent's native runtime without changing the Task's agent.
3. Reconnect the Caffold backend to an active Codex daemon thread or a
   runner-held Claude session without replacing the agent-owned conversation.
4. Select a repository Section or Task and review files, diffs, Git state, and
   GitHub context on desktop, foldable, tablet, and phone layouts.
5. Approve or deny a command or permission request and see the canonical
   outcome in the conversation.
6. Start a Task from GitHub Issue or Pull Request detail and review its prepared
   managed worktree.
7. Explicitly prepare the same Task in an isolated worktree without moving
   dirty source changes by default.
8. Archive a clean managed worktree, restore it, and preserve the same Task,
   branch, agent conversation, and review context.
9. Return later and identify the Task, agent, branch, worktree, and current
   review state without remembering a terminal session.

The detailed ownership and lifecycle differences are documented in
[Agent runtimes](../architecture/agent-runtimes.md).
