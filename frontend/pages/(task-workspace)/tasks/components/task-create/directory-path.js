import { cleanLogicalPath } from "../../task-format.js";

// How a working directory reads, and how a typed one is understood.
//
// The server names a directory by its path below its root. When that root is
// the filesystem root the path is absolute, and below the home directory it
// reads as `~`. A server started on another root keeps paths relative to it,
// so that relative path is what you read and type there.

export function directoryPathDisplay(path, server = {}) {
  const logical = cleanLogicalPath(path);
  if (!absolutePaths(server)) {
    return logical || ".";
  }
  const home = homeDirectory(server);
  if (home !== null && isWithin(logical, home)) {
    const below = logical.slice(home.length);
    return below ? `~${below}` : "~";
  }
  return `/${logical}`;
}

// The text an edit starts from: the shown path ending in `/`, so the list
// shows what is inside it.
export function directoryPathEditingText(path, server = {}) {
  if (!absolutePaths(server)) {
    const logical = cleanLogicalPath(path);
    return logical ? `${logical}/` : "";
  }
  const shown = directoryPathDisplay(path, server);
  return shown.endsWith("/") ? shown : `${shown}/`;
}

// What typed text asks for: the folder to list, and the start of a name in it.
// Text ending in `/` lists that folder with no name typed yet.
export function readTypedDirectoryPath(text, server = {}) {
  const typed = `${text ?? ""}`.trim();
  const start = typedStart(typed, server);
  if (start.error) {
    return { error: start.error };
  }
  const parts = start.rest.split("/");
  const name = parts.pop();
  const folders = parts.filter((part) => part && part !== ".");
  if (name === ".." || folders.includes("..")) {
    return { error: "A path cannot contain “..”." };
  }
  return {
    folder: [start.base, ...folders].filter(Boolean).join("/"),
    name,
  };
}

// The text after Tab completes a name: what was typed up to its last `/`, the
// name, and a `/` to list inside it.
export function completeTypedDirectoryPath(text, name) {
  const typed = `${text ?? ""}`.trim();
  const cut = typed.lastIndexOf("/");
  const base = cut >= 0
    ? typed.slice(0, cut + 1)
    : typed === "~"
      ? "~/"
      : "";
  return `${base}${name}/`;
}

export function matchesTypedName(entryName, name) {
  return !name ||
    `${entryName ?? ""}`.toLocaleLowerCase().startsWith(name.toLocaleLowerCase());
}

function typedStart(typed, server) {
  if (!absolutePaths(server)) {
    return typed.startsWith("/") || typed.startsWith("~")
      ? { error: "Type the path inside the server root, without / or ~ in front." }
      : { base: "", rest: typed };
  }
  const home = homeDirectory(server);
  if (typed === "~" || typed.startsWith("~/")) {
    return home === null
      ? { error: "This server has no home directory. Start the path with /." }
      : { base: home, rest: typed.slice(2) };
  }
  if (typed.startsWith("/")) {
    return { base: "", rest: typed.slice(1) };
  }
  return {
    error: home === null
      ? "Start the path with /."
      : "Start the path with / or ~.",
  };
}

function absolutePaths(server) {
  return `${server?.root ?? ""}` === "/";
}

function homeDirectory(server) {
  const home = cleanLogicalPath(server?.homePath ?? "");
  return home ? home : null;
}

function isWithin(path, folder) {
  return path === folder || path.startsWith(`${folder}/`);
}
