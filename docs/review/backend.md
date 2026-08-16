# Backend And API Review Policy

This policy extends the common [Review Policy](policy.md) for backend,
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
- Trace every writer of externally owned state affected by a backend
  extraction. Routes, caches, databases, file watchers, and optimistic events
  must not become alternate writers for that state.
- Keep path handling rooted and canonicalized.
- Do not allow path escape through symlinks or traversal.
- Return clear JSON errors for unsupported files and operations.
- Treat external tools and services as integration boundaries.
- Avoid mutation unless the feature explicitly asks for it.
- Shape responses for review surfaces instead of exposing raw implementation
  details by default.

## Rust Module Boundaries

Apply the common [Source Module Ownership](policy.md#source-module-ownership)
rules when a Rust implementation expands beyond one file.

- `name.rs` and the modules it privately owns beneath `name/` form one ownership
  boundary. Implementation private to that boundary belongs beneath `name/`,
  not beside `name.rs` in its parent's namespace.
- Keep owner-private child module declarations private and give their items the
  narrowest visibility required by the owning module. Do not widen visibility
  to make an extracted implementation appear shared.

## Rust Test And Coverage Ownership

Rust unit tests should follow the implementation owner closely enough that a
reader can understand the behavior, its private state, and its regression
coverage in one place.

- Put tests for private functions, schemas, queries, conversions, and error
  paths in an inline `#[cfg(test)] mod tests` in the implementation file that
  owns that behavior.
- Do not use file-backed unit-test modules: no `#[cfg(test)] mod tests;`
  declarations, `src/**/tests.rs` files, or `src/**/tests/` hierarchies.
- If an inline test module makes its production file expose unrelated
  responsibilities, split the production implementation into coherent owners
  before colocating their tests. Do not use an external unit-test hierarchy to
  hide an oversized production owner.
- Do not widen a production API solely for test access.

If Rust integration tests are introduced, place them under the repository-level
`tests/` directory only when they exercise a real public crate, HTTP, process,
storage-backend, restart, or application boundary. Keep each behavior scenario
and its assertions visible in the owning test crate so the public contract reads
as executable documentation. Shared support may provide reusable setup,
fixtures, or transport helpers, but must not own behavior or assertions. Size,
asynchronous execution, or helper count alone does not make a test an
integration test.

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

## Storage Ownership

Keep storage modules aligned with physical persistence ownership.

- Outside immutable schema/migration code and shared store infrastructure, a
  `task_store` implementation module must correspond one-to-one with a physical
  application table. Do not add feature-named store modules for projections or
  workflows that combine tables.
- A table owner may enforce invariants across multiple rows of its own table,
  including dense ordering and lifecycle compaction.
- The application owner must compose cross-table reads and writes through the
  store's scoped read or transaction boundary. Keep response projection and
  external-service orchestration in that application owner, not in the store.
- A route handler may own a one-off composition. Repeated application behavior
  may move to a narrowly named application module, but not to a storage facade
  merely because it needs the same lock or transaction.

## Storage Migration Review

Treat every released storage schema and version transition as an immutable
historical contract.

- Migration orchestration owns version detection, ordered execution, staged
  replacement, final validation, and publication. A version transition owns
  only its fixed input and output versions.
- Keep each historical schema snapshot and transition independent from mutable
  application table definitions, row types, creation functions, and validators.
  Small duplicated definitions are intentional when they preserve that
  boundary.
- Adding schema version `N + 1` should add a new version snapshot and an
  `N`-to-`N + 1` transition. Update latest-version orchestration, fresh schema
  initialization, and end-to-end coverage without modifying older snapshots or
  transitions.
- Treat an older migration file changed by a new schema version as a review
  warning. Require a specific compatibility reason and regression coverage for
  any exception, such as correcting an actual historical migration defect or
  adapting mechanically to a compiler or dependency API change.
- Shared transaction, reporting, and temporary-file lifecycle helpers may be
  reused because they do not define a schema or data-conversion contract.

Review every migration with exact input-version, output-version, data
preservation, wrong-version rollback, migration-history, and supported
start-version coverage. Replacement migrations must also prove that
intermediate and final-validation failures preserve the original database and
remove staged state.

## Backend Verification

For narrow backend changes:

- run Rust unit tests that cover the changed boundary
- run formatting and clippy checks when Rust code changes
- test storage replacement, restart recovery, and external-tool behavior at
  their actual integration boundary when the change affects them
