# macOS Local Application Development

This runbook replaces `/Applications/Caffold Server.app` with a locally built
bundle for development review. It is distinct from the
[release process](../operations/macos-release.md) and never replaces the
application's Redb data.

Replacement restarts the macOS wrapper and its bundled Caffold backend. It
closes only Caffold's disposable Codex proxy connection; the persistent Codex
app-server daemon and its active turns continue while the new backend
reconnects. The separate Claude runner also remains available for the new
backend to reattach to any sessions it still holds.

## Install a local build

From the repository root:

```sh
desktop/macos/install-local
```

The installer:

1. cleans Caffold's release build metadata and builds the application bundle;
2. validates the backend and Claude runner executables, plist, and code
   signature;
3. stages the bundle next to the installation target;
4. asks the installed application to quit;
5. waits for the wrapper, its bundled `caffold` server, and the configured port
   listener to disappear;
6. backs up the previous application and moves the staged bundle into place;
7. opens the new application and verifies `/api/health`, the expected commit in
   `buildId`, and the exact bundled server that owns the port;
8. unregisters the source bundle and the backup from LaunchServices, so only the
   installed application stays registered;
9. removes all but the ten newest backups, unregistering each first.

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

Restart the bundled server from `Restart Server` in the menu bar. Without the
menu bar, quit the application, wait for the wrapper and its server to exit,
then open it again:

```sh
osascript -e 'tell application id "io.panarch.caffold.server" to quit'
open -a "/Applications/Caffold Server.app"
```

That restarts the wrapper as well. Do not stop the server process directly. The
wrapper is then left without a server it owns, and a replacement started
separately is reported as `External`, which disables `Restart Server` and
application updates until that server stops.

## Install artifacts

| Path | Holds | Kept |
| --- | --- | --- |
| `/Applications/Caffold Server.app` | the installed application | one |
| `~/Library/Application Support/Caffold/install-backups` | applications replaced by successful installs | ten newest |
| `~/Library/Application Support/Caffold/install-failures` | new applications set aside by a rollback | three newest |

Backups and failed bundles are named
`Caffold Server-<date>-<time>-<commit>.app`: the installer's start time and the
`CaffoldBuildCommit` of the bundle inside, which is the commit the About panel
shows. Names sort oldest first, and pruning removes from the front of that
order. Pruning touches only application bundles named this way, so other files
in those directories stay.

In the normal state `/Applications` holds one Caffold bundle, and
`lsregister -dump` lists one registration for `io.panarch.caffold.server`, at
`/Applications/Caffold Server.app`. The installer unregisters only the bundles
it moves or removes. A registration made another way stays until
`lsregister -u <path>` removes it. AppleScript's
`path to application id "io.panarch.caffold.server"` is one such way: it can
register a kept backup.

## Rollback

The installer rolls back on its own. If the new application fails validation
after replacement, the installer first stops the new wrapper and server
completely. Only then does it move the failed bundle into `install-failures`
and unregister it from LaunchServices, restore the backup to the canonical
path, reopen it, and verify health again.

A manual rollback returns to an earlier build after the installed one has been
judged, from any backup still kept. Its reach is the last ten installs, not a
length of time; on a busy day that is a few hours.

### Restore a backup by hand

Quit the application and confirm the runtime is fully stopped before moving
anything. Then retire the installed application into the backups under the
same name form, and put the chosen backup in its place. LaunchServices keeps a
registration through a move, so unregister the retired bundle and register the
restored one:

```sh
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
app="/Applications/Caffold Server.app"
backups="$HOME/Library/Application Support/Caffold/install-backups"
restored="$backups/Caffold Server-<date>-<time>-<commit>.app"

osascript -e 'tell application id "io.panarch.caffold.server" to quit'
desktop/macos/install-local --check-stopped

retired="$backups/Caffold Server-$(date '+%Y%m%d-%H%M%S')-$(plutil -extract CaffoldBuildCommit raw -o - "$app/Contents/Info.plist").app"
mv "$app" "$retired"
"$lsregister" -u "$retired"
mv "$restored" "$app"
"$lsregister" -f "$app"
open "$app"
```

Replace `restored` with the backup to return to. Run the moves only after
`--check-stopped` succeeds.

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

`CAFFOLD_SERVER_APP_TARGET` must be an absolute `.app` path. Failed bundles go
to an `install-failures` directory beside `CAFFOLD_SERVER_BACKUP_DIR`.
