import { html, LitElement } from "lit";
import type { ActionHintPull } from "../action-hints.ts";
import { type DirectoryListing, listDirectory } from "../api.ts";
import type { ScrollSurfacePull } from "../scroll-scope.ts";
import {
  createRefreshCoordinator,
  type RefreshCoordinator,
  type RefreshState,
  subscribeToWatch,
  type WatchChange,
} from "../watch.ts";
import "./file-navigator/components/list.ts";
import { DrawnRef, drawn } from "./drawn-refs.ts";
import type {
  CaffoldFileList,
  RefreshButtonState,
} from "./file-navigator/components/list.ts";

const LOADING_DELAY_MS = 180;

interface PendingRefresh {
  allDirectories: boolean;
  selected: boolean;
  paths: Set<string>;
  revision: unknown;
}

export type ResolvedPath =
  | { kind: "file"; directory: DirectoryListing | null; entry: unknown }
  | { kind: "directory"; directory: DirectoryListing }
  | { kind: "stale"; directory: null }
  | { kind: "error"; directory: DirectoryListing | false | null };

export class CaffoldFileNavigator extends LitElement {
  private readonly list = new DrawnRef<CaffoldFileList>(this);
  private currentPath = "";
  private directoryRequestId = 0;
  private refreshGeneration = 0;
  private loadedDirectoryPath: string | null = null;
  private selectedPath = "";
  private storageKey: string | null = null;
  private watchActive = true;
  private liveUpdates: unknown = null;
  private watchScopePath: string | undefined;
  private watchUnsubscribe: (() => void) | null = null;
  private watchUnavailable = false;
  private pendingRefresh = createPendingRefresh();
  private readonly refreshCoordinator: RefreshCoordinator =
    createRefreshCoordinator(
      () => this.performPendingRefresh(),
      (state) => this.setRefreshState(state),
    );

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.watchActive && this.watchScopePath !== undefined) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.directoryRequestId += 1;
    this.refreshGeneration += 1;
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
  }

  render() {
    return html`<caffold-file-list
      ${drawn(this.list)}
      @caffold:open-directory=${this.openDirectory}
      @caffold:open-file=${this.openFile}
      @caffold:refresh-file-list=${this.refreshFileList}
    ></caffold-file-list>`;
  }

  async loadDirectory(
    path: string | null | undefined,
    options: { fallbackPath?: string; allowFailure?: boolean } = {},
  ): Promise<DirectoryListing | false | null> {
    const fileList = this.fileList;
    const requestId = ++this.directoryRequestId;
    this.currentPath = path ?? "";
    this.clearSelectedPath();
    const loadingTimer = this.showDirectoryLoadingAfterDelay(requestId);

    try {
      const directory = await listDirectory(this.currentPath);
      if (requestId !== this.directoryRequestId) {
        return null;
      }

      this.currentPath = directory.path;
      this.loadedDirectoryPath = directory.path;
      fileList.setDirectory(directory);
      this.setWatchScope(directory.git?.rootPath ?? directory.path);
      this.storeDirectoryPath(directory.path);
      return directory;
    } catch (error) {
      if (requestId !== this.directoryRequestId) {
        return null;
      }
      if (
        options.fallbackPath !== undefined &&
        this.currentPath !== options.fallbackPath
      ) {
        this.clearStoredDirectoryPath();
        const { fallbackPath, ...nextOptions } = options;
        return this.loadDirectory(fallbackPath, nextOptions);
      }
      if (options.allowFailure) {
        return false;
      }
      fileList.setError(error as Error);
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async resolvePath(
    path: string | null | undefined,
    options: { fallbackPath?: string } = {},
  ): Promise<ResolvedPath> {
    const targetPath = path ?? "";
    const loadedEntry = this.entryForPath(targetPath);
    if (loadedEntry && loadedEntry.kind !== "directory") {
      return { kind: "file", directory: null, entry: loadedEntry };
    }

    const directory = await this.loadDirectory(targetPath, {
      allowFailure: true,
    });
    if (directory) {
      return { kind: "directory", directory };
    }
    if (directory === null) {
      return { kind: "stale", directory: null };
    }

    const parentDirectory = await this.loadDirectory(parentPath(targetPath), {
      fallbackPath: options.fallbackPath ?? "",
    });
    return parentDirectory
      ? {
          kind: "file",
          directory: parentDirectory,
          entry: this.entryForPath(targetPath),
        }
      : { kind: "error", directory: parentDirectory };
  }

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.fileList.setSelectedPath(this.selectedPath);
  }

  clearSelectedPath() {
    this.setSelectedPath("");
  }

  async revealPath(path: string) {
    this.setSelectedPath(path);
    await this.fileList.revealPath(path);
  }

  captureScroll() {
    return this.fileList.captureScroll();
  }

  restoreScroll(scroll: { top: number; left: number } | null | undefined) {
    this.fileList.restoreScroll(scroll);
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.fileList.actionHintScope({
      ...pull,
      clipRoots: [this, ...(pull.clipRoots ?? [])],
    });
  }

  scrollSurfaceScope({ label = "Files", ...pull }: ScrollSurfacePull = {}) {
    return this.fileList.scrollSurfaceScope({
      ...pull,
      label,
      clipRoots: [this, ...(pull.clipRoots ?? [])],
    });
  }

  entryForPath(path: string | null | undefined) {
    return this.fileList.entryForPath(path);
  }

  hasLoadedDirectory(path: string | null | undefined) {
    return this.loadedDirectoryPath === (path ?? "");
  }

  setStorageKey(key: string | null | undefined) {
    this.storageKey = key ?? null;
  }

  setRefreshVisible(visible: boolean) {
    this.fileList.setRefreshVisible(visible);
  }

  setError(error: Error) {
    this.loadedDirectoryPath = null;
    this.fileList.setError(error);
  }

  setLiveUpdates(liveUpdates: unknown) {
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.liveUpdates = liveUpdates ?? null;
    if (
      this.isConnected &&
      this.watchActive &&
      this.watchScopePath !== undefined
    ) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  setWatchActive(active: boolean) {
    const nextActive = Boolean(active);
    if (this.watchActive === nextActive) {
      return;
    }
    this.watchActive = nextActive;
    if (!nextActive) {
      this.watchUnsubscribe?.();
      this.watchUnsubscribe = null;
      this.watchUnavailable = false;
      this.setRefreshState("idle");
      return;
    }
    if (this.isConnected && this.watchScopePath !== undefined) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  requestRefresh(
    options: {
      allDirectories?: boolean;
      selected?: boolean;
      revision?: unknown;
      paths?: string[];
    } = {},
  ) {
    this.pendingRefresh.allDirectories ||= Boolean(options.allDirectories);
    this.pendingRefresh.selected ||= Boolean(options.selected);
    this.pendingRefresh.revision =
      options.revision ?? this.pendingRefresh.revision;
    for (const path of options.paths ?? []) {
      this.pendingRefresh.paths.add(path);
    }
    return this.refreshCoordinator.request();
  }

  // The list is drawn the first time it is needed, which can be before the
  // navigator is in the document.
  private get fileList() {
    this.performUpdate();
    return this.list.value as CaffoldFileList;
  }

  private usesExternalNavigation() {
    return this.hasAttribute("external-navigation");
  }

  private openDirectory(event: CustomEvent<{ path?: string }>) {
    if (this.usesExternalNavigation()) {
      return;
    }
    event.stopPropagation();
    void this.loadDirectory(event.detail?.path ?? "");
  }

  private openFile(event: CustomEvent<{ path?: string; entry?: unknown }>) {
    if (this.usesExternalNavigation()) {
      return;
    }
    event.stopPropagation();
    const path = event.detail?.path ?? "";
    this.setSelectedPath(path);
    this.dispatchEvent(
      new CustomEvent("caffold:file-navigator-open-file", {
        bubbles: true,
        detail: { path, entry: event.detail?.entry ?? null },
      }),
    );
  }

  private refreshFileList(event: Event) {
    event.stopPropagation();
    void this.requestRefresh({ allDirectories: true });
  }

  private setWatchScope(path: string | null | undefined) {
    const nextPath = path ?? "";
    if (this.watchScopePath === nextPath && this.watchUnsubscribe) {
      return;
    }
    this.watchScopePath = nextPath;
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchUnavailable = false;
    this.setRefreshState("idle");
    if (this.isConnected && this.watchActive) {
      this.subscribeWatchScope(nextPath);
    }
  }

  private subscribeWatchScope(path: string) {
    if (this.watchUnsubscribe) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(this.liveUpdates, path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          void this.requestRefresh({ allDirectories: true, selected: true });
        }
      },
      onChange: (change) => this.handleWatchChange(change),
      onRecover: () =>
        void this.requestRefresh({ allDirectories: true, selected: true }),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  private handleWatchChange(change: WatchChange) {
    const paths = Array.isArray(change.paths) ? change.paths : [];
    void this.requestRefresh({
      paths,
      allDirectories: Boolean(change.overflow),
      selected: Boolean(
        this.selectedPath &&
          (change.overflow || paths.includes(this.selectedPath)),
      ),
      revision: change.revision,
    });
  }

  private async performPendingRefresh() {
    const generation = this.refreshGeneration;
    const pending = this.pendingRefresh;
    this.pendingRefresh = createPendingRefresh();
    await this.refreshDirectories(pending, generation);
    if (!this.acceptRefresh(generation)) {
      return;
    }
    if (pending.selected && this.selectedPath) {
      this.dispatchEvent(
        new CustomEvent("caffold:file-navigator-refresh-selected", {
          bubbles: true,
          detail: {
            path: this.selectedPath,
            entry: this.entryForPath(this.selectedPath),
            revision: pending.revision,
          },
        }),
      );
    }
  }

  private async refreshDirectories(
    pending: PendingRefresh,
    generation = this.refreshGeneration,
  ) {
    const cachedPaths = this.fileList.cachedDirectoryPaths();
    const targets = new Set<string>();
    if (pending.allDirectories) {
      for (const path of cachedPaths) {
        targets.add(path);
      }
    } else {
      for (const changedPath of pending.paths) {
        const parent = parentPath(changedPath);
        if (cachedPaths.includes(parent)) {
          targets.add(parent);
        }
        if (cachedPaths.includes(changedPath)) {
          targets.add(changedPath);
        }
      }
    }
    if (targets.size === 0) {
      return;
    }

    const directories: DirectoryListing[] = [];
    const paths = Array.from(targets);
    for (let index = 0; index < paths.length; index += 4) {
      const batch = paths.slice(index, index + 4);
      const results = await Promise.allSettled(
        batch.map((path) => listDirectory(path)),
      );
      if (!this.acceptRefresh(generation)) {
        return;
      }
      results.forEach((result, offset) => {
        if (result.status === "fulfilled") {
          directories.push(result.value);
        } else if (batch[offset] === this.loadedDirectoryPath) {
          this.fileList.setError(result.reason);
        }
      });
    }
    this.fileList.updateDirectories(directories);
  }

  private acceptRefresh(generation: number) {
    return this.isConnected && generation === this.refreshGeneration;
  }

  private setRefreshState(state: RefreshState | RefreshButtonState) {
    const nextState: RefreshButtonState =
      state === "refreshing"
        ? "refreshing"
        : this.watchUnavailable
          ? "unavailable"
          : "idle";
    this.fileList.setRefreshState(nextState);
    this.dispatchEvent(
      new CustomEvent("caffold:file-navigator-refresh-state", {
        bubbles: true,
        detail: { state: nextState },
      }),
    );
  }

  private showDirectoryLoadingAfterDelay(requestId: number) {
    return window.setTimeout(() => {
      if (requestId === this.directoryRequestId) {
        this.fileList.setLoading();
      }
    }, LOADING_DELAY_MS);
  }

  private storeDirectoryPath(path: string) {
    if (!this.storageKey) {
      return;
    }
    try {
      window.localStorage.setItem(this.storageKey, path);
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
  }

  private clearStoredDirectoryPath() {
    if (!this.storageKey) {
      return;
    }
    try {
      window.localStorage.removeItem(this.storageKey);
    } catch {
      // The caller can always fall back to the server initial path.
    }
  }
}

customElements.define("caffold-file-navigator", CaffoldFileNavigator);

function parentPath(path: string) {
  const parts = cleanPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function cleanPath(path: string) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function createPendingRefresh(): PendingRefresh {
  return {
    allDirectories: false,
    selected: false,
    paths: new Set(),
    revision: null,
  };
}
