import type { NoteDirectorySummary, NotesLevel } from "#app/api.js";
import {
  errorFileTreeChildren,
  type FileTreeChildren,
  type FileTreeNode,
  loadingFileTreeChildren,
  readyFileTreeChildren,
  unloadedFileTreeChildren,
} from "#components/file-tree.ts";

// The latest read of one level: the `listing` that arrived last, and the
// read's `state` and `message`.
export interface NotesLevelRead {
  state: "pending" | "loading" | "ready" | "failed";
  listing: NotesLevel | null;
  message: string;
}

// A directory id, or "" for the top of the tree, to its latest read.
export type NotesLevels = Map<string, NotesLevelRead>;

// A Note's node carries its id as the node's source.
export function notesTreeNodes(
  levels: NotesLevels,
  { disabledNoteId = "" } = {},
): FileTreeNode[] {
  const nodesIn = (listing: NotesLevel): FileTreeNode[] => [
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
      source: note.id,
      ...(note.id === disabledNoteId ? { disabled: true } : {}),
    })),
  ];
  const directoryChildren = (
    directory: NoteDirectorySummary,
  ): FileTreeChildren => {
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

export function noteIdOf(node: FileTreeNode | null | undefined) {
  return node?.source as string | undefined;
}

export function noteKey(noteId: string) {
  return `note:${noteId}`;
}

export function noteDirectoryKey(directoryId: string) {
  return `directory:${directoryId}`;
}

export function directoryIdFromKey(key: string | null | undefined) {
  const prefix = "directory:";
  const text = `${key ?? ""}`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : "";
}
