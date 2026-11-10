# Caffold for Linux

On Linux, Caffold ships as an archive of the Rust server and its runner, and an
install script that installs it for one user and runs it as a systemd user
service. The browser/PWA is the whole interface; there is no desktop wrapper.

## Install

The supported user installation, update, and removal workflow is owned by the
user manual, starting at
[Install on Linux](../../website/docs/get-started/install.md#install-on-linux):

```sh
curl -fsSL https://caffold.dev/install.sh | sh
```

`install.sh` here is that script. The website serves this file through the
`website/docs/install.sh` link, and a release candidate's notes run it from the
candidate's tag with `--version`. `CAFFOLD_LATEST_RELEASE_URL` and
`CAFFOLD_RELEASE_DOWNLOAD_URL` point it at another release source, which its
tests and local checks use.

The script needs x86_64 or aarch64 Linux with glibc 2.28 or later, a systemd
user manager, `curl`, and `tar`. It stops, changing nothing, when any of these
is missing or when the downloaded `caffold` cannot start on the host. On
NixOS, `programs.nix-ld` provides the standard dynamic loader the binaries need.

## Build

```sh
distribution/linux/package archive
```

builds and verifies `target/caffold-linux/Caffold-<version>-linux-<arch>.tar.gz`
on a Linux host with the pinned Rust toolchain, Node.js and `npm ci` in
`frontend/`, CMake, and a C and C++ compiler. The release builds it inside the
`manylinux_2_28` container so the binaries run on glibc 2.28;
[Release Process](../../docs/operations/release.md#linux-archives) owns the
checks and the release workflow, and
[Linux Local Install Check](../../docs/development/linux-local-install.md)
builds and installs one in a virtual machine from a Mac.

## Installed layout

| Path | Holds |
| --- | --- |
| `~/.local/share/caffold/versions/<version>/` | `caffold` and `caffold-runner` of one version; the one in use and the one before it are kept |
| `~/.local/bin/caffold` | a link to the version in use |
| `~/.config/systemd/user/caffold.service` | the service unit |
| `~/.caffold` | Caffold's data directory, the server's default |

The unit runs `%h/.local/bin/caffold serve --port 5178 --install-root %h/.local/share/caffold`
on `127.0.0.1`, restarts it after a failure, and starts it with the user's
manager. `KillMode=process` limits a stop or restart to the server process; see
[Linux service](../../docs/architecture/overview.md#linux-service). Its `PATH`
holds `~/.local/bin`, the system directories, and NixOS's profile directories,
so the server finds `claude`, `codex`, `grok`, `agy`, `git`, `gh`, and
`tailscale` where their installers put them.

The script also enables lingering for the user, so the service keeps running
after the last session ends, and turns on Tailscale Serve through the server's
local API when `tailscale` is installed. Tailscale must allow the user to change
Serve, which `sudo tailscale set --operator=$USER` does.

Logs go to the systemd journal: `journalctl --user -u caffold`.

## Updates

Running the script again installs the newest release beside the current one,
points the link at it, restarts the service, and points the link back if the
new version does not answer. From the browser, **Settings → About Caffold →
Update Caffold** runs `caffold update --install-root`, which does the same; see
the [Linux update lifecycle](../../docs/operations/release.md#on-linux).

When the newest release already runs and the unit is unchanged, the script
leaves the server running and only turns on what is missing, such as lingering
or Tailscale Serve.
