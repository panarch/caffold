# Caffold

Caffold is scaffolding for agent-assisted development: a browser-based review and control surface that helps developers inspect, guide, and validate Codex-backed code work across git worktrees.

It runs Codex-powered development tasks on a trusted host and gives the developer a browser-based surface for reviewing task state, diffs, files, test results, approvals, and follow-up prompts.

Caffold is not an autonomous coding product, an IDE, or a replacement for the Codex GUI.

Its narrower goal is to make agent-generated code review practical away from the desktop app, including on mobile and foldable devices.

## Why

Foldable phones and wider mobile displays make it increasingly plausible to review real code changes away from a desk.

Agent-assisted development makes that more useful. The developer still makes the judgment calls, but more of the day-to-day work becomes reading diffs, checking tests, inspecting files, approving commands, and sending follow-up prompts instead of typing every edit by hand.

That shift makes a browser-based review console practical. The important surface is not a full editor. It is a fast, reliable way to inspect agent output and decide what should happen next.

For long-running code work, the hard part is often not the agent itself. It is the surface around the agent: finding the right session again, understanding which worktree changed, reading the diff without opening a full editor, approving commands remotely, and continuing the review loop from another device.

Codex remains the work execution engine. The git worktree remains the construction site. Caffold is the structure a developer uses to get close to the work, inspect it, guide it, and decide what is safe to keep.

## Shape

The intended shape is:

- a Rust backend running on each trusted host
- a browser/PWA frontend served by that backend
- Codex app-server managed as a child process
- JSON-RPC integration between the backend and Codex app-server
- GlueSQL with redb for Caffold-owned metadata and event history
- git worktrees as the source of truth for code changes
- Tailscale or another trusted private network for remote access

## Core Principle

Caffold should make agent output easier to inspect, question, accept, reject, and continue.

It should not try to become VS Code, a full git GUI, or a native mobile app.

## Run

Start the first read-only file browser slice:

```sh
cargo run -- serve
```

Then open the printed local URL. By default Caffold opens at `$HOME`, displays it as `~`, and allows read-only parent navigation up to the filesystem root.

For deterministic local testing, a bounded root can be supplied:

```sh
cargo run -- serve --root tests/fixtures/home
```

## Test

Run Rust checks:

```sh
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Run browser tests:

```sh
npm run test:e2e
```

Playwright tests verify behavior and write review screenshots under the ignored `test-results` directory. Caffold does not commit Playwright snapshot baselines; future CI visual checks should compare screenshots generated from `main` and the pull request head in the same runner.

## Documentation

Public-facing docs:

- [Vision](docs/public/vision.md)
- [Architecture](docs/public/architecture.md)

Internal planning notes:

- [MVP](docs/internal/mvp.md)
- [Roadmap](docs/internal/roadmap.md)
- [Workflows](docs/internal/workflows.md)
- [Codex App Server](docs/internal/codex-app-server.md)
- [Worktree Lifecycle](docs/internal/worktree-lifecycle.md)
- [Operation Ledger](docs/internal/operation-ledger.md)
- [UI Surfaces](docs/internal/ui-surfaces.md)
- [Frontend Structure](docs/internal/frontend-structure.md)
- [Security and Approvals](docs/internal/security-approvals.md)

## Status

This repository has an initial read-only web file browser slice. The broader Codex-connected review and control surface remains under active design and implementation.
