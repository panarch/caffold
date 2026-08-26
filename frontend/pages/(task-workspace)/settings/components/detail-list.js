const VALUE_KINDS = new Set(["code", "time"]);
const UNKNOWN_VALUE = "—";

/**
 * A settings label/value list. Rows arrive as one snapshot and are matched by
 * key, so a list that already holds the right rows rewrites only what changed.
 * A row whose value is not known yet keeps its place and shows a placeholder.
 */
class CaffoldSettingsDetailList extends HTMLElement {
  connectedCallback() {
    this.mount();
  }

  /** The rows this list shows, in order. Omit a value that is still loading. */
  setRows(rows) {
    this.mount();
    const keys = new Set();
    let anchor = null;
    let busy = false;
    for (const row of rows) {
      const entry = this.reconcile(row);
      keys.add(row.key);
      busy ||= !known(row.value);
      const slot = anchor ? anchor.nextSibling : this.list.firstChild;
      if (slot !== entry.element) {
        this.list.insertBefore(entry.element, slot);
      }
      anchor = entry.element;
    }
    for (const [key, entry] of this.entries) {
      if (!keys.has(key)) {
        entry.element.remove();
        this.entries.delete(key);
      }
    }
    this.setBusy(busy);
  }

  mount() {
    if (this.list) {
      return;
    }
    this.entries = new Map();
    this.busy = false;
    this.list = document.createElement("dl");
    this.append(this.list);
  }

  reconcile(row) {
    let entry = this.entries.get(row.key);
    if (!entry) {
      entry = createEntry(row.key);
      this.entries.set(row.key, entry);
    }
    const applied = entry.applied;

    const label = row.label ?? "";
    if (applied.label !== label) {
      entry.term.textContent = label;
      applied.label = label;
    }

    // The value element carries the kind, so a kind change replaces it while a
    // plain value change writes text into the element already standing there.
    const shape = valueShape(row);
    const value = known(row.value) ? String(row.value) : UNKNOWN_VALUE;
    if (applied.shape !== shape) {
      entry.definition.replaceChildren(valueNode(shape, value));
      entry.definition.toggleAttribute("data-unknown", shape === "unknown");
      applied.shape = shape;
      applied.value = value;
      applied.datetime = "";
    } else if (applied.value !== value) {
      entry.definition.firstChild.textContent = value;
      applied.value = value;
    }

    if (shape === "time") {
      const datetime = row.datetime ?? "";
      if (applied.datetime !== datetime) {
        entry.definition.firstChild.setAttribute("datetime", datetime);
        applied.datetime = datetime;
      }
    }

    const state = row.state ?? "";
    if (applied.state !== state) {
      if (state) {
        entry.definition.dataset.state = state;
      } else {
        delete entry.definition.dataset.state;
      }
      applied.state = state;
    }

    return entry;
  }

  setBusy(busy) {
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    if (busy) {
      this.list.setAttribute("aria-busy", "true");
    } else {
      this.list.removeAttribute("aria-busy");
    }
  }
}

function known(value) {
  return value !== undefined && value !== null;
}

function valueShape(row) {
  if (!known(row.value)) {
    return "unknown";
  }
  return VALUE_KINDS.has(row.kind) ? row.kind : "text";
}

function createEntry(key) {
  const element = document.createElement("div");
  element.dataset.key = key;
  const term = document.createElement("dt");
  const definition = document.createElement("dd");
  element.append(term, definition);
  return { element, term, definition, applied: {} };
}

function valueNode(shape, value) {
  if (shape === "code" || shape === "time") {
    const element = document.createElement(shape);
    element.textContent = value;
    return element;
  }
  return document.createTextNode(value);
}

customElements.define("caffold-settings-detail-list", CaffoldSettingsDetailList);
