import { html } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { listDirectory } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type {
  CaffoldFileTree,
  FileTreeModel,
  FileTreeNode,
  FileTreeSelectDetail,
} from "#components/file-tree.js";
import "#components/file-tree.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  closestAcrossShadowRoots,
  containsAcrossShadowRoots,
  focusedElement,
} from "#app/shadow-roots.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import {
  DIRECTORY_FIELD_NODE,
  type DirectoryFieldEffect,
  type DirectoryFieldEvent,
  type DirectoryFieldRow,
  directoryFieldRows,
  initialDirectoryFieldState,
  PARENT_ROW_KEY,
  reduceDirectoryField,
} from "./directory-field/control.js";
import { directoryPathDisplay, type ServerPaths } from "./directory-path.js";

import styles from "./directory-field.css.js";

export const DIRECTORY_CHOSEN_EVENT = "caffold:task-directory-chosen";

// The directory a person chose, and whether focus goes back to the prompt.
export interface DirectoryChosenDetail {
  path: string;
  returnFocus: boolean;
}

// A loading phrase only appears once the wait is long enough to notice.
const LOADING_DELAY_MS = 180;
// What the keyboard mode draws over the page while it runs; focus moving
// there is not leaving the field.
const KEYBOARD_PRESENTATION = "caffold-keyboard-navigation-presentation";

const { CLOSED, BROWSING, EDITING } = DIRECTORY_FIELD_NODE;

let nextFieldId = 0;

// What the folder list shows: whether it is shown, the rows to hand it, or
// `null` to leave it showing what it does, and the row to bring into view.
interface FolderListView {
  hidden: boolean;
  model: FileTreeModel | null;
  reveal: string;
}

/**
 * New Task's working directory: the chosen path, a folder list to browse, and
 * a path to type.
 *
 * Its states and what each event does are in `directory-field/control.ts`;
 * this element draws them and runs their effects. Each accepted event draws
 * the field at once, because an effect can move focus into what it drew.
 */
@customElement("caffold-task-directory-field")
export class CaffoldTaskDirectoryField extends CaffoldElement {
  static override styles = styles;

  private state = initialDirectoryFieldState();
  private folderList: FolderListView = {
    hidden: true,
    model: null,
    reveal: "",
  };
  private loadingGeneration = 0;
  private loadingTimer = 0;
  private leaveCheck = 0;
  private pressedInside = false;
  private listeningOutside = false;
  private dismissOnLeave = true;
  private readonly fieldId = `task-directory-field-${++nextFieldId}`;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly toggle = new DrawnRef<HTMLButtonElement>(this);
  private readonly input = new DrawnRef<HTMLInputElement>(this);
  private readonly panel = new DrawnRef<HTMLDivElement>(this);
  private readonly tree = new DrawnRef<CaffoldFileTree>(this);
  private readonly outsidePointerDown = (event: PointerEvent) =>
    this.handleOutsidePointerDown(event);
  // The click a press makes comes after the press ends, so its focus move is
  // looked at once that click has run.
  private readonly pressEnded = () => {
    window.setTimeout(() => {
      this.pressedInside = false;
    }, 0);
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.clearTimeout(this.loadingTimer);
    window.clearTimeout(this.leaveCheck);
    this.dispatch({ type: "deactivate" });
    this.listenOutside(false);
  }

  // The field is drawn here even when the context changes nothing, since its
  // owner hands it the first context as it mounts it.
  setContext({
    path = "",
    server = {},
    locked = false,
    dismissOnLeave = true,
  }: {
    path?: string;
    server?: ServerPaths;
    locked?: boolean;
    dismissOnLeave?: boolean;
  } = {}) {
    this.dismissOnLeave = dismissOnLeave;
    this.dispatch({ type: "context", path, server, locked });
    this.performUpdate();
  }

  deactivate() {
    this.dispatch({ type: "deactivate" });
  }

