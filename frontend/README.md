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
| `npm run test:macos` | compiled Swift application behavior on macOS |
| `npm run test:codex-compat` | installed Codex CLI schema compatibility |
| `npm run test:codex-live` | authenticated Codex browser coverage |

[Testing](../docs/development/testing.md) documents what each boundary proves
and when to run it.

## Paths outside the package

A test run's working directory is this package, not the repository root, so
anything reaching a repository-owned path — fixtures under `../tests/fixtures/`,
the Cargo `target/` directory, the server binary itself — must anchor through
[`tests/repository-paths.mjs`](tests/repository-paths.mjs) rather than the
working directory.

## Production sources

Browser sources are embedded by `src/static_assets.rs` at build time, so a new
runtime asset must be added there and precached by `service-worker.js`. Nothing
in `tests/` or `node_modules/` is part of that inventory.
