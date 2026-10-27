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
| `npm run typecheck` | TypeScript types of the frontend's `.ts` modules |
| `npm run lint` | Biome formatting, import order, and lint rules of the frontend's `.ts` modules; `npx biome check --write` applies the fixes |
| `npm run test:unit` | colocated frontend unit tests |
| `npm run test:contract` | frontend contracts in `tests/contracts/` |
| `npm run test:e2e` | deterministic fixture-backed browser coverage |
| `npm run test:codex-live` | authenticated Codex browser coverage |

[Testing](../docs/development/testing.md) documents what each boundary proves,
and indexes the suites other owners run — the macOS application tests under
`desktop/macos/` and the Rust checks at the repository root.

## Paths outside the package

The browser suite's workspace fixture lives with the suite in
`tests/e2e/fixtures/`, and the server is pointed at it by path. A test run's
working directory is this package rather than the repository root, so anything
reaching a repository-owned path — the Cargo `target/` directory, the server
binary, the shared `../caffold/tests/fixtures/fake-codex` stub that the Rust
readiness tests also use — must anchor through
[`tests/repository-paths.mjs`](tests/repository-paths.mjs) instead of the
working directory.

## Production sources

Browser sources are embedded by `caffold/src/static_assets.rs` at build time,
so a new runtime asset must be added there and precached by
`service-worker.ts`. Nothing in `tests/` is part of that inventory. From
`node_modules/`, only the Lit modules a page reaches and `tslib` are. The
server embeds the Lit and `tslib` releases `package.json` pins under
`dependencies` and compiles each `.ts` module with the TypeScript release
pinned beside them, so a Cargo build needs `npm ci` here first and Node.js on
`PATH`. `npm ci --omit=dev` installs those three alone when the browser suites
and lint are not needed. To change a release, change its pin and run
`npm install`. The
[frontend architecture](../docs/architecture/frontend.md#native-module-imports)
describes how pages and unit tests load the compiled modules.