  // Escape while typing returns to the list, so the field and not the
  // keyboard mode answers it.
  ownsEditingEscape(element: Element | null) {
    return Boolean(element) && element === this.input.value;
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    ...pull
  }: ActionHintPull = {}) {
    const panel = this.panel.value;
    return mergeActionHintScopes(
      this.hints.scope({ ...pull, scopeId, clipRoots }),
      this.state.node === CLOSED
        ? null
        : this.tree.value?.actionHintScope({
            scopeId: `${scopeId}:directory`,
            actions: { file: ACTION_HINT_ACTION.BUTTON_ACTIVATE },
            clipRoots: panel ? [...clipRoots, panel] : [...clipRoots],
          }),
    );
  }

  scrollSurfaceScope({ scopeId = "", ...pull }: ScrollSurfacePull = {}) {
    const tree = this.state.node === CLOSED ? null : this.tree.value;
    return (
      tree?.scrollSurfaceScope({
        ...pull,
        scopeId: `${scopeId}:directory`,
        label: "Folders",
      }) ?? emptyScrollSurfaceScope()
    );
  }

  override willUpdate() {
    this.folderList = this.nextFolderList();
  }

  override render() {
    const { node, path, server, locked, error } = this.state;
    const open = node !== CLOSED;
    const editing = node === EDITING;
    const shown = directoryPathDisplay(path, server);
    const editLabel = editing ? "Stop typing" : "Type a path";
    const folders = `${this.fieldId}-folders`;
    return html`
      <div class="task-directory-field-frame">
        <div
          class="task-directory-field-box"
          @pointerdown=${this.handlePointerDown}
          @click=${this.handleClick}
          @keydown=${this.handleKeydown}
          @focusout=${this.scheduleLeaveCheck}
        >
          <span class="task-directory-field-icon" aria-hidden="true">${inlineIcon(
            open ? "FolderOpen" : "Folder",
            "",
            "task-directory-field-glyph",
          )}</span>
          <button
            ${drawn(this.toggle)}
            ${this.hints.button({
              id: "directory:toggle",
              label: open ? "Hide folders" : "Show folders",
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
            type="button"
            class="task-directory-field-toggle"
            aria-expanded=${open ? "true" : "false"}
            aria-controls=${folders}
            aria-describedby=${`${this.fieldId}-path`}
            aria-label=${open ? "Hide folders" : "Show folders"}
            title=${shown}
            ?hidden=${editing}
            ?disabled=${locked}
          ><span
            class="task-directory-field-path"
            id=${`${this.fieldId}-path`}
          ><span dir="ltr">${shown}</span></span></button>
          <input
            ${drawn(this.input)}
            class="task-directory-field-input"
            type="text"
            role="combobox"
            aria-label="Working directory path"
            aria-expanded="true"
            aria-controls=${folders}
            aria-autocomplete="list"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            enterkeyhint="go"
            ?hidden=${!editing}
            @input=${this.handleInput}
          >
          <button
            ${this.hints.button({
              id: "directory:edit",
              label: editLabel,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
            type="button"
            class="task-directory-field-edit"
            aria-pressed=${editing ? "true" : "false"}
            aria-label=${editLabel}
            title=${editLabel}
            ?disabled=${locked}
          >${inlineIcon(
            "Pencil",
            editLabel,
            "task-directory-field-glyph",
          )}</button>
          <span
            class="task-directory-field-chevron"
            aria-hidden="true"
          >${inlineIcon(
            open ? "ChevronUp" : "ChevronDown",
            "",
            "task-directory-field-chevron-glyph",
          )}</span>
        </div>
        <div
          ${drawn(this.panel)}
          class="task-directory-field-panel"
          ?hidden=${!error && this.folderList.hidden}
          @pointerdown=${this.handlePointerDown}
          @keydown=${this.handleKeydown}
          @focusout=${this.scheduleLeaveCheck}
        >
          <p
            class="task-directory-field-error"
            role="alert"
            ?hidden=${!error}
          >${error}</p>
          <caffold-file-tree
            ${drawn(this.tree)}
            id=${folders}
            file-sort-mode="folders-first"
            ?hidden=${this.folderList.hidden}
            @caffold:file-tree-select=${this.chooseFolder}
          ></caffold-file-tree>
        </div>
      </div>
    `;
  }

  // The typed path, the rows handed to the folder list, and which row the
  // input points at depend on what was just drawn.
  override updated() {
    const { node, text, highlight } = this.state;
    const editing = node === EDITING;
    if (this.dataset.node !== node) {
      this.dataset.node = node;
    }
    this.listenOutside(node !== CLOSED && this.dismissOnLeave);
    const input = this.input.value;
    if (input && editing && input.value !== text) {
      input.value = text;
    }
    const tree = this.tree.value;
    if (tree && this.folderList.model) {
      tree.setModel(this.folderList.model);
      if (this.folderList.reveal) {
        void tree.revealKey(this.folderList.reveal);
      }
    }
    const activeId =
      editing && highlight && tree
        ? tree.optionIdForKey(rowKey(highlight))
        : "";
    if (activeId) {
      input?.setAttribute("aria-activedescendant", activeId);
    } else {
      input?.removeAttribute("aria-activedescendant");
    }
  }

  private dispatch(event: DirectoryFieldEvent) {
    const { state, effects } = reduceDirectoryField(this.state, event);
    if (state === this.state && effects.length === 0) {
      return;
    }
    this.state = state;
    this.requestUpdate();
    this.performUpdate();
    for (const effect of effects) {
      this.runEffect(effect);
    }
  }

  private runEffect(effect: DirectoryFieldEffect) {
    if (effect.type === "request") {
      this.requestListing(effect);
    } else if (effect.type === "choose") {
      this.dispatchEvent(
        new CustomEvent<DirectoryChosenDetail>(DIRECTORY_CHOSEN_EVENT, {
          bubbles: true,
          detail: { path: effect.path, returnFocus: effect.returnFocus },
        }),
      );
    } else if (effect.target === "input") {
      const input = this.input.value;
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    } else {
      this.toggle.value?.focus({ preventScroll: true });
    }
  }

  private requestListing({
    generation,
    path,
  }: {
    generation: number;
    path: string;
  }) {
    window.clearTimeout(this.loadingTimer);
    this.loadingGeneration = 0;
    this.loadingTimer = window.setTimeout(() => {
      if (this.state.request?.generation === generation) {
        this.loadingGeneration = generation;
        this.requestUpdate();
        this.performUpdate();
      }
    }, LOADING_DELAY_MS);
    listDirectory(path).then(
      (directory) =>
        this.dispatch({ type: "listing-loaded", generation, directory }),
      (error: unknown) =>
        this.dispatch({
          type: "listing-failed",
          generation,
          message: error instanceof Error ? error.message : `${error ?? ""}`,
        }),
    );
  }

  // While another folder is on its way the list keeps what it shows until the
  // wait is long enough for a loading phrase. A list with nothing to show says
  // so, unless an error above the list already says why.
  private nextFolderList(): FolderListView {
    const { node, listing, request, highlight, error, typed } = this.state;
    if (node === CLOSED) {
      return { hidden: true, model: null, reveal: "" };
    }
    const pending = request !== null && request.path !== listing?.path;
    if (pending && request.generation === this.loadingGeneration) {
      return {
        hidden: false,
        model: statusModel("Loading folders...", true),
        reveal: "",
      };
    }
    if (pending) {
      return { ...this.folderList, model: null, reveal: "" };
    }
    const rows = directoryFieldRows(this.state);
    if (rows.length === 0) {
      return {
        hidden: Boolean(error),
        model: statusModel(
          node === EDITING && typed?.name
            ? "No matching folders."
            : "No folders here.",
          false,
        ),
        reveal: "",
      };
    }
    return {
      hidden: false,
      model: {
        entityKey: `directory-field:${listing?.path ?? ""}`,
        nodes: rows.map(rowNode),
        selectedKey: highlight ? rowKey(highlight) : "",
        statusColumn: false,
        expandNewDirectories: false,
        hiddenEntriesLast: true,
        listboxLabel: "Folders",
      },
      reveal: highlight ? rowKey(highlight) : "",
    };
  }

  private handleInput() {
    this.dispatch({ type: "type", text: this.input.value?.value ?? "" });
  }

  private chooseFolder(event: CustomEvent<FileTreeSelectDetail>) {
    event.stopPropagation();
    const { node } = event.detail;
    if (node.kind === "directory") {
      this.dispatch({ type: "choose-row", path: node.path ?? "" });
    }
  }

  // Focus a press moves, or drops where a browser does not focus buttons, is
  // not leaving. Pressing the box around the buttons keeps focus where it is.
  private handlePointerDown(event: PointerEvent) {
    this.pressedInside = true;
    window.addEventListener("pointerup", this.pressEnded, {
      capture: true,
      once: true,
    });
    window.addEventListener("pointercancel", this.pressEnded, {
      capture: true,
      once: true,
    });
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(".task-directory-field-box") &&
      !target.closest("button, input")
    ) {
      event.preventDefault();
    }
  }

  private handleClick(event: MouseEvent) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest(".task-directory-field-edit")) {
      this.dispatch({ type: "toggle-edit" });
    } else if (event.target !== this.input.value) {
      this.dispatch({ type: "toggle-list" });
    }
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.target === this.input.value) {
      this.handleInputKeydown(event);
      return;
    }
    if (
      event.key === "Escape" &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      this.state.node === BROWSING
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.dispatch({ type: "escape" });
    }
  }

  private handleInputKeydown(event: KeyboardEvent) {
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.dispatch({
        type: "move-highlight",
        delta: event.key === "ArrowUp" ? -1 : 1,
      });
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

  private handleOutsidePointerDown(event: PointerEvent) {
    const [target] = event.composedPath();
    if (
      target instanceof Node &&
      !containsAcrossShadowRoots(this, target) &&
      !closestAcrossShadowRoots(target, KEYBOARD_PRESENTATION)
    ) {
      this.dispatch({ type: "leave" });
    }
  }

  // Focus is looked at once it has settled: moving between the field's own
  // controls, into the keyboard mode's overlay, or away from the window is
  // not leaving.
  private scheduleLeaveCheck() {
    if (!this.dismissOnLeave) {
      return;
    }
    window.clearTimeout(this.leaveCheck);
    this.leaveCheck = window.setTimeout(() => {
      const active = focusedElement();
      if (
        this.state.node === CLOSED ||
        this.pressedInside ||
        !document.hasFocus() ||
        containsAcrossShadowRoots(this, active) ||
        closestAcrossShadowRoots(active, KEYBOARD_PRESENTATION)
      ) {
        return;
      }
      this.dispatch({ type: "leave" });
    }, 0);
  }

  // A press anywhere outside an open field closes it.
  private listenOutside(listen: boolean) {
    if (listen === this.listeningOutside) {
      return;
    }
    this.listeningOutside = listen;
    if (listen) {
      document.addEventListener("pointerdown", this.outsidePointerDown, true);
    } else {
      document.removeEventListener(
        "pointerdown",
        this.outsidePointerDown,
        true,
      );
    }
  }
}

