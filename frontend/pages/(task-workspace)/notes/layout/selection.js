export class NotesSelection {
  constructor() {
    this.node = "single";
  }

  transition(event, { paired = false, readable = false } = {}) {
    const next = event === "route" ? (paired ? "paired" : "single") : EDGES[this.node]?.[event];
    if (!next || (event === "start" && !readable)) return false;
    this.node = next;
    return true;
  }

  get split() { return this.node !== "single"; }

  get picker() {
    if (this.node === "replace-primary") return "primary";
    if (["choose-companion", "replace-secondary"].includes(this.node)) return "secondary";
    return "";
  }
}

// Transient selection edges; the route owns committed Note ids.
const EDGES = {
  single: { start: "choose-companion" },
  "choose-companion": { cancel: "single" },
  paired: { primary: "replace-primary", secondary: "replace-secondary" },
  "replace-primary": { cancel: "paired", secondary: "replace-secondary" },
  "replace-secondary": { cancel: "paired", primary: "replace-primary" },
};
