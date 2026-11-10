#!/bin/sh
# Installs Caffold for this Linux user, or updates it to the newest release:
#
#   curl -fsSL https://caffold.dev/install.sh | sh
#   curl -fsSL https://caffold.dev/install.sh | sh -s -- --version 0.24.0-rc.1
#
# Each version is unpacked into ~/.local/share/caffold/versions/<version>,
# ~/.local/bin/caffold points at the one in use, and a systemd user service
# runs it on port 5178. Only that version and the one before it are kept.
set -eu

REPOSITORY="panarch/caffold"
LATEST_RELEASE_URL="${CAFFOLD_LATEST_RELEASE_URL:-https://api.github.com/repos/${REPOSITORY}/releases/latest}"
DOWNLOAD_URL="${CAFFOLD_RELEASE_DOWNLOAD_URL:-https://github.com/${REPOSITORY}/releases/download}"
PORT=5178
GLIBC_MINIMUM="2.28"
INSTALL_ROOT="${HOME}/.local/share/caffold"
VERSIONS="${INSTALL_ROOT}/versions"
LINK="${HOME}/.local/bin/caffold"
SERVICE="caffold.service"
UNIT="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user/${SERVICE}"

main() {
  version=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || fail "--version needs a version, such as 0.24.0."
        version="$2"
        shift 2
        ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage >&2
        fail "Unknown option: $1"
        ;;
    esac
  done

  require_commands curl tar sed sort systemctl
  arch="$(architecture)"
  require_glibc
  require_systemd
  [ -n "${version}" ] || version="$(latest_version)"
  valid_version "${version}" || fail "${version} is not a Caffold version, such as 0.24.0."

  previous="$(linked_version)"
  directory="${VERSIONS}/${version}"
  if [ "${previous}" = "${version}" ]; then
    say "Caffold ${version} is already installed."
  else
    say "Installing Caffold ${version} for ${arch}."
    install_version "${version}" "${arch}" "${directory}"
    require_runs "${directory}/caffold"
    point_link "${directory}/caffold"
  fi

  unit_changed="$(write_unit)"
  systemctl --user daemon-reload
  systemctl --user enable --quiet "${SERVICE}"
  # Running the script again for the version that already runs, with the same
  # unit, leaves the server and its terminals alone.
  if [ "${previous}" != "${version}" ] || [ "${unit_changed}" = yes ] || ! systemctl --user is-active --quiet "${SERVICE}"; then
    systemctl --user restart "${SERVICE}"
  fi
  if ! serves "${version}"; then
    if [ -n "${previous}" ] && [ "${previous}" != "${version}" ]; then
      point_link "${VERSIONS}/${previous}/caffold"
      systemctl --user restart "${SERVICE}"
      fail "Caffold ${version} did not start, so Caffold ${previous} runs again. See: journalctl --user -u caffold"
    fi
    fail "Caffold ${version} did not start. See: journalctl --user -u caffold"
  fi
  keep_versions "${version}" "${previous}"

  say "Caffold ${version} is running at http://127.0.0.1:${PORT}."
  keep_running_after_logout
  serve_on_tailnet
  # Login profiles such as Ubuntu's add ~/.local/bin to the PATH only if it
  # exists at login, so a shell started before it existed lacks it.
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) say "Log in again to run the caffold command. If it is still not found, add ~/.local/bin to your PATH." ;;
  esac
}

usage() {
  cat <<'EOF'
usage: install.sh [--version <version>]

Installs the newest Caffold release, or <version>, for this user and runs it
as the systemd user service caffold.service on http://127.0.0.1:5178.
Running it again installs the newest release over the current one.
EOF
}

architecture() {
  [ "$(uname -s)" = "Linux" ] || fail "This script installs Caffold on Linux. On a Mac, install it with Homebrew: brew install --cask panarch/tap/caffold"
  case "$(uname -m)" in
    x86_64 | amd64) echo x86_64 ;;
    aarch64 | arm64) echo aarch64 ;;
    *) fail "Caffold runs on x86_64 and aarch64 Linux; this machine is $(uname -m)." ;;
  esac
}

require_glibc() {
  glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p')"
  [ -n "${glibc}" ] || fail "Caffold needs glibc ${GLIBC_MINIMUM} or later, and this system has no glibc."
  at_least "${glibc}" "${GLIBC_MINIMUM}" || fail "Caffold needs glibc ${GLIBC_MINIMUM} or later; this system has ${glibc}."
}

require_systemd() {
  systemctl --user show-environment >/dev/null 2>&1 || fail "Caffold runs as a systemd user service, and this session has no systemd user manager."
}

latest_version() {
  release="$(curl -fsSL -H "Accept: application/vnd.github+json" "${LATEST_RELEASE_URL}")" || fail "Could not ask GitHub for the newest Caffold release."
  tag="$(printf '%s\n' "${release}" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "${tag}" ] || fail "GitHub did not name the newest Caffold release."
  echo "${tag}"
}