function statusModel(message: string, loading: boolean): FileTreeModel {
  return {
    entityKey: `directory-field-state:${message}`,
    nodes: [
      {
        key: "directory-field:status",
        kind: "status",
        name: message,
        tone: "muted",
        loading,
      },
    ],
    selectedKey: "",
    statusColumn: false,
    expandNewDirectories: false,
    listboxLabel: "Folders",
  };
}

function rowNode(row: DirectoryFieldRow): FileTreeNode {
  return row.parent
    ? {
        key: rowKey(row.key),
        kind: "directory",
        name: row.name,
        path: row.path,
        variant: "parent",
        isSymlink: false,
        supported: true,
        hidden: false,
        ignored: false,
        selection: false,
        ariaLabel: "Open parent folder",
      }
    : {
        key: rowKey(row.key),
        kind: "directory",
        name: row.name,
        path: row.path,
        isSymlink: row.isSymlink,
        git: row.git ?? undefined,
        supported: true,
        hidden: row.name.startsWith("."),
        ignored: row.gitIgnored,
        selection: false,
        ariaLabel: `Open ${row.name} folder`,
      };
}

function rowKey(key: string) {
  return key === PARENT_ROW_KEY
    ? "directory-field:parent"
    : `directory-field:folder:${key}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-directory-field": CaffoldTaskDirectoryField;
  }

  interface HTMLElementEventMap {
    [DIRECTORY_CHOSEN_EVENT]: CustomEvent<DirectoryChosenDetail>;
  }
}
