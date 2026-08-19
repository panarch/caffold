# Contributing to Caffold

Caffold is developed with the same review-first workflow it provides. Keep a
change scoped, make its state ownership visible, run the checks that exercise
the changed boundary, and record what was and was not verified.

## Development environment

The supported contributor baseline is:

- the Rust toolchain pinned by `rust-toolchain.toml`;
- Node.js 22 and npm;
- Git;
- CMake and the Xcode Command Line Tools on macOS;
- the authenticated standalone Codex CLI for live app-server work.

On macOS:

```sh
brew install cmake
xcode-select --install
```

The npm package lives in `frontend/`, so JavaScript and browser commands run
from that directory while Rust commands stay at the repository root. The
ordinary browser suite also needs Playwright's Chromium build:

```sh
cd frontend
npm ci
npx playwright install chromium
```

## Run a development server

Use a port and data directory distinct from the installed macOS application:

```sh
cargo run -- serve \
  --host 127.0.0.1 \
  --port 5177 \
  --root "$PWD" \
  --data-dir "$PWD/.caffold-dev" \
  --worktree-root "$PWD/.caffold-dev/worktrees"
```

The installed application normally owns port 5178 and stores data under
`~/Library/Application Support/Caffold/data`. Development servers, tests, and
live probes must not open that database. The command above keeps development
state under `.caffold-dev`; it may be removed when its local task history is no
longer needed.

For private phone or PWA testing, follow
[Mobile and PWA testing](docs/development/mobile-pwa-testing.md). For a local
application-bundle replacement, follow
[macOS local application development](docs/development/macos-local-app.md).

## Change workflow

1. Start from a dedicated branch or worktree when the change should be isolated.
2. Read the [review policy](docs/review/policy.md) and the affected area
   policy before editing.
3. Keep required production code, ownership changes, tests, fixtures, and
   documentation together in the same change.
4. Run focused checks first, then the broader checks appropriate to the change.
5. Inspect `git diff --check` and the final diff before committing.
6. State direct runtime/browser validation separately from source inference or
   mocked tests.

Do not use the installed application data, a user's unrelated checkout, or an
external worktree as an automated-test fixture. A Caffold-managed worktree may
only be removed using its recorded ownership and safety checks.

## Verification

The short baseline for a Rust change is:

```sh
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

Frontend and protocol changes have additional Node and Playwright suites.
macOS code has Swift and installer lifecycle checks under `desktop/macos/`.
Each suite is owned by the thing it verifies rather than by a single package
manifest, so the [testing guide](docs/development/testing.md) is the index of
what to run, where to run it from, and what it needs. It also covers the
live-test boundary and the coverage workflow.

## Documentation ownership

- `docs/product/` describes product behavior and direction. Unfinished behavior
  belongs in the roadmap rather than current workflow or surface documents.
- `docs/architecture/` defines implementation and source-of-truth boundaries.
- `docs/development/` contains reproducible contributor procedures.
- `docs/review/` contains repository-wide and area-specific review policy.
- `docs/operations/` contains maintainer procedures for supported artifacts.
- Machine-local runtime data and configuration, credentials, logs, PIDs, and
  generated output remain untracked.

These tracked documents are authoritative. When a supported workflow changes,
update its owning document and executable entrypoint in the same change.
