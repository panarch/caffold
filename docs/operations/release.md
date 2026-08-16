# Release Process

This document owns Caffold's shared multi-platform release transaction. The
[macOS release process](macos-release.md) and [Linux release process](linux-release.md)
own platform artifact details.

## Version and source ownership

`Cargo.toml` is the application version source. `package.json` and Caffold's
entry in `Cargo.lock` must contain the same version. The manual `Release`
workflow accepts `dry-run`, `release-patch`, `release-minor`, `release-major`,
and `resume`.

A `release-*` action creates and pushes one `Release v<version>` commit changing
only the three version files. Its commit SHA becomes the source for every
platform build and publication job. `dry-run` and `resume` do not change source.

## Required artifacts

One release is complete only when the same tag owns all six canonical assets:

```text
Caffold-Server-<version>-macos-arm64.zip
Caffold-Server-<version>-macos-arm64.zip.sha256
Caffold-<version>-linux-x86_64.tar.gz
Caffold-<version>-linux-x86_64.tar.gz.sha256
Caffold-<version>-linux-aarch64.tar.gz
Caffold-<version>-linux-aarch64.tar.gz.sha256
```

The macOS and both native Linux jobs verify their artifacts before
`publish_release` receives GitHub write permission. The release is not
published when any platform job fails.

## Publication transaction

For `release-*` and `resume`, the workflow:

1. verifies or creates the immutable tag and GitHub Release with all canonical
   assets;
2. verifies the Linux Formula on native x86_64 and aarch64 runners without tap
   publication credentials;
3. renders the macOS Cask and Linux Formula into one unpublished tap commit;
4. audits and installs the Cask on macOS; and
5. pushes the single tap commit only after every platform check succeeds.

The Homebrew tap token is available only to the final `publish_homebrew` job.
The Linux verification jobs can read the public tap and release but cannot
publish either repository.

## Dry run and resume

`dry-run` builds and uploads short-lived workflow artifacts for all three
platform targets. It creates no tag, GitHub Release, version commit, or tap
commit.

`resume` is desired-state reconciliation. An existing tag must resolve to the
release commit. Existing assets are downloaded, checksummed, and structurally
validated before reuse; missing or conflicting canonical state stops instead
of being overwritten. Published assets are never replaced. Correct a defective
release with the next patch version.

## Maintainer procedure

1. Confirm reviewed source is on current `origin/main` and all required checks
   passed.
2. Run `Release` with `dry-run` and inspect all three platform artifacts.
3. Run the intended `release-*` action, or `resume` after a partial failure.
4. Confirm the GitHub tag and six assets.
5. Confirm one tap commit updated both `Casks/caffold.rb` and
   `Formula/caffold.rb`.
6. Confirm the tap audit and platform installation evidence.
7. Smoke the installed package on the intended macOS or Linux host before
   recording the release as verified.

Public release execution, merge, and tap publication remain separately
approved maintainer operations.
