import { listDirectory } from "../../../../api.js";
import {
  FILE_TREE_SELECT_EVENT,
} from "../../../../components/file-tree.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";

const DIRECTORY_LOADING_DELAY_MS = 180;

class CaffoldTaskDirectoryPicker extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachIconListener();
    warmIcons();
  }

  disconnectedCallback() {
    this.directoryRequestId += 1;
    if (this.iconsReadyListening) {
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
      this.iconsReadyListening = false;
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.directoryRequestId = 0;
    this.currentPath = "";
    this.currentRoot = "";
    this.currentDirectory = null;
    this.opener = null;
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-directory-picker-title">
        <article class="task-directory-picker-card">
          <header class="task-directory-picker-header">
            <div>
              <h2 id="task-directory-picker-title">Choose Working Directory</h2>
              <p data-directory-picker-path></p>
            </div>
            <button
              type="button"
              class="task-icon-button task-directory-picker-close"
              data-directory-picker-action="close"
              aria-label="Close directory picker"
              title="Close directory picker"
              autofocus
            >${renderInlineIcon(
              "X",
              "Close directory picker",
              "task-action-icon",
            )}</button>
          </header>
          <div class="task-directory-picker-body">
            <p class="task-directory-picker-error" role="alert" hidden></p>
            <caffold-file-tree aria-label="Folders and files"></caffold-file-tree>
          </div>
          <footer class="task-directory-picker-footer">
            <button
              type="button"
              class="task-secondary-button"
              data-directory-picker-action="close"
            >Cancel</button>
            <button
              type="button"
              class="task-primary-button"
              data-directory-picker-action="choose"
            >Use This Folder</button>
          </footer>
        </article>
      </dialog>
    `;

    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      this.handleTreeSelection(event);
    });
    this.dialog().addEventListener("close", () => this.handleClose());
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.refreshCloseIcon();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  tree() {
    return this.querySelector("caffold-file-tree");
  }

  open(path = "", options = {}) {
    this.ensureRendered();
    this.opener =
      options.opener instanceof HTMLElement
        ? options.opener
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    this.currentDirectory = null;
    this.currentPath = normalizeDirectoryPath(path);
    this.currentRoot = "";
    this.setError(null);
    this.setTreeMessage("Loading folders...");
    this.setChoosingEnabled(false);
    this.updatePathLabel();
    if (!this.dialog().open) {
      this.dialog().showModal();
    }
    void this.loadDirectory(this.currentPath, { immediateLoading: true });
  }

  dismiss() {
    const dialog = this.dialog();
    if (dialog?.open) {
      dialog.close("cancel");
    }
  }

  async loadDirectory(path, options = {}) {
    const requestId = ++this.directoryRequestId;
    const targetPath = normalizeDirectoryPath(path);
    const body = this.querySelector(".task-directory-picker-body");
    body?.setAttribute("aria-busy", "true");
    this.setError(null);
    this.setChoosingEnabled(false);
    const loadingTimer = window.setTimeout(() => {
      if (requestId === this.directoryRequestId) {
        this.setTreeMessage("Loading folders...");
      }
    }, options.immediateLoading ? 0 : DIRECTORY_LOADING_DELAY_MS);

    try {
      const directory = await listDirectory(targetPath);
      if (requestId !== this.directoryRequestId) {
        return null;
      }
      this.currentDirectory = directory;
      this.currentPath = normalizeDirectoryPath(directory.path);
      this.currentRoot = `${directory.root ?? ""}`;
      this.updatePathLabel();
      this.renderDirectory(directory);
      this.setChoosingEnabled(true);
      return directory;
    } catch (error) {
      if (requestId !== this.directoryRequestId) {
        return null;
      }
      const message = error instanceof Error ? error.message : `${error}`;
      this.setError(message || "Unable to load this directory.");
      if (!this.currentDirectory) {
        this.setTreeMessage("Unable to load this directory.", "error");
      } else {
        this.setChoosingEnabled(true);
      }
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
      if (requestId === this.directoryRequestId) {
        body?.removeAttribute("aria-busy");
      }
    }
  }

  handleClick(event) {
    const action =
      event.target instanceof Element
        ? event.target.closest("[data-directory-picker-action]")
        : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    if (action.dataset.directoryPickerAction === "close") {
      this.dialog().close("cancel");
      return;
    }
    if (
      action.dataset.directoryPickerAction === "choose" &&
      this.currentDirectory
    ) {
      this.dispatchEvent(
        new CustomEvent("caffold:directory-picked", {
          bubbles: true,
          composed: true,
          detail: { path: this.currentPath },
        }),
      );
      this.dialog().close("selected");
    }
  }

  handleTreeSelection(event) {
    if (event.target !== this.tree()) {
      return;
    }
    event.stopPropagation();
    const entry = event.detail?.node?.source;
    if (entry?.kind !== "directory" || entry.supported === false) {
      return;
    }
    void this.loadDirectory(entry.path ?? "");
  }

  handleClose() {
    this.directoryRequestId += 1;
    const opener = this.opener;
    this.opener = null;
    window.requestAnimationFrame(() => {
      if (opener?.isConnected) {
        opener.focus();
      }
    });
  }

  renderDirectory(directory) {
    const nodes = [
      ...parentDirectoryNode(this.currentPath),
      ...directory.entries.map(directoryEntryNode),
    ];
    this.tree().setModel({
      entityKey: `directory-picker:${this.currentPath}`,
      nodes,
      selectedKey: "",
      statusColumn: false,
      expandNewDirectories: false,
    });
  }

  setTreeMessage(message, tone = "muted") {
    this.tree().setModel({
      entityKey: `directory-picker-state:${message}`,
      nodes: [
        {
          key: "directory-picker:state",
          kind: "status",
          name: message,
          tone,
        },
      ],
      selectedKey: "",
      statusColumn: false,
      expandNewDirectories: false,
    });
  }

  setChoosingEnabled(enabled) {
    const button = this.querySelector('[data-directory-picker-action="choose"]');
    if (button) {
      button.disabled = !enabled;
    }
  }

  setError(message) {
    const error = this.querySelector(".task-directory-picker-error");
    if (!error) {
      return;
    }
    error.hidden = !message;
    error.textContent = message ?? "";
  }

  updatePathLabel() {
    const label = this.querySelector("[data-directory-picker-path]");
    if (label) {
      label.textContent = displayDirectoryPath(this.currentRoot, this.currentPath);
      label.title = label.textContent;
    }
  }

  refreshCloseIcon() {
    const button = this.querySelector(".task-directory-picker-close");
    if (button) {
      button.innerHTML = renderInlineIcon(
        "X",
        "Close directory picker",
        "task-action-icon",
      );
    }
  }
}

if (!customElements.get("caffold-task-directory-picker")) {
  customElements.define(
    "caffold-task-directory-picker",
    CaffoldTaskDirectoryPicker,
  );
}

function directoryEntryNode(entry) {
  const selectable = entry.kind === "directory" && entry.supported !== false;
  return {
    key: `directory-picker:entry:${entry.path}`,
    kind: entry.kind,
    name: entry.name,
    path: entry.path,
    isSymlink: Boolean(entry.isSymlink),
    git: entry.git,
    supported: entry.supported !== false,
    disabled: !selectable,
    hidden: entry.name.startsWith("."),
    ignored: Boolean(entry.gitIgnored),
    title: selectable
      ? "Open folder"
      : entry.supported === false
        ? "This path resolves outside the root"
        : "Files cannot be selected here",
    ariaLabel: selectable
      ? `Open ${entry.name} folder`
      : `${entry.name} file, not selectable`,
    source: entry,
  };
}

function parentDirectoryNode(path) {
  if (!path) {
    return [];
  }
  const parentPath = parentDirectoryPath(path);
  return [
    {
      key: `directory-picker:parent:${path}`,
      kind: "directory",
      name: "..",
      path: parentPath,
      variant: "parent",
      selection: false,
      title: "Go to parent directory",
      ariaLabel: "Open parent directory",
      source: {
        name: "..",
        path: parentPath,
        kind: "directory",
        isSymlink: false,
        supported: true,
      },
    },
  ];
}

function normalizeDirectoryPath(path) {
  return `${path ?? ""}`
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function parentDirectoryPath(path) {
  const parts = normalizeDirectoryPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function displayDirectoryPath(root, path) {
  const base = `${root ?? ""}`.replaceAll("\\", "/");
  if (base === "/") {
    return path ? `/${path}` : "/";
  }
  const trimmedBase = base.replace(/\/+$/, "");
  if (!trimmedBase) {
    return path || ".";
  }
  return path ? `${trimmedBase}/${path}` : trimmedBase;
}
