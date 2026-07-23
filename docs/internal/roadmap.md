# Roadmap

> Internal planning note. This roadmap is a working plan, not a release commitment.

This roadmap is ordered by product risk and workflow value, not by implementation glamour.

## Phase 0: Planning Skeleton

- README
- design docs
- MVP boundary
- architecture sketch
- open questions

## Phase 1: Host Console Skeleton

- Rust backend starts
- web UI is served
- Codex thread-backed task list and detail screens exist
- cwd-based Files context works without a local project registry
- managed thread membership and list state use one local GlueSQL table

## Phase 2: Git Review Surface

- read git status
- list changed files
- show unified diff
- show file content
- browse files
- run filename search and `rg`

## Phase 3: Codex App Server Integration

- spawn app-server child process
- initialize JSON-RPC adapter
- start or attach thread
- send prompt
- stream basic events
- interrupt turn
- send follow-up prompt

## Phase 4: Approval and Command Runner

- command approval UI
- accept, accept for session, decline, cancel
- command runner
- test presets
- command and test results in the task conversation

## Phase 5: Mobile Review Polish

- mobile and foldable layout pass
- stable task list on mobile
- readable diff on mobile
- approval actions usable on mobile
- reconnect state

## Later

- split diff
- hunk review state
- GitHub PR projection
- preview/screenshot panel
- tmux or Zellij escape hatch
- review summary generation
- test failure to file/hunk linking
- central multi-host dashboard
- cleanup policy
- controlled git mutation flows
