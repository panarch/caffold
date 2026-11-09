#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMPS = new Set(["major", "minor", "patch"]);

export function nextReleaseVersion(version, bump) {
  const match = version.match(STABLE_VERSION);
  if (!match) {
    throw new Error(`release version ${version} must be a stable major.minor.patch version`);
  }
  if (!BUMPS.has(bump)) {
    throw new Error(`release bump must be major, minor, or patch; received ${bump}`);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

export function nextReleaseCandidateVersion(version, bump, tags) {
  const target = nextReleaseVersion(version, bump);
  const prefix = `v${target}-rc.`;
  let latest = 0;
  for (const tag of tags) {
    const number = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    if (/^[1-9]\d*$/.test(number)) {
      latest = Math.max(latest, Number(number));
    }
  }
  return `${target}-rc.${latest + 1}`;
}

function packageVersion(source, header, packageName = null) {
  const lines = source.split("\n");
  const candidates = [];

  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== header) {
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !lines[end].trim().startsWith("[")) {
      end += 1;
    }
    if (
      packageName !== null &&
      !lines.slice(start + 1, end).some((line) => line === `name = "${packageName}"`)
    ) {
      continue;
    }
    const versionLines = [];
    for (let index = start + 1; index < end; index += 1) {
      if (/^version = "[^"]+"$/.test(lines[index])) {
        versionLines.push(index);
      }
    }
    if (versionLines.length !== 1) {
      throw new Error(`${header} ${packageName ?? "package"} must contain one version`);
    }
    candidates.push(versionLines[0]);
  }

  if (candidates.length !== 1) {
    throw new Error(`${header} ${packageName ?? "package"} must appear exactly once`);
  }
  const index = candidates[0];
  const version = lines[index].match(/^version = "([^"]+)"$/)?.[1];
  return {
    version,
    replace(nextVersion) {
      lines[index] = `version = "${nextVersion}"`;
      return lines.join("\n");
    },
  };
}

export function bumpReleaseVersion(root, bump, { releaseCandidateTags } = {}) {
  const cargoPath = resolve(root, "caffold", "Cargo.toml");
  const webPath = resolve(root, "frontend", "package.json");
  const lockPath = resolve(root, "Cargo.lock");
  const cargoSource = readFileSync(cargoPath, "utf8");
  const webSource = readFileSync(webPath, "utf8");
  const lockSource = readFileSync(lockPath, "utf8");
  const cargo = packageVersion(cargoSource, "[package]");
  const lock = packageVersion(lockSource, "[[package]]", "caffold");
  const web = JSON.parse(webSource);

  if (cargo.version !== web.version || cargo.version !== lock.version) {
    throw new Error(
      `caffold/Cargo.toml (${cargo.version}), frontend/package.json (${web.version}), and Cargo.lock (${lock.version}) versions must match`,
    );
  }

  const version = releaseCandidateTags
    ? nextReleaseCandidateVersion(cargo.version, bump, releaseCandidateTags)
    : nextReleaseVersion(cargo.version, bump);
  const nextCargo = cargo.replace(version);
  const nextLock = lock.replace(version);
  const nextWeb = `${JSON.stringify({ ...web, version }, null, 2)}\n`;

  writeFileSync(cargoPath, nextCargo);
  writeFileSync(webPath, nextWeb);
  writeFileSync(lockPath, nextLock);
  return { previousVersion: cargo.version, version };
}

function usage() {
  return "usage: node scripts/bump-release-version.mjs {major|minor|patch} [--rc]";
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [bump, ...options] = process.argv.slice(2);
  const releaseCandidate = options.length === 1 && options[0] === "--rc";
  if (!BUMPS.has(bump) || (options.length > 0 && !releaseCandidate)) {
    console.error(usage());
    process.exit(2);
  }
  try {
    const releaseCandidateTags = releaseCandidate
      ? execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
      : undefined;
    const result = bumpReleaseVersion(process.cwd(), bump, { releaseCandidateTags });
    console.log(`previous_version=${result.previousVersion}`);
    console.log(`version=${result.version}`);
  } catch (error) {
    console.error(`release version bump failed: ${error.message}`);
    process.exit(1);
  }
}
