import { listDirectory } from "../../api.js";
import { entryKindLabel, escapeHtml } from "../dom.js";
import {
  errorFileTreeChildren,
  FILE_TREE_LOAD_EVENT,
  FILE_TREE_SELECT_EVENT,
  loadingFileTreeChildren,
  readyFileTreeChildren,
  unloadedFileTreeChildren,
} from "../file-tree.js";
import { renderInlineIcon } from "../icons.js";
import {
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../action-hint-scope.js";
import { emptyScrollSurfaceScope } from "../../scroll-scope.js";

const TREE_LOADING_DELAY_MS = 180;

class CaffoldFileList extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.addEventListener("click", (event) => {
      if (!event.target.closest('button[data-action="refresh-files"]')) {
        return;
      }
      this.dispatchEvent(new CustomEvent("caffold:refresh-file-list", { bubbles: true }));
    });
    this.addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      if (event.target !== this.fileTree()) {
        return;
      }
      event.stopPropagation();
      const entry = event.detail.node.source;
      if (!entry) {
        return;
      }
      const eventName = entry.kind === "directory" ? "caffold:open-directory" : "caffold:open-file";
      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          detail: { path: entry.path, entry: this.entryForPath(entry.path) ?? entry },
        }),
      );
    });
    this.addEventListener(FILE_TREE_LOAD_EVENT, (event) => {
      if (event.target !== this.fileTree()) {
        return;
      }
      event.stopPropagation();
      const path = event.detail.path;
      this.treeState?.errors.delete(path);
      this.updateTreeModel();
      void this.loadTreeDirectory(path);
    });
    this.setIdle();
  }

  disconnectedCallback() {
    this.clearTreeLoadingTimers();
  }

  setLoading() {
    this.resetTreeState();
    this.state = { status: "loading" };
    this.render();
  }

  setIdle() {
    this.resetTreeState();
    this.state = { status: "idle" };
    this.render();
  }

  setDirectory(directory) {
    this.prepareTreeState(directory);
    this.state = { status: "ready", directory };
    this.render();
    const scroller = this.fileTree()?.scroller();
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  }

  updateDirectories(directories) {
    if (!directories.length || this.state?.status !== "ready") {
      return;
    }
    const currentPath = this.state.directory.path;
    const current = directories.find((directory) => directory.path === currentPath);
    let changed = false;
    if (current) {
      changed ||= !sameDirectoryPresentation(this.state.directory, current);
      this.prepareTreeState(current);
      this.state = { status: "ready", directory: current };
    }
    if (this.treeState) {
      for (const directory of directories) {
        changed ||= !sameDirectoryPresentation(this.treeState.cache.get(directory.path), directory);
        this.treeState.cache.set(directory.path, directory);
      }
    }
    if (changed) {
      this.render();
    }
  }

  cachedDirectoryPaths() {
    if (this.treeState) {
      return Array.from(this.treeState.cache.keys());
    }
    return this.state?.status === "ready" ? [this.state.directory.path] : [];
  }

  hasCachedDirectory(path) {
    return this.cachedDirectoryPaths().includes(path);
  }

  setRefreshState(state) {
    this.refreshState = state;
    this.patchRefreshButton();
  }

  setRefreshVisible(visible) {
    const nextVisible = Boolean(visible);
    if (this.refreshVisible === nextVisible) {
      return;
    }
    this.refreshVisible = nextVisible;
    if (this.state?.status === "ready" && this.readyHeader()) {
      this.patchReadyHeader(this.state.directory);
    } else {
      this.render();
    }
  }

  setError(error) {
    this.resetTreeState();
    this.state = { status: "error", error };
    this.render();
  }

  render() {
    const state = this.state ?? { status: "idle" };
    if (state.status !== "ready") {
      const message =
        state.status === "loading"
          ? "Loading files..."
          : state.status === "error"
            ? escapeHtml(state.error.message)
            : "";
      this.innerHTML = `
        <section class="file-list-panel${state.status === "error" ? " error-panel" : ""}"${
          state.status === "loading" ? ' aria-busy="true"' : ""
        }>
          <header><h2>Files</h2></header>
          ${message ? `<p class="surface-message">${message}</p>` : "<caffold-file-tree></caffold-file-tree>"}
        </section>
      `;
      return;
    }

    const { directory } = state;
    let panel = this.querySelector(":scope > .file-list-panel[data-content='ready']");
    if (!panel) {
      this.innerHTML = `
        <section class="file-list-panel" data-content="ready">
          <header></header>
          <caffold-file-tree></caffold-file-tree>
        </section>
      `;
      panel = this.querySelector(":scope > .file-list-panel");
    }
    this.patchReadyHeader(directory);
    this.updateTreeModel();
  }

  readyHeader() {
    return this.querySelector(":scope > .file-list-panel > header");
  }

  fileTree() {
    return this.querySelector("caffold-file-tree");
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    refreshActionId = "",
    clipRoots = [],
  } = {}) {
    const tree = this.fileTree();
    if (
      !scopeId ||
      this.hidden ||
      this.state?.status !== "ready" ||
      !tree
    ) {
      return emptyActionHintScope();
    }
    const refresh = this.querySelector(
      ':scope > .file-list-panel > header button[data-action="refresh-files"]',
    );
    const refreshScope = refreshActionId && refresh && !refresh.disabled
      ? {
          targets: [buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:refresh`,
            actionId: refreshActionId,
            label: refresh.getAttribute("aria-label") || "Refresh files",
            control: refresh,
            clipRoots: [this, ...clipRoots],
            isActionable: () =>
              this.isConnected &&
              !this.hidden &&
              this.state?.status === "ready" &&
              this.querySelector(
                ':scope > .file-list-panel > header button[data-action="refresh-files"]',
              ) === refresh &&
              !refresh.disabled,
          })],
          mutationRoots: [this],
          scrollRoots: [],
        }
      : null;
    const treeScope = actionId || disclosureActionId
      ? tree.actionHintScope({
          scopeId,
          actionId,
          disclosureActionId,
          clipRoots: [this, ...clipRoots],
          isCurrent: (node) => node.source?.path === this.selectedPath,
          labelForNode: (node) =>
            node.ariaLabel || `Open ${node.source?.name ?? node.name}`,
        })
      : null;
    return mergeActionHintScopes(refreshScope, treeScope);
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Files",
    clipRoots = [],
  } = {}) {
    const tree = this.fileTree();
    if (
      !scopeId ||
      this.hidden ||
      this.state?.status !== "ready" ||
      !tree
    ) {
      return emptyScrollSurfaceScope();
    }
    return tree.scrollSurfaceScope({
      scopeId,
      label,
      clipRoots: [this, ...clipRoots],
      isCurrent: () =>
        this.isConnected &&
        !this.hidden &&
        this.state?.status === "ready" &&
        this.fileTree() === tree,
    });
  }

  patchReadyHeader(directory) {
    const header = this.readyHeader();
    if (header) {
      header.innerHTML = this.renderReadyHeader(directory);
    }
  }

  renderReadyHeader(directory) {
    return `
      <div class="file-list-title-row">
        <h2>Files</h2>
        <div class="file-list-actions">
          <span class="entry-count">${directory.entries.length} entries</span>
          ${this.renderRefreshButton()}
        </div>
      </div>
      ${this.renderGitSummary(directory.git)}
    `;
  }

  renderRefreshButton() {
    if (this.refreshVisible === false) {
      return "";
    }
    const refreshing = this.refreshState === "refreshing";
    const unavailable = this.refreshState === "unavailable";
    const title = unavailable ? "Live updates unavailable. Refresh manually." : "Refresh files";
    return `
      <button
        type="button"
        class="file-refresh-button${refreshing ? " is-refreshing" : ""}${unavailable ? " is-unavailable" : ""}"
        data-action="refresh-files"
        aria-label="${escapeHtml(title)}"
        title="${escapeHtml(title)}"
      >
        ${renderInlineIcon("RefreshCw", "Refresh files", "file-refresh-icon")}
      </button>
    `;
  }

  patchRefreshButton() {
    const button = this.querySelector(".file-refresh-button");
    if (!button) {
      return;
    }
    const refreshing = this.refreshState === "refreshing";
    const unavailable = this.refreshState === "unavailable";
    const title = unavailable ? "Live updates unavailable. Refresh manually." : "Refresh files";
    button.classList.toggle("is-refreshing", refreshing);
    button.classList.toggle("is-unavailable", unavailable);
    button.setAttribute("aria-label", title);
    button.title = title;
  }

  renderGitSummary(git) {
    if (!git) {
      return "";
    }
    const branch = git.branch ?? "detached";
    const state = git.dirty ? "changes" : "clean";
    return `
      <span
        class="git-summary${git.dirty ? " is-dirty" : ""}"
        title="${escapeHtml(`Git ${branch}, ${state}`)}"
      >
        ${escapeHtml(branch)}${git.dirty ? " *" : ""}
      </span>
    `;
  }

  updateTreeModel() {
    if (this.state?.status !== "ready" || !this.fileTree()) {
      return;
    }
    const { directory } = this.state;
    const { nodes, keyByPath } = directory.git
      ? repositoryTreeNodes(directory, this.treeState)
      : flatDirectoryNodes(directory);
    this.keyByPath = keyByPath;
    const tree = this.fileTree();
    tree.setModel({
      entityKey: directory.git?.rootPath ?? `directory:${directory.path}`,
      nodes,
      selectedKey: keyByPath.get(this.selectedPath) ?? "",
      statusColumn: false,
      expandNewDirectories: false,
    });
    if (this.treeState?.pendingExpandedPaths.size) {
      const keys = [...this.treeState.pendingExpandedPaths].map(fileNodeKey);
      tree.expandKeys(keys);
      for (const path of [...this.treeState.pendingExpandedPaths]) {
        if (tree.hasKey(fileNodeKey(path))) {
          this.treeState.pendingExpandedPaths.delete(path);
        }
      }
    }
  }

  setSelectedPath(path) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(this.keyByPath?.get(this.selectedPath) ?? "");
  }

  async revealPath(path) {
    this.setSelectedPath(path);
    if (this.treeState) {
      const directories = ancestorDirectories(path, this.treeState.rootPath);
      for (const directory of directories) {
        this.treeState.pendingExpandedPaths.add(directory);
        await this.loadTreeDirectory(directory);
      }
      this.updateTreeModel();
    }
    const key = this.keyByPath?.get(path) ?? "";
    this.fileTree()?.setSelectedKey(key);
    return key ? this.fileTree().revealKey(key) : false;
  }

  prepareTreeState(directory) {
    if (!directory.git) {
      this.resetTreeState();
      return;
    }
    const rootPath = directory.git.rootPath;
    if (!this.treeState || this.treeState.rootPath !== rootPath) {
      this.resetTreeState();
      this.treeState = {
        rootPath,
        cache: new Map(),
        loading: new Set(),
        errors: new Map(),
        timers: new Map(),
        requests: new Map(),
        pendingExpandedPaths: new Set(),
      };
    }
    this.treeState.cache.set(directory.path, directory);
    for (const path of ancestorDirectories(`${directory.path}/__current__`, rootPath)) {
      this.treeState.pendingExpandedPaths.add(path);
    }
    if (!this.treeState.cache.has(rootPath)) {
      void this.loadTreeDirectory(rootPath);
    }
  }

  async loadTreeDirectory(path) {
    const treeState = this.treeState;
    if (!treeState || treeState.requests.has(path) || treeState.cache.has(path)) {
      return;
    }
    const requestId = Symbol(path);
    treeState.requests.set(path, requestId);
    treeState.timers.set(
      path,
      window.setTimeout(() => {
        if (this.treeState?.requests.get(path) === requestId) {
          this.treeState.loading.add(path);
          this.updateTreeModel();
        }
      }, TREE_LOADING_DELAY_MS),
    );
    try {
      const directory = await listDirectory(path);
      if (this.treeState?.requests.get(path) !== requestId) {
        return;
      }
      this.treeState.cache.set(path, directory);
      this.treeState.errors.delete(path);
    } catch (error) {
      if (this.treeState?.requests.get(path) !== requestId) {
        return;
      }
      this.treeState.errors.set(path, error);
    } finally {
      if (this.treeState?.requests.get(path) === requestId) {
        window.clearTimeout(this.treeState.timers.get(path));
        this.treeState.timers.delete(path);
        this.treeState.requests.delete(path);
        this.treeState.loading.delete(path);
        this.updateTreeModel();
      }
    }
  }

  entryForPath(path) {
    if (!path) {
      return null;
    }
    const currentEntry = this.state?.directory?.entries.find((entry) => entry.path === path);
    if (currentEntry) {
      return currentEntry;
    }
    for (const directory of this.treeState?.cache.values() ?? []) {
      const entry = directory.entries.find((candidate) => candidate.path === path);
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  resetTreeState() {
    this.clearTreeLoadingTimers();
    this.treeState = null;
  }

  clearTreeLoadingTimers() {
    for (const timer of this.treeState?.timers.values() ?? []) {
      window.clearTimeout(timer);
    }
  }
}

customElements.define("caffold-file-list", CaffoldFileList);

function repositoryTreeNodes(directory, treeState) {
  const keyByPath = new Map();
  const nodes = parentNode(directory.path);
  const rootDirectory = treeState?.cache.get(treeState.rootPath);
  if (rootDirectory) {
    nodes.push(...directoryEntryNodes(rootDirectory, treeState, keyByPath, true));
  } else {
    const error = treeState?.errors.get(treeState.rootPath);
    nodes.push({
      key: "files:repository-state",
      kind: "status",
      name: error?.message ?? "Loading repository...",
      tone: error ? "error" : "muted",
    });
  }
  addParentKey(nodes, keyByPath);
  return { nodes, keyByPath };
}

function flatDirectoryNodes(directory) {
  const keyByPath = new Map();
  const nodes = [
    ...parentNode(directory.path),
    ...directory.entries.map((entry) => entryNode(entry, null, keyByPath, false)),
  ];
  addParentKey(nodes, keyByPath);
  return { nodes, keyByPath };
}

function directoryEntryNodes(directory, treeState, keyByPath, lazy) {
  return directory.entries.map((entry) => entryNode(entry, treeState, keyByPath, lazy));
}

function entryNode(entry, treeState, keyByPath, lazy) {
  const key = fileNodeKey(entry.path);
  if (!keyByPath.has(entry.path)) {
    keyByPath.set(entry.path, key);
  }
  const ignoredLabel = entry.gitIgnored ? " ignored by Git" : "";
  const node = {
    key,
    kind: entry.kind,
    name: entry.name,
    path: entry.path,
    isSymlink: Boolean(entry.isSymlink),
    git: entry.git,
    supported: entry.supported !== false,
    disabled: entry.supported === false,
    hidden: isHiddenEntry(entry),
    ignored: Boolean(entry.gitIgnored),
    title: titleForEntry(entry),
    ariaLabel: `${entry.name} ${entryKindLabel(entry)}${ignoredLabel}`,
    source: entry,
  };
  if (lazy && isExpandableDirectory(entry)) {
    node.children = childrenForDirectory(entry.path, treeState, keyByPath);
  }
  return node;
}

function childrenForDirectory(path, treeState, keyByPath) {
  const directory = treeState.cache.get(path);
  if (directory) {
    return readyFileTreeChildren(directoryEntryNodes(directory, treeState, keyByPath, true));
  }
  if (treeState.loading.has(path)) {
    return loadingFileTreeChildren();
  }
  const error = treeState.errors.get(path);
  if (error) {
    return errorFileTreeChildren(error.message);
  }
  return unloadedFileTreeChildren();
}

function parentNode(path) {
  if (!path) {
    return [];
  }
  const parentPath = parentDirectory(path);
  return [{
    key: `files:parent:${path}`,
    kind: "directory",
    name: "..",
    path: parentPath,
    variant: "parent",
    selection: false,
    title: "Go to parent directory",
    ariaLabel: "Parent directory",
    source: {
      name: "..",
      path: parentPath,
      kind: "directory",
      isSymlink: false,
      supported: true,
    },
  }];
}

function addParentKey(nodes, keyByPath) {
  const parent = nodes.find((node) => node.variant === "parent");
  if (parent && !keyByPath.has(parent.path)) {
    keyByPath.set(parent.path, parent.key);
  }
}

function fileNodeKey(path) {
  return `files:entry:${path}`;
}

function parentDirectory(path) {
  const parts = `${path ?? ""}`.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isHiddenEntry(entry) {
  return entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..";
}

function titleForEntry(entry) {
  if (!entry.supported) {
    return "This path resolves outside the root";
  }
  if (entry.gitIgnored) {
    return "Ignored by Git";
  }
  return "";
}

function isExpandableDirectory(entry) {
  return entry.kind === "directory" && entry.supported;
}

function ancestorDirectories(path, rootPath) {
  const root = `${rootPath ?? ""}`.split("/").filter(Boolean);
  const parent = parentDirectory(path).split("/").filter(Boolean);
  if (!root.every((segment, index) => parent[index] === segment)) {
    return [];
  }
  const directories = [];
  for (let length = root.length; length <= parent.length; length += 1) {
    directories.push(parent.slice(0, length).join("/"));
  }
  return directories.filter(Boolean);
}

function sameDirectoryPresentation(left, right) {
  if (
    !left ||
    !right ||
    left.path !== right.path ||
    left.git?.rootPath !== right.git?.rootPath ||
    left.git?.branch !== right.git?.branch ||
    Boolean(left.git?.dirty) !== Boolean(right.git?.dirty) ||
    left.entries.length !== right.entries.length
  ) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      entry.name === other.name &&
      entry.path === other.path &&
      entry.kind === other.kind &&
      Boolean(entry.isSymlink) === Boolean(other.isSymlink) &&
      Boolean(entry.supported) === Boolean(other.supported) &&
      Boolean(entry.gitIgnored) === Boolean(other.gitIgnored)
    );
  });
}
