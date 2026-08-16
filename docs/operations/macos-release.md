# macOS Release Process

This document owns the macOS arm64 application artifact and update lifecycle.
The [shared release process](release.md) owns versioning, multi-platform
publication, resume, and the atomic Homebrew tap update.

## Local preparation

Run from a clean arm64 `main` worktree:

```sh
desktop/macos/release --dry-run
```

This local command performs no repository, GitHub, or Homebrew mutation. It:

1. validates the source versions and clean release branch;
2. builds the locked Rust release binary and Swift menu wrapper;
3. assembles and ad-hoc signs `Caffold Server.app`;
4. checks the bundle identifier, application version, commit-count build
   number, build timestamp, and macOS 14 minimum;
5. verifies arm64 code, portable system dependencies, signature, and plist;
6. creates and extracts the versioned zip and repeats bundle verification; and
7. writes and verifies its SHA-256 file.

Generated files are:

```text
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip
target/caffold-server/Caffold-Server-<version>-macos-arm64.zip.sha256
```

## Workflow evidence

The macOS release job runs the frontend units, repository contracts, browser
suite, compiled Swift tests, Rust formatting, tests, and Clippy before invoking
the local release dry run. Its checkout retains no publication credentials and
its verified archive is a short-lived Actions artifact until the shared
publication job succeeds.

On a new or resumed release, macOS archive verification checks the release tag's
commit-count build number, bundle identity, architecture, dependencies, and
signature. The final Homebrew job renders and audits the Cask, installs the app
and CLI, verifies quarantine removal, and uninstalls the smoke copy before the
single Cask-and-Formula tap commit is pushed.

Developer ID signing, Apple notarization, and Intel macOS artifacts are not
supported.

## Application update lifecycle

The menu app uses GitHub Releases only for stable-version discovery and the
release-page fallback. An explicitly approved update runs
`brew upgrade --cask panarch/tap/caffold`; the app does not download or replace
executable content itself.

Before installation, the app requires a Homebrew-managed Cask, refuses to
replace an externally managed server, and warns when canonical managed Tasks
are active. It verifies the replacement bundle version, records a pending
health receipt, relaunches, and clears that receipt only after the replacement
server becomes ready. Network or Homebrew failure leaves the installed app
untouched and retryable. Manually copied bundles open the release page rather
than being overwritten.
