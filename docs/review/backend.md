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
  implementation modules. When a separate test module contains owner-private
  coverage, classify each test by the behavior it protects and move those tests
  with that behavior.
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

### Current Adoption

Backend test ownership is only partially aligned with this policy. Only the
areas listed as completed below should be treated as reference implementations;
all other backend areas remain partially aligned or unclassified.

Completed reference area:

- `task_store` follows the owner-aligned structure described by this policy.
- Physical table behavior lives in `managed_section.rs`, `managed_thread.rs`,
  `managed_worktree.rs`, `push_installation.rs`, `push_vapid_key.rs`, and
  `schema_migration.rs`; immutable version snapshots live under
  `task_store/migration/schema`, while migration orchestration and each version
  transition live with their inline unit tests in their respective files.
- `task_store.rs` owns backend opening, locking, scoped access, transaction
  boundaries, and thin table facades instead of owning feature projections,
  cross-table workflows, or the table and migration test suites centrally.

Known incomplete areas:

- `src/app/tasks/tests.rs`, `src/app/tasks/tests/`, and
  `src/app/tasks/routes/tests.rs` contain a mixture of owner-private tests,
  route-boundary tests, and shared setup. Some production owners also have
  inline tests, but that does not complete the surrounding Tasks migration.
  Changes in those areas must classify the affected tests; private detail,
  projection, runtime, sync, and route behavior belongs with the owning
  implementation file, while genuine multi-module or HTTP contracts may remain
  separate.
- The external unit-test modules under `src/app/tests.rs`, `src/app/tests/`,
  `src/app/shell/tests.rs`, `src/app/workspace/tests.rs`, and
  `src/codex_thread_sessions/tests.rs` contain owner-private coverage outside
  the owning implementation files. These areas have not been fully classified
  or redistributed, and their location is not precedent for new owner-private
  tests.
- The repository has no canonical production-only coverage command or global
  coverage threshold in CI. Establish a repeatable command and exclusions
  before deciding whether a numerical gate is useful.

For each incremental conversion, leave the touched owner in a complete state:
production code, inline unit tests, true boundary tests, shared support,
coverage evidence, and obsolete test wiring should move or be removed in the
same change. High coverage in the touched files does not establish ownership
alignment for the surrounding area or move it into the completed list above.

## Backend Verification

For narrow backend changes:

- run Rust unit tests that cover the changed boundary
- run formatting and clippy checks when Rust code changes
- test storage replacement, restart recovery, and external-tool behavior at
  their actual integration boundary when the change affects them
