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

Caffold derives repository and Git worktree context from `thread.cwd` on every
response. When the requested cwd is inside a Git repository, current-directory
Tasks use the backend-only common Git directory as their list-filter identity.
Threads from the main checkout and sibling linked worktrees therefore appear
together. Each Task still retains its own canonical worktree root for Files and
Diff. Outside Git, current-directory Tasks use canonical cwd exact matching.
Unfiltered All Tasks remains available.

The derived worktree context contains only RootedFs-relative paths plus live
branch, HEAD, linked-worktree, and relative-cwd information. Caffold does not
persist that context in a Caffold registry or Codex metadata. A Task can open
Files at the derived worktree root and review its working-tree Diff directly.
Worktree creation, deletion, checkout, rename, prune, and cleanup remain
outside this Tasks slice.
Caffold keeps pending approvals and SSE notifications as ephemeral in-memory
state in this slice. Pending approval cards may disappear after a Caffold
backend restart until app-server re-emits the request.

Local task metadata/event storage is deferred and optional. If added later, it
should augment Codex threads with Caffold-only annotations rather than become
the required primary lookup path.

The Tasks surface uses the current cwd as its filter and New Task default.
Files, Git, and GitHub use the same logical cwd context without a local project
registry.

## Process Ownership

Default assumption:

- one Caffold backend instance per host
- one app-server child process per host instance
- multiple tasks/threads managed through that process

If implementation evidence shows that app-server isolation works better per
repository or per task, this can be revisited. The MVP should not start with
per-task app-server processes unless required.

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

## Live Verification

The regular Playwright suite mocks Codex app-server responses so it remains
deterministic and does not consume model usage. Before changing the Tasks turn
lifecycle, run the opt-in live check against an authenticated Caffold server:

```sh
npm run test:codex-live
```

The check uses `http://127.0.0.1:5178` and the current repository's logical
path from the filesystem root by default. Override them with
`CAFFOLD_LIVE_URL` and `CAFFOLD_LIVE_CWD` when the server uses another root.
It creates a real Codex thread with the low-cost `gpt-5.4-mini` model, reopens
that thread from Tasks, and verifies a follow-up turn through the browser UI.
This test is intentionally separate from `npm run test:e2e` because it
requires local Codex authentication and creates a persistent Codex thread.

## Open Questions

- Exact app-server startup mode and transport to use first
- How to represent partial failures and reconnects in the UI
- Whether thread history pagination is enough for long task timelines
- Whether optional Caffold annotations are useful after thread-backed tasks are
  stable
- How to surface protocol changes without leaking internals through the app
