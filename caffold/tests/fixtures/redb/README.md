# GlueSQL storage format v3 fixtures

Each database was created by the Caffold revision listed below. All three
checkouts used GlueSQL revision `aae2a135`.

| Caffold checkout | Migration module | Compressed fixture |
| --- | --- | --- |
| `cd7824c6` | `src/task_store/migration.rs` | `v3-schema-4-unclean.redb.gz` |
| `941f92b7` (v0.28.2) | `caffold/src/task_store/migration.rs` | `v3-schema-16.redb.gz` |
| `5a652847` | `caffold/src/task_store/migration.rs` | `v3-schema-17.redb.gz` |

To regenerate, export each checkout to a separate temporary directory and
append [generate.rs](generate.rs) to the corresponding migration module.
For schemas 16 and 17, run `npm ci` in the checkout's `frontend/` directory.
Set `output_dir` to the absolute path of an empty directory and run these
commands from the checkout.

```sh
CAFFOLD_FIXTURE_DIR="$output_dir" cargo test --locked -p caffold --lib generate_gluesql_v3_fixture
gzip -n -9 "$output_dir"/*.redb
```

The schema 4 generator reopens the initialized database through Caffold's
Task store and exits with the writer open. Its test compares the refused
database with a copy that redb recovered on open.

The schema 16 and 17 fixtures contain a Task, its Section and Worktree, and
a versioned Note. Their Worktree paths are under `/fixture/worktrees`. To use
a different root with a live server, regenerate the fixture with
`CAFFOLD_FIXTURE_WORKTREE_ROOT` set to that server's absolute `--worktree-root`.
