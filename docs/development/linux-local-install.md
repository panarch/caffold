# Linux Local Install Check

This runbook builds a Linux archive from the current checkout and installs it
with the install script in a disposable [Lima](https://lima-vm.io/) virtual
machine on a Mac. It checks what the
[Linux contracts](testing.md#javascript-and-browser-tests) replace with stand-ins: a real
systemd user service, the release build's glibc ceiling on real
distributions, and the agents the service finds on its `PATH`. It does not
publish anything or touch an installed Caffold on the Mac.

On Apple silicon the virtual machines are aarch64. The x86_64 archive needs an
x86_64 Linux host.

## Build an archive

Start a build machine once. Lima's Ubuntu image runs containers with
`nerdctl`, and the Mac's home directory appears read-only at the same path:

```sh
limactl start --name=caffold-dev --cpus=6 --memory=8 --disk=50 template:ubuntu-24.04
```

Copy the checkout to a writable directory in it, leaving out build output:

```sh
limactl shell caffold-dev -- bash -lc '
  rm -rf ~/caffold-src && mkdir ~/caffold-src
  tar -C "<checkout>" --exclude=./target --exclude=./frontend/node_modules \
    --exclude=./.caffold --exclude=./test-results -cf - . | tar -C ~/caffold-src -xf -'
```

Build and verify it in the release's container, with Cargo caches kept in the
build machine between runs:

```sh
limactl shell caffold-dev -- bash -lc '
  mkdir -p ~/manylinux-cache/{cargo,rustup,target}
  nerdctl run --rm -w /src -e CARGO_TARGET_DIR=/target \
    -v ~/caffold-src:/src -v ~/manylinux-cache/target:/target \
    -v ~/manylinux-cache/cargo:/root/.cargo -v ~/manylinux-cache/rustup:/root/.rustup \
    -v /Users:/Users:ro \
    quay.io/pypa/manylinux_2_28_aarch64 bash -c "
      set -e
      dnf install -y -q git clang-devel
      git config --global --add safe.directory \"*\"
      [ -x /root/.cargo/bin/cargo ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.96.0
      . /root/.cargo/env
      curl -fsSL https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-arm64.tar.xz | tar -xJ -C /opt
      export PATH=/opt/node-v26.13.0-linux-arm64/bin:\$PATH
      (cd frontend && npm ci --omit=dev)
      distribution/linux/package archive"'
```

The `/Users` mount lets Git in the container read the checkout's repository,
so the build ID names its commit.

## Make a local release

Copy the archive and its checksum out of the build machine into a release
layout under the checkout's ignored `target/`, and name its version as the
newest release:

```sh
release="<checkout>/target/linux-release"
mkdir -p "$release/v<version>"
for file in Caffold-<version>-linux-aarch64.tar.gz{,.sha256}; do
  limactl copy "caffold-dev:~/caffold-src/target/caffold-linux/$file" "$release/v<version>/"
done
printf '{"tag_name": "v<version>", "draft": false, "prerelease": false}\n' >"$release/latest.json"
```

## Install it

Start a fresh machine for each distribution to check, for example
`template:ubuntu-24.04` or `template:debian-12`. RHEL 8 and its rebuilds, whose
glibc 2.28 is the release's floor, do not boot on Apple silicon's
virtualization; the build's own check already starts `caffold serve` on that
glibc inside the `manylinux_2_28` container.

```sh
limactl start --name=caffold-ubuntu --cpus=2 --memory=3 template:ubuntu-24.04
```

Run the checkout's install script there against the local release. A `file://`
address writes a space as `%20`:

```sh
limactl shell caffold-ubuntu -- bash -lc '
  url="file://<checkout with %20 for spaces>/target/linux-release"
  CAFFOLD_LATEST_RELEASE_URL="$url/latest.json" CAFFOLD_RELEASE_DOWNLOAD_URL="$url" \
    sh "<checkout>/distribution/linux/install.sh"'
```

Then check, in the same machine:

- `systemctl --user is-active caffold` is `active`, and
  `curl http://127.0.0.1:5178/api/health` names the version;
- `systemctl --user show caffold -p KillMode` is `KillMode=process`;
- an agent installed with its own installer, such as Claude Code in
  `~/.local/bin`, appears in its status, for example
  `curl http://127.0.0.1:5178/api/claude/status`;
- running the script again prints that the version is already installed and
  leaves `systemctl --user show caffold -p MainPID` unchanged; and
- the user manual's [uninstall commands](../../website/docs/reference/uninstall.md)
  remove the service and the installation and keep `~/.caffold`.

To see that a restart leaves the server's children running, give the service a
temporary child and restart it; the first child is still alive afterward:

```sh
mkdir -p ~/.config/systemd/user/caffold.service.d
cat >~/.config/systemd/user/caffold.service.d/probe.conf <<'EOF'
[Service]
ExecStartPost=/bin/sh -c 'sleep 600 >/dev/null 2>&1 & echo $! > %h/caffold-probe.pid'
EOF
systemctl --user daemon-reload && systemctl --user restart caffold
probe="$(cat ~/caffold-probe.pid)"; systemctl --user restart caffold
kill -0 "$probe" && echo "the child outlived the restart"
kill "$probe" "$(cat ~/caffold-probe.pid)"
rm -rf ~/.config/systemd/user/caffold.service.d ~/caffold-probe.pid
systemctl --user daemon-reload && systemctl --user restart caffold
```

Delete the machines when done:

```sh
limactl delete -f caffold-ubuntu
```
