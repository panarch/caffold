# Testing Caffold

Run the smallest test that exercises the changed owner first. Before handoff,
expand to every boundary affected by the change. A mocked browser test, protocol
schema check, live Codex run, and installed macOS application check provide
different evidence and must be reported separately.

## Setup

Use Node.js 22 and the committed npm lockfile:

```sh
npm ci
npx playwright install chromium
```

Rust checks use the 1.96 toolchain pinned by `rust-toolchain.toml` and bounded by
`Cargo.toml`'s minimum supported version.

## Rust

```sh
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

Prefer an owner-focused `cargo test <name>` while iterating. Run the full suite
when the change crosses storage, process, HTTP, Git, or Codex integration
boundaries.

Coverage is supporting evidence, not a replacement for boundary tests. When
`cargo-llvm-cov` is installed, measure the affected production path and inspect
its missing lines:

```sh
cargo llvm-cov --summary-only
cargo llvm-cov report --text --show-missing-lines
```

Caffold does not currently enforce a repository-wide coverage percentage.
Explain the production paths measured and any integration boundary the coverage
run did not exercise.

## JavaScript and browser tests

Package commands expose execution boundaries rather than individual test files:

| Command | Boundary |
| --- | --- |
| `npm run test:unit` | all focused frontend Node unit tests |
| `npm run test:contract` | top-level repository, policy, build, release, protocol, and browser-infrastructure contracts |
| `npm run test:e2e` | deterministic fixture-backed Playwright coverage |
| `npm run test:macos` | compiled Swift application behavior on macOS |
| `npm run test:codex-compat` | installed Codex CLI schema compatibility without authentication or model usage |
| `npm run test:codex-live` | authenticated Codex browser coverage with model usage |

Focused Node unit tests live beside their owning frontend module as
`name.test.js`. They may import that module directly, but must not require
test-only exports from a public entry point. Production ownership scans, the
static import graph, the Rust asset table, and the service-worker shell
inventory exclude colocated `*.test.js` files.

Keep tests under `tests/` when they compare multiple production owners or
validate repository policy, inventories, build/release behavior, protocols, or
browser-test infrastructure. `test:contract` discovers every top-level
`tests/*.test.mjs` file, while Playwright specs remain under `tests/e2e/`. Run
an individual top-level test directly with `node --test` while iterating. A
cross-cutting frontend or release change should run every affected boundary
rather than relying on `test:e2e` alone.

## Browser tests

```sh
npm run test:e2e
```

Each regular Playwright invocation selects an available loopback port, starts
its own Caffold server with `reuseExistingServer: false`, and uses isolated
fixture data. It runs desktop, foldable, and phone projects. Its Codex responses
are deterministic fixtures, so it does not prove compatibility with the
installed Codex app-server. Set `CAFFOLD_E2E_PORT` to an available port only for
targeted diagnostics; an occupied override fails instead of attaching to that
server.

Test-server ports belong to individual Playwright runs, including runs in other
worktrees. Do not stop a process merely because it owns a port used by an older
test command; let Playwright shut down its own server, or retry a failed run.

For layout changes, inspect the generated screenshots under `test-results` and
exercise the relevant desktop, foldable, and phone projects. For fixture or
shared-state changes, compare normal parallel execution with `--workers=1`.

Foreground recovery changes require the adjacent unit tests, the owning
Playwright lifecycle spec, and, when platform signals are affected, the
installed-Android checks in `mobile-pwa-testing.md`. These are separate
unit, browser-integration, and platform evidence.

PWA build-handoff changes require the adjacent unit tests,
`tests/service-worker.test.mjs`, and
`tests/e2e/app-shell-update.spec.js`. The loopback lifecycle server provides
real Chromium service-worker replacement coverage. Its core recovery case keeps
an old document alive after the target controller takes over, drops the first
navigation, verifies that page resume does not repeat it automatically, and
requires a second explicit Reload action to replace the document. No handoff
target is persisted across documents; a fresh page
reconstructs update availability from browser and server state. The loopback
test addresses its exact waiting worker through a fixture-only activation
control to make the waiting-to-active edge deterministic; production activation
messaging remains separate contract and mocked-browser evidence. Report unit,
complete-shell inventory, deterministic browser, and real-browser evidence
separately.

## Codex compatibility and live tests

The installed CLI compatibility check does not authenticate or start a Codex
session and does not consume model usage:

```sh
npm run test:codex-compat
```

It runs `codex app-server generate-ts --experimental` and verifies the schema
contract required by Caffold. The command requires a supported Codex CLI on the
local executable search path.

The browser task loop uses a real authenticated Codex installation and consumes
model usage:

```sh
npm run test:codex-live
```

The run prints a usage summary and writes
`test-results/codex-live-usage.json`. Per-test and per-model token breakdowns
come from the final cumulative `thread/tokenUsage/updated` notification for
each thread. The report also snapshots account lifetime tokens and both the
overall and named model rate-limit windows before and after the suite.

Live scenarios use `low` reasoning effort. Spark-specific coverage uses
`gpt-5.3-codex-spark`; Fast-mode and multimodal coverage use `gpt-5.6-luna`.

Rate-limit `usedPercent` values have integer resolution, so a non-zero live run
can legitimately report a `0pp` change. Account snapshots can also include
other Codex activity on the same subscription during the run; use the thread
token totals when the live suite itself must be isolated precisely.

By default each invocation selects an available loopback port and starts an
isolated server with runtime files below `target/`. It creates real Codex
threads and archives the threads it records during teardown. It is serialized
and separate from the deterministic browser suite. `CAFFOLD_LIVE_PORT` pins an
available local port for diagnostics. `CAFFOLD_LIVE_URL` and `CAFFOLD_LIVE_CWD`
are advanced overrides; do not point them at the installed application's data
directory.

Use `node scripts/dev/probe-codex-app-server.mjs THREAD_ID` for an explicit
maintainer probe of resume/read/page latency and payload size. The probe does
not send a prompt, but it does resume the supplied thread through a temporary
app-server connection.

## macOS application tests

These checks require macOS and Xcode command-line tools:

```sh
npm run test:macos
```

The command compiles and runs the Swift runtime, system-status, and updater test
programs. The runtime test launches owned child processes and verifies both
graceful termination and the exact-PID forced fallback.

The Node-hosted macOS packaging, release, and local-install contracts remain
part of `test:contract`. The local-install contract uses controlled fake system
tools to verify that an orphaned bundled server blocks replacement and that
rollback stops a failed runtime before restoring the backup.

When changing the application wrapper, process lifecycle, packaging, updater,
or installer, also run:

```sh
npm run test:contract
desktop/macos/package-app build
```

An actual replacement of `/Applications/Caffold Server.app` is direct runtime
validation, not an automated test. Perform it only when the change needs user
review in the installed application, then verify the expected build ID and port
owner as described in the macOS development guide.
