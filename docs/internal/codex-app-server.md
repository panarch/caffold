# Codex App Server

> Internal planning note. This captures the current integration direction and may change as app-server behavior is verified.

Caffold should integrate with Codex through Codex app-server rather than by directly embedding internal Codex crates in the first implementation.

The reason is practical: Caffold is an external review console, not a Codex internal fork.

## Why App Server

Caffold needs:

- thread creation and lookup
- turn execution
- streamed agent events
- approval requests and responses
- follow-up prompts
- interruption
- access to Codex-managed session history

These needs fit the app-server boundary better than a simple CLI wrapper.

## Boundary

Caffold should keep a narrow adapter layer around app-server.

The adapter should own:

- process spawn
- process health checks
- restart policy
- JSON-RPC request IDs
- request/response matching
- event stream handling
- app-server error normalization
- thread-oriented APIs for listing, reading, starting, steering, interrupting,
  and resolving approvals

The rest of Caffold should not depend directly on app-server protocol details.

## Task Storage Boundary

The first Tasks surface is thread-backed. Codex app-server is the source of
truth for:

- thread identity
- thread cwd
- prompt and assistant transcript
- reasoning summaries/content
- command executions and output
- file changes
- turn status and history

Caffold derives project membership from `thread.cwd`. Project-scoped task
routes prefix-filter threads against the registered project root. Global
current-directory task routes use exact `cwd` filtering so opening Tasks from a
directory does not automatically show unrelated subdirectory or sibling threads.
Caffold keeps pending approvals and SSE notifications as ephemeral in-memory
state in this slice. Pending approval cards may disappear after a Caffold
backend restart until app-server re-emits the request.

Local task metadata/event storage is deferred and optional. If added later, it
should augment Codex threads with Caffold-only annotations rather than become
the required primary lookup path.

The first Tasks surface can run without a registered project. A registered
project supplies optional filtering, cwd defaults, and Git diff review
integration; otherwise the current Caffold root/path context is used as the
thread cwd. Worktree creation, cleanup, and checkout UX are separate lifecycle
features.

## Process Ownership

Default assumption:

- one Caffold backend instance per host
- one app-server child process per host instance
- multiple tasks/threads managed through that process

If implementation evidence shows that app-server isolation works better per project or per task, this can be revisited. The MVP should not start with per-task app-server processes unless required.

## CLI Wrapper Boundary

Codex CLI wrapping is still useful for fallback and diagnostics, but it is not the main integration path.

The CLI is better suited for:

- sanity checks
- debugging
- manual resume
- one-off execution

The app-server path is better suited for:

- rich client behavior
- approvals
- event streaming
- history-aware thread control
- structured follow-up from UI actions

## Open Questions

- Exact app-server startup mode and transport to use first
- How to represent partial failures and reconnects in the UI
- Whether thread history pagination is enough for long task timelines
- Whether optional Caffold annotations are useful after thread-backed tasks are
  stable
- How to surface protocol changes without leaking internals through the app
