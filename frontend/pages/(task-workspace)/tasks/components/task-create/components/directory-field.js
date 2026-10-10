import { listDirectory } from "#app/api.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { FILE_TREE_SELECT_EVENT } from "#components/file-tree.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";
import { directoryPathDisplay } from "../directory-path.js";
import {
  DIRECTORY_FIELD_NODE,
  PARENT_ROW_KEY,
  directoryFieldRows,
  initialDirectoryFieldState,
  reduceDirectoryField,
} from "./directory-field/control.js";

export const DIRECTORY_CHOSEN_EVENT = "caffold:task-directory-chosen";

// A loading phrase only appears once the wait is long enough to notice.
const LOADING_DELAY_MS = 180;
// What the keyboard mode draws over the page while it runs; focus moving
// there is not leaving the field.
const KEYBOARD_PRESENTATION = "caffold-keyboard-navigation-presentation";

let nextFieldId = 0;

// New Task's working directory: the chosen path, a folder list to browse, and
// a path to type. Its states and what each event does are in
// `directory-field/control.js`; this element draws them and runs their effects.
class CaffoldTaskDirectoryField extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    window.clearTimeout(this.loadingTimer);
    window.clearTimeout(this.leaveCheck);
    this.dispatch({ type: "deactivate" });
  }

  setContext({ path = "", server = {}, locked = false } = {}) {
    this.ensureRendered();
    this.dispatch({ type: "context", path, server, locked });
  }

  deactivate() {
    this.ensureRendered();
    this.dispatch({ type: "deactivate" });
  }

  // Escape while typing returns to the list, so the field and not the
  // keyboard mode answers it.
  ownsEditingEscape(element) {
    return Boolean(element) && element === this.input();
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (!scopeId) {
      return emptyActionHintScope();
    }
    const node = this.state.node;
    const buttons = [
      ["toggle", this.toggle()],
      ["edit", this.editButton()],
    ].flatMap(([identity, control]) =>
      control && !control.hidden && !control.disabled && hasActionHintLayoutBox(control)
        ? [buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:directory:${identity}`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label: control.getAttribute("aria-label") ?? identity,
            control,
            clipRoots: [...clipRoots],
            isActionable: () =>
              this.isConnected &&
              this.state.node === node &&
              !control.hidden &&
              !control.disabled &&
              hasActionHintLayoutBox(control),
          })]
        : []
    );
    return mergeActionHintScopes(
      { blocked: false, targets: buttons, mutationRoots: [this], scrollRoots: [] },
      node === DIRECTORY_FIELD_NODE.CLOSED
        ? null
        : this.tree()?.actionHintScope({
            scopeId: `${scopeId}:directory`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            clipRoots: [...clipRoots, this.panel()].filter(Boolean),
            includeDirectories: true,
          }),
    );
  }

  scrollSurfaceScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (!scopeId || this.state.node === DIRECTORY_FIELD_NODE.CLOSED) {
      return emptyScrollSurfaceScope();
    }
    return this.tree()?.scrollSurfaceScope({
      scopeId: `${scopeId}:directory`,
      label: "Folders",
      clipRoots,
      isCurrent: () => this.state.node !== DIRECTORY_FIELD_NODE.CLOSED,
    }) ?? emptyScrollSurfaceScope();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.state = initialDirectoryFieldState();
    this.loadingGeneration = 0;
    this.loadingTimer = 0;
    this.leaveCheck = 0;
    this.pressedInside = false;
    const id = `task-directory-field-${++nextFieldId}`;
    this.innerHTML = `
      <div class="task-directory-field-box">
        <span class="task-directory-field-icon" aria-hidden="true"></span>
        <button
          type="button"
          class="task-directory-field-toggle"
          aria-expanded="false"
          aria-controls="${id}-folders"
          aria-describedby="${id}-path"
        ><span class="task-directory-field-path" id="${id}-path"><span dir="ltr"></span></span></button>
        <input
          class="task-directory-field-input"
          type="text"
          role="combobox"
          aria-label="Working directory path"
          aria-expanded="true"
          aria-controls="${id}-folders"
          aria-autocomplete="list"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="go"
          hidden
        >
        <button
          type="button"
          class="task-directory-field-edit"
          aria-pressed="false"
        ></button>
        <span class="task-directory-field-chevron" aria-hidden="true"></span>
      </div>
      <div class="task-directory-field-panel" hidden>
        <p class="task-directory-field-error" role="alert" hidden></p>
        <caffold-file-tree id="${id}-folders" file-sort-mode="folders-first" hidden></caffold-file-tree>
      </div>
    `;
    this.boundIconsReady = () => {
      this.drawnIcons = "";
      this.render();
    };
    this.boundDocumentPointerDown = (event) => this.handleDocumentPointerDown(event);
    // The click a press makes comes after the press ends, so its focus move is
    // looked at once that click has run.
    this.boundPressEnded = () => {
      window.setTimeout(() => {
        this.pressedInside = false;
      }, 0);
    };
    this.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("keydown", (event) => this.handleKeydown(event));
    this.addEventListener("focusout", () => this.scheduleLeaveCheck());
    this.input().addEventListener("input", () => {
      this.dispatch({ type: "type", text: this.input().value });
    });
    this.tree().addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      event.stopPropagation();
      const node = event.detail?.node;
      if (node?.kind === "directory") {
        this.dispatch({ type: "choose-row", path: `${node.path ?? ""}` });
      }
    });
    this.render();
  }

  dispatch(event) {
    const { state, effects } = reduceDirectoryField(this.state, event);
    if (state === this.state && effects.length === 0) {
      return;
    }
    this.state = state;
    this.render();
    for (const effect of effects) {
      this.runEffect(effect);
    }
  }

  runEffect(effect) {
    if (effect.type === "request") {
      this.requestListing(effect);
    } else if (effect.type === "choose") {
      this.dispatchEvent(new CustomEvent(DIRECTORY_CHOSEN_EVENT, {
        bubbles: true,
        detail: { path: effect.path, returnFocus: effect.returnFocus },
      }));
    } else if (effect.type === "focus") {
      const target = effect.target === "input" ? this.input() : this.toggle();
      target?.focus({ preventScroll: true });
      if (effect.target === "input") {
        const end = target.value.length;
        target.setSelectionRange(end, end);
      }
    }
  }

  requestListing({ generation, path }) {
    window.clearTimeout(this.loadingTimer);
    this.loadingGeneration = 0;
    this.loadingTimer = window.setTimeout(() => {
      if (this.state.request?.generation === generation) {
        this.loadingGeneration = generation;
        this.render();
      }
    }, LOADING_DELAY_MS);
    listDirectory(path).then(
      (directory) => this.dispatch({ type: "listing-loaded", generation, directory }),
      (error) => this.dispatch({
        type: "listing-failed",
        generation,
        message: error instanceof Error ? error.message : `${error ?? ""}`,
      }),
    );
  }

  // Focus a press moves, or drops where a browser does not focus buttons, is
  // not leaving. Pressing the box around the buttons keeps focus where it is.
  handlePointerDown(event) {
    this.pressedInside = true;
    window.addEventListener("pointerup", this.boundPressEnded, { capture: true, once: true });
    window.addEventListener("pointercancel", this.boundPressEnded, { capture: true, once: true });
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".task-directory-field-box") &&
      !target.closest("button, input")
    ) {
      event.preventDefault();
    }
  }

  handleClick(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest(".task-directory-field-edit")) {
      this.dispatch({ type: "toggle-edit" });
    } else if (
      event.target.closest(".task-directory-field-box") &&
      event.target !== this.input()
    ) {
      this.dispatch({ type: "toggle-list" });
    }
  }

  handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.target === this.input()) {
      this.handleInputKeydown(event);
      return;
    }
    if (
      event.key === "Escape" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      this.state.node === DIRECTORY_FIELD_NODE.BROWSING
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.dispatch({ type: "escape" });
    }
  }

  handleInputKeydown(event) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.dispatch({ type: "move-highlight", delta: event.key === "ArrowUp" ? -1 : 1 });
    } else if (event.key === "Tab" && !event.shiftKey && this.state.highlight) {
      event.preventDefault();
      this.dispatch({ type: "complete" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.dispatch({ type: "submit" });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.dispatch({ type: "escape" });
    }
  }

  handleDocumentPointerDown(event) {
    const target = event.target;
    if (
      target instanceof Node &&
      !this.contains(target) &&
      !(target instanceof Element && target.closest(KEYBOARD_PRESENTATION))
    ) {
      this.dispatch({ type: "leave" });
    }
  }

  // Focus is looked at once it has settled: moving between the field's own
  // controls, into the keyboard mode's overlay, or away from the window is
  // not leaving.
  scheduleLeaveCheck() {
    window.clearTimeout(this.leaveCheck);
    this.leaveCheck = window.setTimeout(() => {
      const active = document.activeElement;
      if (
        this.state.node === DIRECTORY_FIELD_NODE.CLOSED ||
        this.pressedInside ||
        !document.hasFocus() ||
        this.contains(active) ||
        active?.closest?.(KEYBOARD_PRESENTATION)
      ) {
        return;
      }
      this.dispatch({ type: "leave" });
    }, 0);
  }

  render() {
    const { node, path, server, locked, error, text, highlight } = this.state;
    const open = node !== DIRECTORY_FIELD_NODE.CLOSED;
    const editing = node === DIRECTORY_FIELD_NODE.EDITING;
    this.dataset.node = node;
    this.syncDocumentListener(open);

    const shown = directoryPathDisplay(path, server);
    const toggle = this.toggle();
    toggle.hidden = editing;
    toggle.disabled = locked;
    toggle.title = shown;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Hide folders" : "Show folders");
    toggle.querySelector(".task-directory-field-path > span").textContent = shown;

    const input = this.input();
    input.hidden = !editing;
    if (editing && input.value !== text) {
      input.value = text;
    }

    const edit = this.editButton();
    const editLabel = editing ? "Stop typing" : "Type a path";
    edit.disabled = locked;
    edit.setAttribute("aria-pressed", editing ? "true" : "false");
    edit.setAttribute("aria-label", editLabel);
    edit.title = editLabel;

    this.drawIcons(open, editLabel);

    const errorLine = this.querySelector(":scope > .task-directory-field-panel > .task-directory-field-error");
    errorLine.hidden = !error;
    errorLine.textContent = error;

    if (open) {
      this.renderRows();
    } else {
      this.tree().hidden = true;
    }
    this.panel().hidden = errorLine.hidden && this.tree().hidden;
    const activeId = editing && highlight
      ? this.tree().optionIdForKey(rowKey(highlight))
      : "";
    if (activeId) {
      input.setAttribute("aria-activedescendant", activeId);
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  // While another folder is on its way the list keeps what it shows until the
  // wait is long enough for a loading phrase. A list with nothing to show says
  // so, unless an error above the list already says why.
  renderRows() {
    const { node, listing, request, highlight, error, typed } = this.state;
    const tree = this.tree();
    const pending = Boolean(request) && request.path !== listing?.path;
    if (pending && request.generation === this.loadingGeneration) {
      tree.hidden = false;
      this.renderStatusRow("Loading folders...", true);
      return;
    }
    if (pending) {
      return;
    }
    const rows = directoryFieldRows(this.state);
    if (rows.length === 0) {
      tree.hidden = Boolean(error);
      this.renderStatusRow(
        node === DIRECTORY_FIELD_NODE.EDITING && typed?.name
          ? "No matching folders."
          : "No folders here.",
        false,
      );
      return;
    }
    tree.hidden = false;
    tree.setModel({
      entityKey: `directory-field:${listing.path}`,
      nodes: rows.map(rowNode),
      selectedKey: highlight ? rowKey(highlight) : "",
      statusColumn: false,
      expandNewDirectories: false,
      hiddenEntriesLast: true,
      listboxLabel: "Folders",
    });
    if (highlight) {
      void tree.revealKey(rowKey(highlight));
    }
  }

  renderStatusRow(message, loading) {
    this.tree().setModel({
      entityKey: `directory-field-state:${message}`,
      nodes: [{
        key: "directory-field:status",
        kind: "status",
        name: message,
        tone: "muted",
        loading,
      }],
      selectedKey: "",
      statusColumn: false,
      expandNewDirectories: false,
      listboxLabel: "Folders",
    });
  }

  drawIcons(open, editLabel) {
    const signature = `${open}:${editLabel}`;
    if (this.drawnIcons === signature) {
      return;
    }
    this.drawnIcons = signature;
    this.querySelector(":scope > .task-directory-field-box > .task-directory-field-icon")
      .innerHTML = renderInlineIcon(open ? "FolderOpen" : "Folder", "", "task-directory-field-glyph");
    this.querySelector(":scope > .task-directory-field-box > .task-directory-field-chevron")
      .innerHTML = renderInlineIcon(open ? "ChevronUp" : "ChevronDown", "", "task-directory-field-chevron-glyph");
    this.editButton().innerHTML = renderInlineIcon("Pencil", editLabel, "task-directory-field-glyph");
  }

  syncDocumentListener(open) {
    if (open === Boolean(this.listeningOutside)) {
      return;
    }
    this.listeningOutside = open;
    if (open) {
      document.addEventListener("pointerdown", this.boundDocumentPointerDown, true);
    } else {
      document.removeEventListener("pointerdown", this.boundDocumentPointerDown, true);
    }
  }

  toggle() {
    return this.querySelector(":scope > .task-directory-field-box > .task-directory-field-toggle");
  }

  input() {
    return this.querySelector(":scope > .task-directory-field-box > .task-directory-field-input");
  }

  editButton() {
    return this.querySelector(":scope > .task-directory-field-box > .task-directory-field-edit");
  }

  panel() {
    return this.querySelector(":scope > .task-directory-field-panel");
  }

  tree() {
    return this.querySelector(":scope > .task-directory-field-panel > caffold-file-tree");
  }
}

if (!customElements.get("caffold-task-directory-field")) {
  customElements.define("caffold-task-directory-field", CaffoldTaskDirectoryField);
}

function rowNode(row) {
  return {
    key: rowKey(row.key),
    kind: "directory",
    name: row.name,
    path: row.path,
    variant: row.parent ? "parent" : undefined,
    isSymlink: Boolean(row.isSymlink),
    git: row.git ?? undefined,
    supported: true,
    hidden: !row.parent && row.name.startsWith("."),
    ignored: Boolean(row.gitIgnored),
    selection: false,
    ariaLabel: row.parent ? "Open parent folder" : `Open ${row.name} folder`,
  };
}

function rowKey(key) {
  return key === PARENT_ROW_KEY ? "directory-field:parent" : `directory-field:folder:${key}`;
}
