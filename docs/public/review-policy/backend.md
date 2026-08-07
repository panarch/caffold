# Backend And API Review Policy

This policy extends the common [Review Policy](../review-policy.md) for backend,
HTTP API, storage, filesystem, and external-tool changes.

## Backend And API Review

Backend changes should keep the browser API conservative unless the feature
explicitly introduces a mutation.

- Keep the application root limited to dependency construction, lifecycle
  shutdown, and router composition. Feature state and handlers belong to their
  route owner.
- Keep a route module's private state, HTTP DTOs, validation, handlers, and
  route registration together.
- Lower application modules must receive the narrow capability they need. They
  must not accept Axum extractors or a complete route state merely because the
  handler already has it.
- Do not move unrelated dependencies behind an `AppState`, generic
  `SharedState`, service locator, or catch-all `shared` module to make an
  extraction compile.
- Trace every external state writer during backend extraction. Routes, caches,
  databases, file watchers, and optimistic events must not become alternate
  writers for externally owned lifecycle state.
- Move regression tests and owner-specific fixtures with the production owner.
  Shared test support is only for fixtures used by more than one real owner;
  do not widen production visibility solely to let a test reach private
  implementation.
- Keep path handling rooted and canonicalized.
- Do not allow path escape through symlinks or traversal.
- Return clear JSON errors for unsupported files and operations.
- Treat external tools and services as integration boundaries.
- Avoid mutation unless the feature explicitly asks for it.
- Shape responses for review surfaces instead of exposing raw implementation
  details by default.

## Rust Test And Coverage Ownership

Rust unit tests should follow the implementation owner closely enough that a
reader can understand the behavior, its private state, and its regression
coverage in one place.

- Put tests for private functions, schemas, queries, conversions, and error
  paths in an inline `#[cfg(test)] mod tests` in the implementation file that
  owns that behavior.
- Reserve separate test modules and top-level `tests/` files for real module,
  HTTP, process, storage-backend, or application boundaries. A large test is
  not an integration test merely because it was moved out of its owner file.
- Do not build a parallel `tests.rs` or `tests/` hierarchy that mirrors private
  implementation modules. When such a legacy module is touched, classify each
  test by the behavior it protects and move owner-private tests with that
  behavior.
- Shared test support is for setup or fixtures used by more than one real
  owner. Assertions and behavior-specific helpers remain with the owner so the
  contract stays visible.
- Redistribute tests incrementally with the production area being changed.
  Keep each step reviewable and behavior-preserving rather than attempting a
  repository-wide test move.

Coverage is review evidence, not an ownership model or a reason to obscure a
test.

- Run focused tests first, then measure the affected production files with
  `cargo llvm-cov`. Report which production paths were measured and inspect
  their missing lines; do not improve a number by counting test or support
  code as product coverage.
- Add behavior-focused cases for valid uncovered paths. Do not expose private
  production APIs, add opaque helpers, combine unrelated scenarios, or rewrite
  readable assertions only to satisfy a percentage.
- Treat a high line-coverage number as incomplete evidence. Boundary failures,
  storage replacement, restart recovery, and browser/API integration still
  require tests at their actual boundary.
- Do not introduce a repository-wide coverage threshold until the command,
  exclusions, and supported integration environment are reproducible. A
  threshold must follow stable measurement and owner-aligned tests, not define
  them retroactively.

### Current Adoption

This is an adoption record, not a claim that the backend has completed the
transition. Update it when ownership moves.

Completed reference area:

- `thread_store` is the first owner-aligned backend slice. Physical table
  behavior lives in `managed_thread.rs` and `schema_migration.rs`; migration
  orchestration and the v0-to-v1 transformation live with their inline unit
  tests in their respective files.
- `thread_store.rs` retains facade and open/reopen behavior instead of owning
  the table and migration test suites centrally.
- The migration work was checked with focused unit tests, production-file
  coverage inspection, full library coverage, formatting, clippy, API tests,
  and the task-list API contract affected by the new completion state.

Still transitional:

- `src/app/tasks/tests.rs`, `src/app/tasks/tests/`, and
  `src/app/tasks/routes/tests.rs` contain a mixture of owner-private tests,
  route-boundary tests, and shared setup. They must be classified as their
  production owners are changed; private detail, projection, runtime, sync,
  and route behavior should move to the owning implementation file, while
  genuine multi-module or HTTP contracts may remain separate.
- The external unit-test modules under `src/app/tests.rs`, `src/app/tests/`,
  `src/app/shell/tests.rs`, `src/app/workspace/tests.rs`, and
  `src/codex_thread_sessions/tests.rs` predate this policy and have not yet
  been redistributed. Their location is not precedent for new owner-private
  tests.
- The repository does not yet expose one canonical production-only coverage
  command or enforce a global coverage threshold in CI. Establish the
  repeatable command and exclusions before deciding whether a numerical gate
  is useful.

For each incremental conversion, leave the touched owner in a complete state:
production code, inline unit tests, true boundary tests, shared support,
coverage evidence, and obsolete test wiring should move or be removed in the
same change. Do not mark the broader transition complete merely because the
touched files have high coverage.

## Backend Verification

For narrow backend changes:

- run Rust unit tests that cover the changed boundary
- run formatting and clippy checks when Rust code changes
- test storage replacement, restart recovery, and external-tool behavior at
  their actual integration boundary when the change affects them
