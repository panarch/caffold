import {
  errorFileTreeChildren,
  loadingFileTreeChildren,
  readyFileTreeChildren,
  unloadedFileTreeChildren,
} from "../../../components/file-tree.js";

// `levels` maps a directory id, or "" for the top of the tree, to its latest
// read: the `listing` that arrived last, and the read's `state` and `message`.
export function notesTreeNodes(levels) {
  const nodesIn = (listing) => [
    ...listing.directories.map((directory) => ({
      key: noteDirectoryKey(directory.id),
      kind: "directory",
      name: directory.name,
      children: directoryChildren(directory),
    })),
    ...listing.notes.map((note) => ({
      key: noteKey(note.id),
      kind: "file",
      name: note.name,
      noteId: note.id,
    })),
  ];
  const directoryChildren = (directory) => {
    if (directory.directoryCount === 0 && directory.noteCount === 0) {
      return readyFileTreeChildren([]);
    }
    const level = levels.get(directory.id);
    if (level?.listing) {
      return readyFileTreeChildren(nodesIn(level.listing));
    }
    if (level?.state === "loading") {
      return loadingFileTreeChildren("Loading…");
    }
    if (level?.state === "failed") {
      return errorFileTreeChildren(level.message);
    }
    return unloadedFileTreeChildren();
  };
  const top = levels.get("")?.listing;
  return top ? nodesIn(top) : [];
}

export function noteKey(noteId) {
  return `note:${noteId}`;
}

export function noteDirectoryKey(directoryId) {
  return `directory:${directoryId}`;
}

export function directoryIdFromKey(key) {
  const prefix = "directory:";
  const text = `${key ?? ""}`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : "";
}
