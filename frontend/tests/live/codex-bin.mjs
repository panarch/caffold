import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(command, searchPath) {
  if (isAbsolute(command) || command.includes(sep)) {
    return executable(command) ? command : null;
  }

  for (const directory of (searchPath ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    if (executable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveCodexBin({
  explicit = process.env.CAFFOLD_CODEX_BIN,
  searchPath = process.env.PATH,
  home = homedir(),
  platformPaths = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"],
} = {}) {
  if (explicit) {
    const resolved = findInPath(explicit, searchPath);
    if (!resolved) {
      throw new Error(`CAFFOLD_CODEX_BIN is not executable: ${explicit}`);
    }
    return resolved;
  }

  const officialStandalone = join(home, ".local/bin/codex");
  if (executable(officialStandalone)) {
    return officialStandalone;
  }

  const diagnosticCandidates = [
    findInPath("codex", searchPath),
    ...platformPaths,
  ].filter(Boolean);
  for (const candidate of diagnosticCandidates) {
    if (executable(candidate)) {
      throw new Error(
        `Unsupported Codex installation found at ${candidate}; install the official standalone CLI at ~/.local/bin/codex.`,
      );
    }
  }

  throw new Error(
    "The official standalone Codex CLI was not found at ~/.local/bin/codex.",
  );
}
