# MVP

> Internal planning note. This is a working scope document, not a public feature commitment.

The MVP should not shrink the product into a standalone diff viewer. Caffold's minimum viable shape includes the web console, Codex app-server integration, and review surface together.

The right way to reduce scope is to keep the main pillars and make each pillar shallow.

## Required Pillars

The MVP must include:

- `caffold serve` or equivalent host process
- browser/PWA access to the host
- Codex thread-backed Tasks with cwd-derived repository/worktree context
- Codex app-server process management
- backend-to-app-server JSON-RPC adapter
- Codex thread start and lookup
- Codex turn start, interrupt, and follow-up prompt support
- approval UI for command approvals
- changed files view
- unified diff viewer
- file browser and file viewer
- filename search and `rg` search
- command runner for explicit commands and test presets
- test result display
- Tailscale-friendly deployment assumptions

## Shallow First

The MVP can keep depth low:

- unified diff before split diff
- file-level review before hunk review state
- basic timeline before rich event filtering
- command runner before full PTY
- preset test commands before complex task pipelines
- one host instance before a central multi-host dashboard
- manual worktree cleanup before automated cleanup policy
- simple PWA shell before native mobile polish

## Excluded From MVP

The MVP should exclude:

- stage, unstage, commit, merge, rebase, reset, checkout, and stash UI
- automatic PR creation
- GitHub projection
- full terminal workspace
- tmux or Zellij integration
- screenshot or preview panels
- central multi-host dashboard
- automatic worktree deletion
- Caffold-owned duplication of Codex thread history
- duplication of all Codex transcript data

## Acceptance Scenarios

The MVP is useful when these flows work:

1. Create a task from the web UI in a selected cwd, start a Codex thread, and see its live repository/worktree context.
2. Review changed files and diffs from a mobile or foldable screen without opening an editor.
3. Approve or deny a command request remotely and see the decision recorded.
4. Run a test preset, inspect the result, and keep that result attached to the task.
5. Send a follow-up prompt after reading a diff or file.
6. Reopen the console later and know which worktree and Codex thread belong to the task.
