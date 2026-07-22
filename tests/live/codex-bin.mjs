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

  const fromPath = findInPath("codex", searchPath);
  if (fromPath) {
    return fromPath;
  }

  for (const candidate of [join(home, ".local/bin/codex"), ...platformPaths]) {
    if (executable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Codex CLI was not found in PATH, ~/.local/bin, /opt/homebrew/bin, or /usr/local/bin.",
  );
}
