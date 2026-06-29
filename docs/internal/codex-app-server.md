# Codex App Server

> Internal planning note. This captures the current integration direction and may change as app-server behavior is verified.

Codger should integrate with Codex through Codex app-server rather than by directly embedding internal Codex crates in the first implementation.

The reason is practical: Codger is an external review console, not a Codex internal fork.

## Why App Server

Codger needs:

- thread creation and lookup
- turn execution
- streamed agent events
- approval requests and responses
- follow-up prompts
- interruption
- access to Codex-managed session history

These needs fit the app-server boundary better than a simple CLI wrapper.

## Boundary

Codger should keep a narrow adapter layer around app-server.

The adapter should own:

- process spawn
- process health checks
- restart policy
- JSON-RPC request IDs
- request/response matching
- event stream handling
- app-server error normalization
- mapping app-server thread IDs to Codger task IDs

The rest of Codger should not depend directly on app-server protocol details.

## Process Ownership

Default assumption:

- one Codger backend instance per host
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
- How much of the app-server event stream should be snapshotted
- Whether thread history pagination is enough for long task timelines
- How to surface protocol changes without leaking internals through the app
