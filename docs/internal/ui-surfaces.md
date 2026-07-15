# UI Surfaces

> Internal planning note. These surfaces describe product intent before UI implementation.

Caffold UI should be dense, review-oriented, and useful on mobile. It should not feel like a marketing site or a general IDE.

## Task List

Shows:

- tasks
- repository and worktree context derived from each thread cwd
- status
- recent event
- changed file count
- latest test status

The task list is the recovery surface. A user returning later should know where to resume.

## Task Timeline

Shows:

- task lifecycle events
- Codex turn events
- approval decisions
- command and test results
- interruptions and resumes
- follow-up prompts

The timeline should explain what happened without requiring the user to scroll through a full transcript first.

## Approval UI

MVP approval UI should support:

- command approval
- accept
- accept for session
- decline
- cancel
- visible approval result in the thread-backed conversation

File-change approval is a different concept. It can start as review annotation or task status, not as a permission mechanism.

## Changed Files

The changed files view is the center of the product.

It should show:

- file path
- change type
- insertions/deletions
- selection state
- quick open
- diff open

## Diff Viewer

MVP diff viewer:

- unified diff
- file-level navigation
- hunk-level anchors if cheap
- copyable context for follow-up prompt
- mobile-readable layout

Later:

- split diff
- hunk review state
- comment or note state
- related test failure links

## File Browser

The file browser supports editor-free inspection.

It should include:

- worktree file tree
- file content viewer
- changed and unchanged files
- filename search
- `rg` search
- quick related file opening

## Command Runner

The command runner is not a full terminal.

MVP behavior:

- cwd fixed to the task worktree
- explicit command display
- output display
- exit code
- start/end timestamps
- thread-backed task context
- test presets

Full PTY, tmux, or Zellij integration is an escape hatch for later.
