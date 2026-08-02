# macOS Release Process

This document separates reversible local release preparation from public distribution. Caffold currently ships only an arm64 macOS menu bar app. Developer ID signing, Apple notarization, Intel builds, Linux packaging, and in-app updating are outside the first release boundary.

## Version ownership

`Cargo.toml` is the application version source; `package.json` and the Caffold package entry in `Cargo.lock` must contain the same value. `scripts/bump-release-version.mjs` validates all three values before changing them and supports stable `major`, `minor`, and `patch` increments.

The manual Release workflow creates and pushes a `Release v<version>` commit when a `release-patch`, `release-minor`, or `release-major` action is selected. The bump job may change only `Cargo.toml`, `package.json`, and `Cargo.lock`. Its resulting commit SHA, rather than the workflow dispatch SHA, becomes the source for every build and publication job.

The app bundle uses:

- `CFBundleShortVersionString`: the application version
- `CFBundleVersion`: the repository commit count
- `CaffoldBuildTimestamp`: the local package date and time
- the Rust build ID: the source commit plus its build timestamp

## Local preparation

Run from a clean `main` worktree:

```sh
desktop/macos/release --dry-run --version 0.1.0
```

The command performs no publication or repository mutation. Cargo may download locked dependencies when they are not already cached. The command:

1. rejects a dirty worktree, a non-`main` branch, a version mismatch, or a non-arm64 host;
2. builds the Rust binary with `cargo build --release --locked`;
3. builds and ad-hoc signs `Caffold Server.app`;
4. checks the bundle identifier, version, build number, build timestamp, and macOS 14 minimum;
5. checks that the Swift wrapper and Rust server both contain arm64 code;
6. verifies the bundle signature;
7. creates a versioned zip, extracts it into a temporary directory, and repeats the bundle checks on that copy;
8. writes and verifies a SHA-256 checksum beside the archive; and
9. confirms packaging did not change the source worktree.

The output under `target/caffold-server` is ignored build output. A successful dry run is evidence that the current source can produce the release artifact; it does not publish anything.

## GitHub workflow

`.github/workflows/release.yml` exposes preparation, versioning, publication, and recovery through one manual `Release` workflow. Its required `action` input has five unambiguous choices:

- `dry-run` verifies and packages the currently committed version without repository or public mutation.
- `release-patch`, `release-minor`, and `release-major` increment the current version, push the version commit, then publish that exact commit.
- `resume` does not change the version. It reconciles the currently committed version with its tag, GitHub Release, and Homebrew Cask after a partial failure.

For a new release action, the version job runs with `contents: write`; checks that the workflow still targets the current `main`; rejects an already-used target tag or Release; changes only the three canonical version files; and pushes the version commit. `dry-run` and `resume` skip this job and retain read-only source handling.

The verification job:

1. can only continue when dispatched from `main`;
2. checks out the selected commit with complete history so the bundle build number remains meaningful;
3. retains no checkout credentials and has only `contents: read` permission;
4. verifies source version agreement, release contracts, Rust formatting, tests, and Clippy;
5. runs the local release dry run on a GitHub-hosted macOS arm64 runner; and
6. uploads only the versioned zip and SHA-256 file as a seven-day workflow artifact.

With `action: dry-run`, no publication job runs. The artifact is for inspecting the runner-built output and is not a stable distribution URL.

With any `release-*` action or `resume`, two narrower jobs run after verification. `publish_release` receives `contents: write` only for `panarch/caffold`; it creates or reconciles the GitHub Release without receiving the tap token. After that succeeds, `publish_homebrew` uses the `release` environment, keeps only `contents: read` for Caffold, and receives the `HOMEBREW_TAP_TOKEN` environment secret, whose fine-grained access is limited to `panarch/homebrew-tap`. Together they:

1. download and recheck the exact artifact produced by the verification job;
2. create the immutable version tag and GitHub Release, or on `resume` verify the existing tag, download the already-published assets, and revalidate their checksum, release-tag version and build number, bundle, architecture, and signature;
3. pass those canonical published assets to the Homebrew job, then render `Casks/caffold.rb` with their verified version and SHA-256;
4. register the checked-out tap locally, trust only the generated Caffold Cask, run Homebrew style and strict Cask audit, install the app and bundled CLI, check that quarantine was removed, and uninstall the smoke-test copy; and
5. commit and push the Cask to the tap only after the release and Homebrew installation checks pass.

The publish jobs never edit or commit Caffold source. After a GitHub Release exists, its tag and validated assets remain canonical, so a later workflow-fix commit with the same application version can `resume` a failed tap update without replacing the release. Archive verification derives `CFBundleVersion` from the release tag's commit count rather than the later workflow commit. When no release exists yet, an existing version tag must still point to the selected release commit before assets can be published.

`resume` is desired-state reconciliation, not continuation from a stored step number. Completed external state is validated and reused; missing state is created in order. Conflicting tag ownership, invalid or missing canonical assets, or mismatched release metadata stop with an error instead of being overwritten.

## Public release transaction

Public distribution is a separately approved operation. Once started, the following steps stay together because the GitHub asset and Homebrew Cask share one immutable version, URL, and checksum:

1. confirm the reviewed source is pushed and `origin/main` is the current commit;
2. manually run `Release` with the intended `release-patch`, `release-minor`, or `release-major` action, or use `resume` after a partial failure;
3. confirm the workflow produced the version tag, GitHub Release assets, and matching `Casks/caffold.rb` commit in `panarch/homebrew-tap`;
4. confirm the tap's own `Homebrew audit` workflow passed;
5. install with `brew install --cask panarch/tap/caffold` on the target Mac;
6. launch the installed app and verify `/api/health`, the build ID, Codex connectivity, CLI link, and existing Caffold data; and
7. confirm the user-facing Homebrew command still matches the tested installation path and record the release as verified only after the smoke test passes.

Published version tags and assets are not overwritten. If installation reveals a defect, fix it in source and release the next patch version.

## Deferred update lifecycle

The first release supports Homebrew installation and manual `brew upgrade`. App-driven release detection, coordinated shutdown, upgrade, relaunch, and post-upgrade health validation require an installed older release and are developed after `v0.1.0`. The first real end-to-end updater check therefore uses a later version such as `v0.1.1`.
