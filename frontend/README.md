# Caffold Frontend Package

This directory is Caffold's private npm package. It owns the browser sources the
Rust server embeds, their colocated unit tests, the frontend contracts under
`tests/contracts/`, the Playwright configuration, and the browser suites.

Run every JavaScript and browser command from this directory. Rust, packaging,
and release commands stay at the repository root.

```sh
cd frontend
npm ci
npx playwright install chromium
```

| Command | Boundary |
| --- | --- |
| `npm run test:unit` | colocated frontend unit tests |
| `npm run test:contract` | frontend contracts in `tests/contracts/`, plus the repository-level contracts still in `../tests/` |
| `npm run test:e2e` | deterministic fixture-backed browser coverage |
| `npm run test:codex-compat` | installed Codex CLI schema compatibility |
| `npm run test:codex-live` | authenticated Codex browser coverage |

[Testing](../docs/development/testing.md) documents what each boundary proves,
and indexes the suites other owners run — the macOS application tests under
`desktop/macos/` and the Rust checks at the repository root.

## Paths outside the package

The browser suite's workspace fixture lives with the suite in
`tests/e2e/fixtures/`, and the server is pointed at it by path. A test run's
working directory is this package rather than the repository root, so anything
reaching a repository-owned path — the Cargo `target/` directory, the server
binary, the shared `../tests/fixtures/fake-codex` stub that the Rust readiness
tests also use — must anchor through
[`tests/repository-paths.mjs`](tests/repository-paths.mjs) instead of the
working directory.

## Production sources

Browser sources are embedded by `src/static_assets.rs` at build time, so a new
runtime asset must be added there and precached by `service-worker.js`. Nothing
in `tests/` or `node_modules/` is part of that inventory.
