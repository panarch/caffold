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

## GitHub dry run

`.github/workflows/release.yml` exposes the same preparation through the manual `Release` workflow. It currently has one `macos` job and no publish mode. The workflow:

1. can only continue when dispatched from `main`;
2. checks out the selected commit with complete history so the bundle build number remains meaningful;
3. retains no checkout credentials and has only `contents: read` permission;
4. verifies the requested version, release contract, Rust formatting, tests, and Clippy;
5. runs the local release dry run on a GitHub-hosted macOS arm64 runner; and
6. uploads only the versioned zip and SHA-256 file as a seven-day workflow artifact.

The workflow contains no source commit, tag, GitHub Release, Homebrew, or cross-repository mutation. The artifact is for inspecting the runner-built output and is not a stable distribution URL.

## Public release transaction

Public distribution is a separately approved operation. Once started, the following steps stay together because the GitHub asset and Homebrew Cask share one immutable version, URL, and checksum:

1. confirm the reviewed version commit is pushed and `origin/main` is the current commit;
2. run the complete Rust, browser, protocol, and macOS release checks;
3. retain the final verified archive and checksum from that exact commit;
4. create the version tag and GitHub Release, then upload the archive;
5. add or update `Casks/caffold.rb` in `panarch/homebrew-tap` with the exact version, URL, and SHA-256;
6. audit the tap and install the Cask through Homebrew;
7. launch the installed app and verify `/api/health`, the build ID, Codex connectivity, and existing Caffold data; and
8. publish the user-facing Homebrew instructions only after the installation smoke test passes.

Published version tags and assets are not overwritten. If installation reveals a defect, fix it in source and release the next patch version.

## Deferred update lifecycle

The first release supports Homebrew installation and manual `brew upgrade`. App-driven release detection, coordinated shutdown, upgrade, relaunch, and post-upgrade health validation require an installed older release and are developed after `v0.1.0`. The first real end-to-end updater check therefore uses a later version such as `v0.1.1`.
