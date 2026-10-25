import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import {
  type DirectoryEntry,
  type DirectoryListing,
  listDirectory,
} from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import { entryKindLabel } from "../../dom.ts";
import {
  type CaffoldFileTree,
  errorFileTreeChildren,
  type FileTreeChildren,
  type FileTreeNode,
  type FileTreeSelectDetail,
  loadingFileTreeChildren,
  readyFileTreeChildren,
  unloadedFileTreeChildren,
} from "../../file-tree.ts";
import { inlineIcon, warmIcons } from "../../icons.ts";
import "../../loading-text.ts";

const TREE_LOADING_DELAY_MS = 180;

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; directory: DirectoryListing };

export type RefreshButtonState = "idle" | "refreshing" | "unavailable";

// The directories of the repository the listed directory belongs to, read as
// the tree opens them.
interface TreeState {
  rootPath: string;
  cache: Map<string, DirectoryListing>;
  loading: Set<string>;
  errors: Map<string, Error>;
  timers: Map<string, number>;
  requests: Map<string, symbol>;
  pendingExpandedPaths: Set<string>;
}

export class CaffoldFileList extends LitElement {
  static properties = {
    state: { state: true },
    refreshState: { state: true },
    refreshVisible: { state: true },
  };

  declare private state: ListState;
  declare private refreshState: RefreshButtonState;
  declare private refreshVisible: boolean;
  private selectedPath = "";
  private keyByPath = new Map<string, string>();
  private treeState: TreeState | null = null;
  // The tree is handed its model again once the list it shows is drawn, and a
  // directory shown anew starts at its top.
  private modelPending = false;
  private scrollToTop = false;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.state = { status: "idle" };
    this.refreshState = "idle";
    this.refreshVisible = true;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.clearTreeLoadingTimers();
  }

  render() {
    const state = this.state;
    const tree = html`<caffold-file-tree
      @caffold:file-tree-select=${this.openTreeEntry}
      @caffold:file-tree-load-children=${this.loadTreeChildren}
    ></caffold-file-tree>`;
    if (state.status !== "ready") {
      const panelClass =
        state.status === "error"
          ? "file-list-panel error-panel"
          : "file-list-panel";
      const message =
        state.status === "loading"
          ? html`<caffold-loading-text>Loading files...</caffold-loading-text>`
          : state.status === "error"
            ? state.error.message
            : "";
      return html`
        <section
          class=${panelClass}
          aria-busy=${state.status === "loading" ? "true" : nothing}
        >
          <header><h2>Files</h2></header>
          ${message ? html`<p class="surface-message">${message}</p>` : tree}
        </section>
      `;
    }

    const { directory } = state;
    const git = directory.git;
    const branch = git?.branch ?? "detached";
    const entryCount = `${directory.entries.length} entries`;
    const refreshClass = {
      idle: "file-refresh-button",
      refreshing: "file-refresh-button is-refreshing",
      unavailable: "file-refresh-button is-unavailable",
    }[this.refreshState];
    const refreshTitle =
      this.refreshState === "unavailable"
        ? "Live updates unavailable. Refresh manually."
        : "Refresh files";
    const refreshIcon = inlineIcon(
      "RefreshCw",
      "Refresh files",
      "file-refresh-icon",
    );
    return html`
      <section class="file-list-panel" data-content="ready">
        <header>
          <div class="file-list-title-row">
            <h2>Files</h2>
            <div class="file-list-actions">
              <span class="entry-count">${entryCount}</span>
              ${
                this.refreshVisible
                  ? html`
                      <button
                        type="button"
                        class=${refreshClass}
                        data-action="refresh-files"
                        aria-label=${refreshTitle}
                        title=${refreshTitle}
                        @click=${this.requestRefresh}
                      >
                        ${refreshIcon}
                      </button>
                    `
                  : nothing
              }
            </div>
          </div>
          ${
            git
              ? html`
                  <span
                    class="git-summary${git.dirty ? " is-dirty" : ""}"
                    title=${`Git ${branch}, ${git.dirty ? "changes" : "clean"}`}
                  >
                    ${branch}${git.dirty ? " *" : ""}
                  </span>
                `
              : nothing
          }
        </header>
        ${tree}
      </section>
    `;
  }

  updated() {
    if (!this.modelPending) {
      return;
    }
    this.modelPending = false;
    this.updateTreeModel();
    const scroller = this.scrollToTop ? this.fileTree()?.scroller() : null;
    this.scrollToTop = false;
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
    }
  }

  setLoading() {
    this.resetTreeState();
    this.state = { status: "loading" };
  }

  setIdle() {
    this.resetTreeState();
    this.state = { status: "idle" };
  }

  setDirectory(directory: DirectoryListing) {
    this.prepareTreeState(directory);
    this.state = { status: "ready", directory };
    this.modelPending = true;
    this.scrollToTop = true;
  }

  updateDirectories(directories: DirectoryListing[]) {
    if (!directories.length || this.state.status !== "ready") {
      return;
    }
    const currentPath = this.state.directory.path;
    const current = directories.find(
      (directory) => directory.path === currentPath,
    );
    let changed = false;
    if (current) {
      changed ||= !sameDirectoryPresentation(this.state.directory, current);
      this.prepareTreeState(current);
      this.state = { status: "ready", directory: current };
    }
    if (this.treeState) {
      for (const directory of directories) {
        changed ||= !sameDirectoryPresentation(
          this.treeState.cache.get(directory.path),
          directory,
        );
        this.treeState.cache.set(directory.path, directory);
      }
    }
    if (changed) {
      this.modelPending = true;
      this.requestUpdate();
    }
  }

  cachedDirectoryPaths() {
    if (this.treeState) {
      return Array.from(this.treeState.cache.keys());
    }
    return this.state.status === "ready" ? [this.state.directory.path] : [];
  }

  hasCachedDirectory(path: string) {
    return this.cachedDirectoryPaths().includes(path);
  }

  setRefreshState(state: RefreshButtonState) {
    this.refreshState = state;
  }

  setRefreshVisible(visible: boolean) {
    this.refreshVisible = visible;
  }

  setError(error: Error) {
    this.resetTreeState();
    this.state = { status: "error", error };
  }

  fileTree() {
    return this.querySelector<CaffoldFileTree>("caffold-file-tree");
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    refreshActionId = "",
    clipRoots = [],
  }: ActionHintScopeOptions & {
    disclosureActionId?: string;
    refreshActionId?: string;
  } = {}): ActionHintScope {
    const tree = this.fileTree();
    if (!scopeId || this.hidden || this.state?.status !== "ready" || !tree) {
      return emptyActionHintScope();
    }
    const refresh = this.querySelector<HTMLButtonElement>(
      ':scope > .file-list-panel > header button[data-action="refresh-files"]',
    );
    const refreshScope =
      refreshActionId && refresh && !refresh.disabled
        ? {
            blocked: false,
            targets: [
              buttonActionHintTarget({
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
              }),
            ],
            mutationRoots: [this],
            scrollRoots: [],
          }
        : null;
    const treeScope =
      actionId || disclosureActionId
        ? tree.actionHintScope({
            scopeId,
            actionId,
            disclosureActionId,
            clipRoots: [this, ...clipRoots],
            isCurrent: (node) => listedEntry(node)?.path === this.selectedPath,
            includeDirectories: true,
            labelForNode: (node) =>
              node.ariaLabel || `Open ${listedEntry(node)?.name ?? node.name}`,
          })
        : null;
    return mergeActionHintScopes(refreshScope, treeScope);
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Files",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const tree = this.fileTree();
    if (!scopeId || this.hidden || this.state?.status !== "ready" || !tree) {
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

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(
      this.keyByPath.get(this.selectedPath) ?? "",
    );
  }

  async revealPath(path: string) {
    this.setSelectedPath(path);
    await this.updateComplete;
    if (this.treeState) {
      const directories = ancestorDirectories(path, this.treeState.rootPath);
      for (const directory of directories) {
        this.treeState.pendingExpandedPaths.add(directory);
        await this.loadTreeDirectory(directory);
      }
      this.updateTreeModel();
    }
    const key = this.keyByPath.get(path) ?? "";
    const tree = this.fileTree();
    tree?.setSelectedKey(key);
    return key && tree ? tree.revealKey(key) : false;
  }

  entryForPath(path: string | null | undefined) {
    if (!path) {
      return null;
    }
    const currentEntry =
      this.state.status === "ready"
        ? this.state.directory.entries.find((entry) => entry.path === path)
        : undefined;
    if (currentEntry) {
      return currentEntry;
    }
    for (const directory of this.treeState?.cache.values() ?? []) {
      const entry = directory.entries.find(
        (candidate) => candidate.path === path,
      );
      if (entry) {
        return entry;
      }
    }
    return null;
  }

  private requestRefresh() {
    this.dispatchEvent(
      new CustomEvent("caffold:refresh-file-list", { bubbles: true }),
    );
  }

  private openTreeEntry(event: CustomEvent<FileTreeSelectDetail>) {
    event.stopPropagation();
    const entry = listedEntry(event.detail.node);
    if (!entry) {
      return;
    }
    const eventName =
      entry.kind === "directory"
        ? "caffold:open-directory"
        : "caffold:open-file";
    this.dispatchEvent(
      new CustomEvent(eventName, {
        bubbles: true,
        detail: {
          path: entry.path,
          entry: this.entryForPath(entry.path) ?? entry,
        },
      }),
    );
  }

  private loadTreeChildren(event: CustomEvent<{ path: string }>) {
    event.stopPropagation();
    const path = event.detail.path;
    this.treeState?.errors.delete(path);
    this.updateTreeModel();
    void this.loadTreeDirectory(path);
  }

  private updateTreeModel() {
    const tree = this.fileTree();
    if (this.state.status !== "ready" || !tree) {
      return;
    }
    const { directory } = this.state;
    const { nodes, keyByPath } = directory.git
      ? repositoryTreeNodes(directory, this.treeState)
      : flatDirectoryNodes(directory);
    this.keyByPath = keyByPath;
    tree.setModel({
      entityKey: directory.git?.rootPath ?? `directory:${directory.path}`,
      nodes,
      selectedKey: keyByPath.get(this.selectedPath) ?? "",
      statusColumn: false,
      expandNewDirectories: false,
    });
    const pending = this.treeState?.pendingExpandedPaths;
    if (pending?.size) {
      tree.expandKeys([...pending].map(fileNodeKey));
      for (const path of [...pending]) {
        if (tree.hasKey(fileNodeKey(path))) {
          pending.delete(path);
        }
      }
    }
  }

  private prepareTreeState(directory: DirectoryListing) {
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
    for (const path of ancestorDirectories(
      `${directory.path}/__current__`,
      rootPath,
    )) {
      this.treeState.pendingExpandedPaths.add(path);
    }
    if (!this.treeState.cache.has(rootPath)) {
      void this.loadTreeDirectory(rootPath);
    }
  }

  private async loadTreeDirectory(path: string) {
    const treeState = this.treeState;
    if (
      !treeState ||
      treeState.requests.has(path) ||
      treeState.cache.has(path)
    ) {
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
      this.treeState.errors.set(path, error as Error);
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

  private resetTreeState() {
    this.clearTreeLoadingTimers();
    this.treeState = null;
  }

  private clearTreeLoadingTimers() {
    for (const timer of this.treeState?.timers.values() ?? []) {
      window.clearTimeout(timer);
    }
  }
}

await compactIconButton.register(
  "caffold-file-list",
  "> .file-list-panel > header > .file-list-title-row > .file-list-actions > .file-refresh-button",
);

customElements.define("caffold-file-list", CaffoldFileList);

function listedEntry(node: FileTreeNode) {
  return node.source as DirectoryEntry | undefined;
}

function repositoryTreeNodes(
  directory: DirectoryListing,
  treeState: TreeState | null,
) {
  const keyByPath = new Map<string, string>();
  const nodes = parentNode(directory.path);
  const rootDirectory = treeState?.cache.get(treeState.rootPath);
  if (rootDirectory && treeState) {
    nodes.push(
      ...directoryEntryNodes(rootDirectory, treeState, keyByPath, true),
    );
  } else if (treeState) {
    const error = treeState.errors.get(treeState.rootPath);
    if (error || treeState.loading.has(treeState.rootPath)) {
      nodes.push({
        key: "files:repository-state",
        kind: "status",
        name: error?.message ?? "Loading repository...",
        tone: error ? "error" : "muted",
        loading: !error,
      });
    }
  }
  addParentKey(nodes, keyByPath);
  return { nodes, keyByPath };
}

function flatDirectoryNodes(directory: DirectoryListing) {
  const keyByPath = new Map<string, string>();
  const nodes = [
    ...parentNode(directory.path),
    ...directory.entries.map((entry) =>
      entryNode(entry, null, keyByPath, false),
    ),
  ];
  addParentKey(nodes, keyByPath);
  return { nodes, keyByPath };
}

function directoryEntryNodes(
  directory: DirectoryListing,
  treeState: TreeState,
  keyByPath: Map<string, string>,
  lazy: boolean,
) {
  return directory.entries.map((entry) =>
    entryNode(entry, treeState, keyByPath, lazy),
  );
}

function entryNode(
  entry: DirectoryEntry,
  treeState: TreeState | null,
  keyByPath: Map<string, string>,
  lazy: boolean,
) {
  const key = fileNodeKey(entry.path);
  if (!keyByPath.has(entry.path)) {
    keyByPath.set(entry.path, key);
  }
  const ignoredLabel = entry.gitIgnored ? " ignored by Git" : "";
  const node: FileTreeNode = {
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
  if (lazy && treeState && isExpandableDirectory(entry)) {
    node.children = childrenForDirectory(entry.path, treeState, keyByPath);
  }
  return node;
}

function childrenForDirectory(
  path: string,
  treeState: TreeState,
  keyByPath: Map<string, string>,
): FileTreeChildren {
  const directory = treeState.cache.get(path);
  if (directory) {
    return readyFileTreeChildren(
      directoryEntryNodes(directory, treeState, keyByPath, true),
    );
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

function parentNode(path: string): FileTreeNode[] {
  if (!path) {
    return [];
  }
  const parentPath = parentDirectory(path);
  return [
    {
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
    },
  ];
}

function addParentKey(nodes: FileTreeNode[], keyByPath: Map<string, string>) {
  const parent = nodes.find((node) => node.variant === "parent");
  if (parent?.path !== undefined && !keyByPath.has(parent.path)) {
    keyByPath.set(parent.path, parent.key);
  }
}

function fileNodeKey(path: string) {
  return `files:entry:${path}`;
}

function parentDirectory(path: string) {
  const parts = `${path ?? ""}`.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isHiddenEntry(entry: DirectoryEntry) {
  return (
    entry.name.startsWith(".") && entry.name !== "." && entry.name !== ".."
  );
}

function titleForEntry(entry: DirectoryEntry) {
  if (!entry.supported) {
    return "This path resolves outside the root";
  }
  if (entry.gitIgnored) {
    return "Ignored by Git";
  }
  return "";
}

function isExpandableDirectory(entry: DirectoryEntry) {
  return entry.kind === "directory" && entry.supported;
}

function ancestorDirectories(path: string, rootPath: string) {
  const root = `${rootPath ?? ""}`.split("/").filter(Boolean);
  const parent = parentDirectory(path).split("/").filter(Boolean);
  if (!root.every((segment, index) => parent[index] === segment)) {
    return [];
  }
  const directories: string[] = [];
  for (let length = root.length; length <= parent.length; length += 1) {
    directories.push(parent.slice(0, length).join("/"));
  }
  return directories.filter(Boolean);
}

function sameDirectoryPresentation(
  left: DirectoryListing | undefined,
  right: DirectoryListing | undefined,
) {
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
