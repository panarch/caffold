# macOS Release Process

This document separates reversible local release preparation from public
distribution. Caffold ships an arm64 macOS menu bar app through Homebrew.
Developer ID signing, Apple notarization, Intel builds, and Linux packaging are
not supported. Installed apps update through Homebrew only when someone starts
`caffold update`, which puts the previous app back when the new one does not
start; see [Application update lifecycle](#application-update-lifecycle).

## Version ownership

`caffold/Cargo.toml` is the application version source; `frontend/package.json` and the Caffold package entry in `Cargo.lock` must contain the same value. `scripts/bump-release-version.mjs` validates all three values before changing them and supports stable `major`, `minor`, and `patch` increments.

The manual Release workflow first runs the shared Ubuntu checks on the dispatch commit. For `release-patch`, `release-minor`, or `release-major`, the subsequent macOS job creates one local `Release v<version>` candidate commit that changes only `caffold/Cargo.toml`, `frontend/package.json`, and `Cargo.lock`. macOS tests, packaging, and publication use this final candidate SHA. The job pushes it to `main` only after macOS verification and artifact upload succeed. The shared browser and other Ubuntu checks run before the version bump.

The app bundle uses:

- `CFBundleShortVersionString`: the application version
- `CFBundleVersion`: the build time in Unix epoch seconds
- `CaffoldBuildCommit`: the source commit, suffixed `-dirty` for an unclean tree
- `CaffoldBuildTimestamp`: the same build time as a local date and time
- the Rust build ID: the source commit plus its build timestamp

`CFBundleVersion` must never decrease between builds on one machine, because macOS resolves a bundle identifier partly by that value and one machine installs from several branches and worktrees. Commit depth is neither ordered nor unique across them; build time is. That value identifies a build for macOS only, so nothing derives it from a commit and no verification recomputes it.

## Local preparation

Run from a clean `main` worktree:

```sh
desktop/macos/release --dry-run
```

The command performs no publication or repository mutation. Cargo may download locked dependencies when they are not already cached. The command:

1. rejects a dirty worktree, a non-`main` branch, a version mismatch, or a non-arm64 host;
2. builds the Rust backend and Claude runner with
   `cargo build --release --locked`;
3. builds and ad-hoc signs `Caffold Server.app`;
4. checks the bundle identifier, version, build number, source commit, build timestamp, and macOS 14 minimum;
5. checks that the Swift wrapper and Rust server both contain arm64 code;
6. verifies the bundle signature;
7. creates a versioned zip, extracts it into a temporary directory, and repeats the bundle checks on that copy;
8. writes and verifies a SHA-256 checksum beside the archive; and
9. confirms packaging did not change the source worktree.

The output under `target/caffold-server` is generated build output. A
successful dry run is evidence that the current source can produce the release
artifact; it does not publish anything.

## GitHub workflow

`.github/workflows/release.yml` exposes preparation, versioning, publication, and recovery through one manual `Release` workflow. Its required `action` input has five unambiguous choices:

- `dry-run` verifies and packages the currently committed version without repository or public mutation.
- `release-patch`, `release-minor`, and `release-major` increment the current version locally, verify that exact candidate, then push and publish it.
- `resume` does not change the version. It reconciles the currently committed version with its tag, GitHub Release, and Homebrew Cask after a partial failure.

The Checks and Release entrypoints directly call the same owner workflows on Ubuntu. Each checks out the caller's commit and takes no release-specific inputs:

- `frontend-tests.yml`: frontend units and contracts.
- `documentation-contracts.yml`: documentation contracts.
- `repository-tooling-tests.yml`: release version tooling.
- `macos-packaging-contracts.yml`: portable packaging and installer contracts.
- `browser-tests.yml`: the desktop, viewport-independent, foldable, and phone matrix, with one worker and an isolated fixture workspace per job. Browser configuration and retry behavior match ordinary CI.
- `rust-checks.yml`: formatting, locked tests, and locked Clippy.

Only after every shared check succeeds does Release call `macos-release.yml`. This workflow keeps source preparation, native verification, packaging, and source push in one macOS arm64 job:

1. requires `main`, checks out the dispatch commit with full history and no persisted credentials, and confirms that `main` still points to that commit;
2. for a new release, bumps the three version files, rejects an already-used version, and creates the candidate commit once locally;
3. runs packaging contracts, Swift application tests, and Rust formatting, tests, and Clippy on that source;
4. builds and verifies the macOS archive, then uploads the zip and SHA-256 file as seven-day artifacts; and
5. for a new release, confirms the checked-out source is unchanged and `main` has not moved, then pushes the exact packaged commit.

The candidate stays in that runner's worktree throughout; no Git bundle or candidate-restoration action is needed. The common browser and other Ubuntu tests cover the dispatch commit before the version bump. Native macOS tests and packaging cover the final version.

The macOS job has `contents: write` for its final source push. It configures Git push authentication only after tests, packaging, and artifact upload succeed, and never receives the Homebrew token. A failed or skipped common check prevents the job from starting. A failed macOS check, build, upload, or stale `main` check prevents the push and subsequent publication. A failure after a completed push can be recovered through `resume`.

The `macOS Release` workflow also supports manual dispatch from `main`, with `action` restricted to `dry-run`. The input description explains that it runs macOS tests, packages the app, and uploads artifacts without changing the version, pushing source, or publishing. That run uses the dispatch commit and does not run browser tests. Release `dry-run` and `resume` also skip version changes and source push, but run all shared and macOS checks.

With `action: dry-run`, no publication job runs. The artifact is for inspecting the runner-built output and is not a stable distribution URL.

With any `release-*` action or `resume`, two publication jobs run after the macOS job succeeds, including its source push for a new release. `publish_release` receives `contents: write` only for `panarch/caffold`; it creates or reconciles the GitHub Release without receiving the tap token. After that succeeds, `publish_homebrew` uses the `release` environment, keeps only `contents: read` for Caffold, and receives the `HOMEBREW_TAP_TOKEN` environment secret, whose fine-grained access is limited to `panarch/homebrew-tap`. Together they:

1. download and recheck the exact artifact produced by the verification job;
2. create the immutable version tag and GitHub Release, or on `resume` verify the existing tag, download the already-published assets, and revalidate their checksum, release version, bundle, architecture, and signature;
3. pass those canonical published assets to the Homebrew job, then render `Casks/caffold.rb` with their verified version and SHA-256;
4. create an unpublished local tap commit when the rendered Cask changed, register that exact commit with Homebrew, trust only the generated Caffold Cask, run Homebrew style and strict Cask audit, install the app and bundled CLI, check that quarantine was removed, and uninstall the smoke-test copy; and
5. push the already-verified tap commit only after the release and Homebrew installation checks pass.

The GitHub Release and Homebrew publication jobs never edit or commit Caffold source. After a GitHub Release exists, its tag and validated assets remain canonical, so a later workflow-fix commit with the same application version can `resume` a failed tap update without replacing the release. Archive verification checks the published version rather than a value derived from the verifying commit, so a later workflow commit revalidates the same assets. When no release exists yet, an existing version tag must still point to the selected release commit before assets can be published.

After the Homebrew job succeeds, `publish_site` pushes the release commit to the `site` branch with `contents: write` and no tap token. Cloudflare Workers Builds deploys `https://caffold.dev` from that branch, as described in the [website README](../../website/README.md#deployment), so the published user manual changes only once the release it describes installs from Homebrew. The push only fast-forwards; a failed push leaves the release and Cask in place, and `resume` repeats it.

`resume` is desired-state reconciliation, not continuation from a stored step number. Completed external state is validated and reused; missing state is created in order. Conflicting tag ownership, invalid or missing canonical assets, or mismatched release metadata stop with an error instead of being overwritten.

## Public release transaction

Public distribution is a separately approved operation. Once started, the following steps stay together because the GitHub asset and Homebrew Cask share one immutable version, URL, and checksum:

1. confirm the reviewed source is pushed and `origin/main` is the current commit;
2. manually run `Release` with the intended `release-patch`, `release-minor`, or `release-major` action, or use `resume` after a partial failure;
3. confirm the workflow produced the version tag, GitHub Release assets, and matching `Casks/caffold.rb` commit in `panarch/homebrew-tap`, and that `https://caffold.dev` shows the manual of the new release;
4. confirm the tap's own `Homebrew audit` workflow passed;
5. install with `brew install --cask panarch/tap/caffold` on the target Mac;
6. launch the installed app and verify `/api/health`, the build ID, agent
   status for the installed CLIs, the bundled Claude runner, the Caffold CLI
   link, and existing Caffold data; and
7. confirm the user-facing Homebrew command still matches the tested installation path and record the release as verified only after the smoke test passes.

Published version tags and assets are not overwritten. If installation reveals a defect, fix it in source and release the next patch version.

## Application update lifecycle

`caffold update --app <bundle> --data-dir <dir> --port <port>` replaces the installed app with the newest version Homebrew offers. The menu-bar app runs it from **Update to Caffold X…** with `--from-menu-bar`. An update Task runs the command the server reports in `GET /api/caffold/update`. Both run the same procedure:

1. The command refuses, recording nothing, when Homebrew is missing, Homebrew has no record of the `caffold` cask, the server on the port is not the one bundled in the app, or another update is running.
2. It records an attempt in `<data-dir>/caffold-updates/attempts/<id>/attempt.json`, copies the app to the attempt's `backup/`, and starts a worker. The worker starts through a shell that exits at once, so it leaves both the caller's process tree and its process group. An agent's command timeout or the menu-bar app quitting does not stop it. The command follows the worker's `log.txt` and ends with a `Result:` line.
3. The worker runs `brew update`, then `brew upgrade --cask panarch/tap/caffold`, while the app keeps running. By default Homebrew fetches its taps by itself at most once a day, while the server learns of a release from GitHub at once, so the worker fetches first. When `brew update` fails, the worker logs it and upgrades from the copy Homebrew has. An update between the GitHub Release and the tap push that follows it ends `upToDate`. When Homebrew's record is ahead of the app, which happens after a rollback, the worker runs `brew reinstall --cask` instead of the upgrade, because `brew upgrade` compares only that record with the tap.
4. When the installed version is newer, the worker asks the app to quit and waits up to 20 seconds for the app, its server, and the port listener to go away. It never kills a process. It then opens the new app with an empty environment, so LaunchServices supplies the user's, and waits up to 30 seconds for `/api/health` to answer with the new version from that bundle's server.
5. When the new app does not start, the worker quits it, moves it to the attempt's `failed/`, puts the backup back, and opens the previous app. When the previous app did not quit in step 4, the worker puts the backup back without restarting anything.

The outcome is one of `upToDate`, `homebrewFailed`, `succeeded`, `rolledBack`, `restoreFailed`, or `interrupted`, with a short `reason` the menu-bar app and browser show as written. Only the worker writes its attempt, except that the next attempt marks one whose worker is gone `interrupted`. The ten newest attempts are kept, and only the newest keeps its app bundles. Backups and failed bundles are removed from LaunchServices.

The menu-bar app learns of a newer release itself, from the latest stable `panarch/caffold` GitHub Release, at launch and when its menu opens six hours after the last check. It refuses to update while connected to an externally managed server and offers the release page for a copy Homebrew did not install. It shows the result of an attempt it started once, in an alert from whichever app is running when the attempt ends. The server asks GitHub separately, when it starts, when a browser asks `GET /api/caffold/update` six hours after the last answer, and at once when About's **Check for Updates** sends `POST /api/caffold/update/check`. The menu-bar app starts its server with `--app-bundle`, and only a server started that way offers an update Task.

Caffold never installs an update without someone starting it.
