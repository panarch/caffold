# Worktree Lifecycle

> Internal planning note. This describes the intended lifecycle model before implementation.

Worktree lifecycle is a product-level decision in Caffold. It should be designed for Caffold's review workflow rather than copied wholesale from another surface.

## Principles

- A task normally has one worktree.
- A task normally has one Codex thread.
- The backend creates or attaches the worktree before starting the Codex thread.
- The Codex thread runs with the task worktree as cwd.
- Completed worktrees are preserved by default.
- Dirty worktrees are never deleted without explicit confirmation.
- Automatic cleanup is not part of the MVP.

## Naming

Names should be human-readable and recoverable.

The exact naming scheme is still open, but it should include enough context to identify:

- repository
- task intent
- branch or base
- creation time or stable task ID

Names should not optimize for cleverness over recovery.

## States

A worktree can be:

- planned
- creating
- ready
- active
- paused
- completed
- archived
- cleanup_requested
- cleanup_blocked

These states belong to Caffold metadata. The actual file state belongs to git.

## Cleanup

Cleanup should be conservative.

MVP behavior:

- no automatic deletion
- display dirty status before any cleanup action
- require explicit confirmation for destructive cleanup
- record cleanup requests and results in the operation ledger

Future behavior can add policies, but only after the review workflow is stable.

## Git Mutations

Caffold's initial git features are read/review oriented:

- status
- changed files
- diff
- diff stat
- file browser
- file content
- log
- branch and base info
- base branch diff

Git mutations should be performed by Codex, the user, or a later controlled Caffold flow with explicit confirmation.
