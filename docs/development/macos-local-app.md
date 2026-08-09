# macOS Local Application Development

This runbook replaces `/Applications/Caffold Server.app` with a locally built
bundle for development review. It is distinct from the
[release process](../operations/macos-release.md) and never replaces the
application's Redb data.

Replacement restarts the macOS wrapper and its bundled Caffold backend. It
closes only Caffold's disposable Codex proxy connection; the persistent Codex
app-server daemon and its active turns continue while the new backend
reconnects.

## Install a local build

From the repository root:

```sh
desktop/macos/install-local
```

The installer:

1. cleans Caffold's release build metadata and builds the application bundle;
2. validates the executable, plist, and code signature;
3. stages the bundle next to the installation target;
4. asks the installed application to quit;
5. waits for the wrapper, its bundled `caffold` server, and the configured port
   listener to disappear;
6. backs up the previous application and moves the staged bundle into place;
7. opens the new application and verifies `/api/health`, the expected commit in
   `buildId`, and the exact bundled server that owns the port.

Run the read-only shutdown preflight independently with:

```sh
desktop/macos/install-local --check-stopped
```

The preflight deliberately fails when the wrapper is gone but its bundled
server still exists, or when another process owns the configured port. Do not
work around that result by killing a process selected only by name or port.

## Process shutdown contract

The macOS wrapper owns only the `Process` instance it starts. On quit or restart
it sends `SIGTERM`, waits up to five seconds, then sends `SIGKILL` only to that
exact still-running PID and waits another two seconds. It never discovers a
force-kill target by executable name, port, or database file.

The installer does not force-kill the installed runtime because it cannot prove
that runtime's in-memory ownership. If the wrapper, bundled server, or listener
remains after the deadline, replacement stops before moving the installed app.
Inspect the reported PIDs, commands, listener, and Redb file descriptors before
manual recovery.

## Rollback

If the new application fails validation after replacement, the installer first
stops the new wrapper and server completely. Only then does it move the failed
bundle aside, restore the backup to the canonical path, reopen it, and verify
health again.

Failed bundles are preserved as:

```text
/Applications/.Caffold Server.failed.<pid>.app
```

They exist for failure inspection and are not removed automatically. Once the
failure is understood and a healthy app is confirmed, remove a specific failed
bundle manually. Backups are kept under:

```text
~/Library/Application Support/Caffold/install-backups
```

## Data and path isolation

The installed app uses:

```text
~/Library/Application Support/Caffold/data
```

The installer replaces only the `.app` bundle. It does not copy, migrate, or
delete Redb data. Development servers and automated tests must use their own
port and temporary or `.caffold-dev` data directory.

The following overrides are available when validating a copy rather than the
canonical installation:

```sh
CAFFOLD_SERVER_APP_TARGET=/absolute/path/Caffold\ Server.app \
CAFFOLD_SERVER_BACKUP_DIR=/absolute/path/backups \
CAFFOLD_SERVER_PORT=18765 \
desktop/macos/install-local
```

`CAFFOLD_SERVER_APP_TARGET` must be an absolute `.app` path.
