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

## Node contract tests

The package scripts are grouped by their production owner:

| Command | Boundary |
| --- | --- |
| `npm run test:appearance` | appearance settings and ownership |
| `npm run test:css-ownership` | stylesheet/component ownership |
| `npm run test:routes` | browser route contracts |
| `npm run test:task-state` | task list/detail/state projection |
| `npm run test:watch` | filesystem watch behavior |
| `npm run test:voice` | browser voice recorder contract |
| `npm run test:codex-protocol` | maintained app-server schema boundary |
| `npm run test:docs` | documentation links and required contributor entrypoints |
| `npm run test:release` | macOS packaging and release contracts |
| `npm run test:local-install` | local app replacement preflight and rollback ordering |
| `npm run test:playwright-config` | Playwright test-server port allocation and ownership |

Run individual commands while iterating. A cross-cutting frontend or release
change should run every affected row rather than relying on `test:e2e` alone.

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

## Codex live tests

The protocol schema check becomes live only when explicitly enabled:

```sh
CAFFOLD_CODEX_PROTOCOL_LIVE=1 npm run test:codex-protocol
```

The browser task loop uses a real authenticated Codex installation and consumes
model usage:

```sh
npm run test:codex-live
```

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
npm run test:system-status
npm run test:updater
npm run test:macos-runtime
npm run test:local-install
```

`test:macos-runtime` launches owned child processes and verifies both graceful
termination and the exact-PID forced fallback. `test:local-install` verifies
that an orphaned bundled server blocks replacement even after its listener is
gone, and that rollback ordering stops the failed runtime before restoring the
backup.

When changing the application wrapper, process lifecycle, packaging, updater,
or installer, also run:

```sh
npm run test:release
desktop/macos/package-app build
```

An actual replacement of `/Applications/Caffold Server.app` is direct runtime
validation, not an automated test. Perform it only when the change needs user
review in the installed application, then verify the expected build ID and port
owner as described in the macOS development guide.
