export type NotesSelectionNode =
  | "single"
  | "choose-companion"
  | "paired"
  | "replace-primary"
  | "replace-secondary";

export type NotesSelectionEvent =
  | "route"
  | "start"
  | "cancel"
  | "primary"
  | "secondary";

export type NotesPicker = "" | "primary" | "secondary";

export class NotesSelection {
  node: NotesSelectionNode = "single";

  transition(
    event: NotesSelectionEvent,
    { paired = false, readable = false } = {},
  ) {
    const next =
      event === "route"
        ? paired
          ? "paired"
          : "single"
        : EDGES[this.node][event];
    if (!next || (event === "start" && !readable)) return false;
    this.node = next;
    return true;
  }

  get split() {
    return this.node !== "single";
  }

  get picker(): NotesPicker {
    if (this.node === "replace-primary") return "primary";
    if (this.node === "choose-companion" || this.node === "replace-secondary") {
      return "secondary";
    }
    return "";
  }
}

// Transient selection edges; the route owns committed Note ids.
const EDGES: Record<
  NotesSelectionNode,
  Partial<Record<NotesSelectionEvent, NotesSelectionNode>>
> = {
  single: { start: "choose-companion" },
  "choose-companion": { cancel: "single" },
  paired: { primary: "replace-primary", secondary: "replace-secondary" },
  "replace-primary": { cancel: "paired", secondary: "replace-secondary" },
  "replace-secondary": { cancel: "paired", primary: "replace-primary" },
};
