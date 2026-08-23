# Testing Caffold

Run the smallest test that exercises the changed owner first. Before handoff,
expand to every boundary affected by the change. A mocked browser test,
protocol/schema check, live agent run, and installed macOS application check
provide different evidence and must be reported separately.

## Setup

The npm package lives in `frontend/`. Run every JavaScript and browser command
from that directory; Rust and release commands stay at the repository root.

Use Node.js 22 and the committed npm lockfile:

```sh
cd frontend
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
when the change crosses storage, process, HTTP, Git, or agent integration
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

Commands are owned by the thing they verify rather than by one package, so each
one records where it runs from and what it needs:

| Command | Run from | Requires | Boundary |
| --- | --- | --- | --- |
| `npm run test:unit` | `frontend/` | Node | all focused frontend Node unit tests |
| `npm run test:contract` | `frontend/` | Node | frontend policy and browser-infrastructure contracts, plus the repository, release, and protocol contracts that have not yet moved to an owner |
| `npm run test:e2e` | `frontend/` | Node, Chromium, a built server | deterministic fixture-backed Playwright coverage |
| `cargo test --test codex_protocol -- --ignored` | repository root | installed Codex CLI | Codex CLI schema compatibility without authentication or model usage |
| `npm run test:codex-live` | `frontend/` | authenticated Codex CLI | authenticated Codex browser coverage with model usage |
| `cargo test -p caffold-claude-runner --test live -- --ignored` | repository root | authenticated Claude CLI | that Claude still returns an unanswered permission request to a client that reattaches, with model usage |
| `cargo test -p caffold --test claude_live -- --ignored --test-threads=1` | repository root | authenticated Claude CLI | what a person sees when the backend is replaced or the runner is killed under a working Claude Task, that each permission decision does what it says, that the agent reaches the tool Caffold serves it, and that the installation reports its status, with model usage |
| `node --test docs/tests/*.test.mjs` | repository root | Node | documentation index, links, entrypoints, and this command index |
| `node --test scripts/tests/*.test.mjs` | repository root | Node | repository tooling behavior, such as the release version bump |
| `desktop/macos/test-contracts` | repository root | Node | macOS packaging, release, and installer contracts, from `desktop/macos/tests/` |
| `desktop/macos/test-runtime` | repository root | macOS, Xcode tools | Swift wrapper process lifecycle |
| `desktop/macos/test-system-status` | repository root | macOS, Xcode tools | Swift system-status behavior |
| `desktop/macos/test-updater` | repository root | macOS, Xcode tools | Swift updater behavior |

The macOS contracts verify shell scripts, workflow definitions, and
documentation, so they run on any platform and belong in the ordinary pull
request checks. Only the Swift programs and the one packaging-metadata check
need a macOS host; that check skips itself elsewhere.

Every test belongs to the thing it verifies. Owners outside the frontend
package keep their Node contracts in a `tests/` directory of their own and are
invoked by path: `docs/tests/` verifies the documentation, `scripts/tests/`
verifies the repository tooling, and `desktop/macos/tests/` verifies the macOS
application. The frontend package keeps its own under
`frontend/tests/contracts/`.

The workspace has two Rust members, and each keeps its tests with it. The
server is `caffold/`, and `caffold/tests/` holds its Cargo integration tests
and the fixtures the backend shares — today the Codex protocol contract and the
stub Codex CLI that the readiness tests and the browser server both use. The
Claude runner is `runners/claude/`, and `runners/claude/tests/` holds its own:
a suite driven by a stand-in agent, which is deterministic and spends no model
usage, and the opt-in live check above. `cargo test` from the repository root
covers every member, so neither needs its own job.

A test written in Node does not make it frontend material, and a contract on
the backend's own boundary belongs to the backend even when a different harness
would be easier.

Continuous integration follows the same ownership. Pull-request checks run one
job per owner, and each job name says both whose it is and what kind of
verification it performs:

| Job | Verifies |
| --- | --- |
| Frontend Tests | colocated units and frontend contracts |
| Documentation Contracts | the documentation index, links, and command index |
| Repository Tooling Tests | the release version tooling, by calling it |
| macOS Packaging Contracts | packaging, release, and installer definitions |
| Browser Tests / _viewport_ | browser behavior, one job per viewport |
| Rust Checks | formatting, lints, and the Rust suites |

A failing check therefore names its owner without being opened. The contract
jobs read shell scripts, workflow definitions, and documentation rather than
running a macOS application, so `macOS Packaging Contracts` needs no macOS host
and runs on the ordinary Ubuntu runner.

The release workflow keeps all of this in one linear job on the macOS host,
because it is a gate in front of an artifact rather than feedback on a change.
It re-runs every pull-request suite and adds what needs that host: the Swift
programs and the packaging verification. A contract keeps the split honest —
every suite must run where it can run, and the release gate must not be weaker
than the pull-request checks.

Focused Node unit tests live beside their owning frontend module as
`name.test.js`. They may import that module directly, but must not require
test-only exports from a public entry point. Production ownership scans, the
static import graph, the Rust asset table, and the service-worker shell
inventory exclude colocated `*.test.js` files.

Contracts that compare multiple production owners belong to the owner they
verify. Frontend policy, asset, layout, and browser-infrastructure contracts
live in `frontend/tests/contracts/`, beside the Playwright configuration, its
Node support modules, and the browser suites under `frontend/tests/e2e/` and
`frontend/tests/live/`.

Run an individual contract directly with `node --test` while iterating. A
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

Every browser test declares the smallest viewport coverage that exercises its
contract. Use `@desktop`, `@foldable`, or `@phone` for one-project coverage,
combine project tags when two viewports own the behavior, and use
`@all-viewports` only when the observable behavior must hold in all three.
Viewport-independent behavior uses desktop as its canonical project; touch-only
behavior uses foldable unless the phone's single-pane contract is relevant.
These are Playwright test-detail tags, not title suffixes. Runtime project-name
skips are not a coverage declaration.

Pull-request and `main` checks run desktop, foldable, and phone in independent
matrix jobs. Each job starts its own server and selects only its coverage tags;
the stable `Browser Tests` gate requires all three jobs to pass. The ordinary
local command still runs the complete tagged suite in one Playwright invocation.

Test-server ports belong to individual Playwright runs, including runs in other
worktrees. Do not stop a process merely because it owns a port used by an older
test command; let Playwright shut down its own server, or retry a failed run.

For layout changes, inspect the generated screenshots under `test-results` and
exercise the relevant desktop, foldable, and phone projects. For fixture or
shared-state changes, compare normal parallel execution with `--workers=1`.

`frontend/tests/e2e/showcase.spec.js` owns a small documentation-oriented desktop
scenario. Its dedicated fixture presents a completed review-first Task and a
representative Working Tree diff without an authenticated Codex session. Run it
with:

```sh
npm run test:e2e -- tests/e2e/showcase.spec.js --project=desktop
```

The test writes candidate screenshots under `test-results`. They are review
artifacts rather than committed visual baselines or live app-server evidence.
After visual review, the README copies live under `docs/assets`; refresh those
files only from a passing showcase run so the documented UI remains
reproducible.
Keep the showcase copy concise and representative; edge cases and layout stress
data belong in the owning behavioral fixtures.

Foreground recovery changes require the adjacent unit tests, the owning
Playwright lifecycle spec, and, when platform signals are affected, the
installed-Android checks in `mobile-pwa-testing.md`. These are separate
unit, browser-integration, and platform evidence.

PWA build-handoff changes require the adjacent unit tests,
`frontend/tests/contracts/service-worker.test.mjs`, and
`frontend/tests/e2e/app-shell-update.spec.js`. The loopback lifecycle server provides
real Chromium service-worker replacement coverage. Its core recovery case keeps
an old document alive after the target controller takes over, drops the first
navigation, verifies that page resume does not repeat it automatically, and
requires a second explicit Reload action to replace the document. No handoff
target is persisted across documents; a fresh page
reconstructs update availability from browser and server state. The loopback
test arms its exact waiting worker through a fixture-only `MessageChannel` and
waits for that worker to acknowledge the production activation request. It then
uses `ServiceWorker.stopAllWorkers` inside the isolated browser context to clear
the active worker's internal pending-event boundary without waiting for CDP
version events. It rearms the page's original waiting worker, verifies its build
ID again, and invokes `skipWaiting()` in that build's Playwright service-worker
runtime without another extendable message event. CDP does not select or
activate the waiting worker. Activation completion is the page's original
worker object's `statechange`. The gate records every boundary so the
waiting-to-active edge does not infer progress from scheduling latency or
registration-slot polling.
Production activation behavior remains separate contract and mocked-browser
evidence. Report unit, complete-shell inventory, deterministic browser, and
real-browser evidence separately.

## Codex compatibility and live tests

The installed CLI compatibility check does not authenticate or start a Codex
session and does not consume model usage:

```sh
cargo test --test codex_protocol -- --ignored
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

## Claude compatibility and live tests

The runner's deterministic suite uses a stand-in process and spends no model
usage. Its ignored live check verifies the one boundary a stand-in cannot:
whether the installed Claude CLI redelivers an unanswered permission request
after the client reattaches.

```sh
cargo test -p caffold-claude-runner --test live -- --ignored
```

The backend live suite drives the shipped Caffold server and runner against an
authenticated Claude CLI:

```sh
cargo test -p caffold --test claude_live -- --ignored --test-threads=1
```

It covers Task execution and approvals, transcript recovery, backend
replacement during a turn, stale-child cleanup after a runner is killed,
Caffold-served tools, managed-worktree movement, and installation status. It
spends model usage and is serialized because the scenarios share the installed
account and exercise process-start ordering. Re-run it when changing the
minimum Claude version, protocol reader, runner lifecycle, approval mapping, or
served tools.

## macOS application tests

`desktop/macos/` owns its own tests. Their sources live in
`desktop/macos/tests/`, beside the production Swift they compile against.

The Swift programs require macOS and the Xcode command-line tools:

```sh
desktop/macos/test-runtime
desktop/macos/test-system-status
desktop/macos/test-updater
```

Each compiles the production wrapper source together with its test program. The
runtime test launches owned child processes and verifies both graceful
termination and the exact-PID forced fallback.

The packaging, release, and local-install contracts need only Node:

```sh
desktop/macos/test-contracts
```

The local-install contract uses controlled fake system tools to verify that an
orphaned bundled server blocks replacement and that rollback stops a failed
runtime before restoring the backup. The one check that reads real packaging
metadata skips itself off macOS arm64.

When changing the application wrapper, process lifecycle, packaging, updater,
or installer, also run:

```sh
desktop/macos/package-app build
```

An actual replacement of `/Applications/Caffold Server.app` is direct runtime
validation, not an automated test. Perform it only when the change needs user
review in the installed application, then verify the expected build ID and port
owner as described in the macOS development guide.
