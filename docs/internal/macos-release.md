# macOS Release Process

This document separates reversible local release preparation from public distribution. Caffold currently ships only an arm64 macOS menu bar app. Developer ID signing, Apple notarization, Intel builds, Linux packaging, and in-app updating are outside the first release boundary.

## Version ownership

`Cargo.toml` is the application version source and `package.json` must contain the same value. A version change is an ordinary reviewed source commit; release tooling does not edit or commit version files.

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

`.github/workflows/release.yml` exposes preparation and publication through one manual `Release` workflow. Its `operation` input defaults to `dry-run`; the committed `Cargo.toml` version is read automatically rather than accepted as workflow input.

The verification job:

1. can only continue when dispatched from `main`;
2. checks out the selected commit with complete history so the bundle build number remains meaningful;
3. retains no checkout credentials and has only `contents: read` permission;
4. verifies source version agreement, release contracts, Rust formatting, tests, and Clippy;
5. runs the local release dry run on a GitHub-hosted macOS arm64 runner; and
6. uploads only the versioned zip and SHA-256 file as a seven-day workflow artifact.

With `operation: dry-run`, no other job runs. The artifact is for inspecting the runner-built output and is not a stable distribution URL.

With `operation: publish`, two narrower jobs run after verification. `publish_release` receives `contents: write` only for `panarch/caffold`; it creates the GitHub Release without receiving the tap token. After that succeeds, `publish_homebrew` uses the `release` environment, keeps only `contents: read` for Caffold, and receives the `HOMEBREW_TAP_TOKEN` environment secret, whose fine-grained access is limited to `panarch/homebrew-tap`. Together they:

1. download and recheck the exact artifact produced by the verification job;
2. create the immutable version tag and GitHub Release, or on a retry verify the existing tag and commit, download the already-published assets, and revalidate their checksum, bundle, architecture, and signature;
3. pass those canonical published assets to the Homebrew job, then render `Casks/caffold.rb` with their verified version and SHA-256;
4. register the checked-out tap locally, run Homebrew style and strict Cask audit, install the app and bundled CLI, check that quarantine was removed, and uninstall the smoke-test copy; and
5. commit and push the Cask to the tap only after the release and Homebrew installation checks pass.

The publish jobs never edit or commit Caffold source. A failed tap update can be retried from the same workflow commit: the already-published assets, rather than a newly timestamped rebuild, become the canonical input to the Homebrew job.

## Public release transaction

Public distribution is a separately approved operation. Once started, the following steps stay together because the GitHub asset and Homebrew Cask share one immutable version, URL, and checksum:

1. confirm the reviewed version commit is pushed and `origin/main` is the current commit;
2. manually run `Release` with `operation: publish`;
3. confirm the workflow produced the version tag, GitHub Release assets, and matching `Casks/caffold.rb` commit in `panarch/homebrew-tap`;
4. confirm the tap's own `Homebrew audit` workflow passed;
5. install with `brew install --cask panarch/tap/caffold` on the target Mac;
6. launch the installed app and verify `/api/health`, the build ID, Codex connectivity, CLI link, and existing Caffold data; and
7. confirm the user-facing Homebrew command still matches the tested installation path and record the release as verified only after the smoke test passes.

Published version tags and assets are not overwritten. If installation reveals a defect, fix it in source and release the next patch version.

## Deferred update lifecycle

The first release supports Homebrew installation and manual `brew upgrade`. App-driven release detection, coordinated shutdown, upgrade, relaunch, and post-upgrade health validation require an installed older release and are developed after `v0.1.0`. The first real end-to-end updater check therefore uses a later version such as `v0.1.1`.