# Downloads the release archive and its checksum, checks one against the
# other, and unpacks the archive into a staging directory before it takes the
# version's place.
install_version() {
  archive="Caffold-$1-linux-$2.tar.gz"
  staging="${VERSIONS}/.partial-$1"
  rm -rf "${staging}"
  mkdir -p "${staging}/unpacked"
  curl -fsSL -o "${staging}/${archive}" "${DOWNLOAD_URL}/v$1/${archive}" || fail "Could not download ${archive}."
  curl -fsSL -o "${staging}/${archive}.sha256" "${DOWNLOAD_URL}/v$1/${archive}.sha256" || fail "Could not download ${archive}.sha256."
  expected="$(sed -n '1s/^\([0-9a-fA-F]\{64\}\).*/\1/p' "${staging}/${archive}.sha256")"
  actual="$(checksum "${staging}/${archive}")"
  if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then
    rm -rf "${staging}"
    fail "The checksum of ${archive} does not match."
  fi
  tar -xzf "${staging}/${archive}" -C "${staging}/unpacked"
  for file in caffold caffold-runner; do
    [ -x "${staging}/unpacked/${file}" ] || {
      rm -rf "${staging}"
      fail "${archive} holds no ${file}."
    }
  done
  rm -rf "$3"
  mv "${staging}/unpacked" "$3"
  rm -rf "${staging}"
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | sed 's/ .*//'
  else
    shasum -a 256 "$1" | sed 's/ .*//'
  fi
}

# A binary that cannot start here stops the install before anything changes.
require_runs() {
  "$1" --help >/dev/null 2>&1 && return 0
  rm -rf "$(dirname "$1")"
  if [ -e /etc/NIXOS ]; then
    fail "Caffold cannot start on this NixOS system. Enable programs.nix-ld in your NixOS configuration, then run this script again."
  fi
  fail "Caffold cannot start on this system. It needs glibc ${GLIBC_MINIMUM} or later and the standard dynamic loader."
}

# Points the link at `$1` in one step, so it always names a version.
point_link() {
  mkdir -p "$(dirname "${LINK}")"
  ln -sfn "$1" "${LINK}.new"
  mv -f "${LINK}.new" "${LINK}"
}

# The version the link names, when it names one of the installed versions.
linked_version() {
  [ -L "${LINK}" ] || return 0
  target="$(readlink "${LINK}")"
  case "${target}" in
    "${VERSIONS}"/*/caffold)
      linked="${target#"${VERSIONS}"/}"
      echo "${linked%/caffold}"
      ;;
  esac
}

# Writes the unit, and prints yes when that changed it.
write_unit() {
  mkdir -p "$(dirname "${UNIT}")"
  cat >"${UNIT}.new" <<'EOF'
[Unit]
Description=Caffold
Documentation=https://caffold.dev

[Service]
ExecStart=%h/.local/bin/caffold serve --port 5178 --install-root %h/.local/share/caffold
# Stopping the service stops the server alone. The Claude runner, the Codex
# app-server daemon, the Grok leader, and an update in progress keep running
# across a restart, as they do when the Mac app restarts its server.
KillMode=process
Restart=on-failure
RestartSec=2
Environment=PATH=%h/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/run/current-system/sw/bin:/etc/profiles/per-user/%u/bin:%h/.nix-profile/bin

[Install]
WantedBy=default.target
EOF
  if cmp -s "${UNIT}.new" "${UNIT}"; then
    rm -f "${UNIT}.new"
    echo no
  else
    mv -f "${UNIT}.new" "${UNIT}"
    echo yes
  fi
}

# The server on the port answers with `$1`.
serves() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q "\"version\":\"$1\""; then
      return 0
    fi
    sleep 1
  done
  return 1
}

keep_versions() {
  for installed in "${VERSIONS}"/* "${VERSIONS}"/.partial-*; do
    [ -e "${installed}" ] || continue
    name="$(basename "${installed}")"
    [ "${name}" = "$1" ] || [ "${name}" = "$2" ] || rm -rf "${installed}"
  done
}

# Without lingering, systemd stops user services when the user's last
# session ends, such as the SSH session this script runs in.
keep_running_after_logout() {
  [ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" = "yes" ] && return 0
  if loginctl --no-ask-password enable-linger "$(id -un)" >/dev/null 2>&1; then
    say "Caffold keeps running after you log out."
  else
    say "To keep Caffold running after you log out, run: sudo loginctl enable-linger $(id -un)"
  fi
}

serve_on_tailnet() {
  if ! command -v tailscale >/dev/null 2>&1; then
    say "To open Caffold from your other devices, install Tailscale and run this script again."
    return 0
  fi
  status="$(curl -fsS -X PUT -H "Content-Type: application/json" --data '{"enabled":true}' "http://127.0.0.1:${PORT}/api/tailscale/serve" 2>/dev/null)" || status=""
  url="$(printf '%s\n' "${status}" | sed -n 's/.*"tailnetUrl":"\([^"]*\)".*/\1/p')"
  if [ -n "${url}" ] && printf '%s\n' "${status}" | grep -q '"state":"ready"'; then
    say "Open Caffold from your other devices at ${url}."
    return 0
  fi
  message="$(printf '%s\n' "${status}" | sed -n 's/.*"diagnosticMessage":"\([^"]*\)".*/\1/p')"
  say "Tailscale Serve is not on${message:+: ${message}}"
  say "If Tailscale denied access, run sudo tailscale set --operator=$(id -un), then run this script again."
}

require_commands() {
  for command in "$@"; do
    command -v "${command}" >/dev/null 2>&1 || fail "Caffold's install needs ${command}."
  done
}

valid_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

# Whether version `$1` is `$2` or newer.
at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'caffold install: %s\n' "$*" >&2
  exit 1
}

main "$@"
