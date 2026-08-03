import { listDirectory } from "../api.js";
import { createRefreshCoordinator, subscribeToWatch } from "../watch.js";
import "./file-browser/list.js";

const LOADING_DELAY_MS = 180;

class CaffoldFileNavigator extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.watchActive && this.watchScopePath !== undefined) {
      this.subscribeWatchScope(this.watchScopePath);
    }
  }

  disconnectedCallback() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.currentPath ??= "";
    this.directoryRequestId ??= 0;
    this.loadedDirectoryPath ??= null;
    this.selectedPath ??= "";
    this.storageKey ??= null;
    this.watchActive ??= true;
    this.watchUnavailable = false;
    this.pendingRefresh = createPendingRefresh();
    this.innerHTML = `<caffold-file-list></caffold-file-list>`;
    this.fileList = this.querySelector("caffold-file-list");
    this.refreshCoordinator = createRefreshCoordinator(
      () => this.performPendingRefresh(),
      (state) => this.setRefreshState(state),
    );

    this.addEventListener("caffold:open-directory", (event) => {
      if (this.usesExternalNavigation()) {
        return;
      }
      event.stopPropagation();
      void this.loadDirectory(event.detail?.path ?? "");
    });
    this.addEventListener("caffold:open-file", (event) => {
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
    });
    this.addEventListener("caffold:refresh-file-list", (event) => {
      event.stopPropagation();
      this.requestRefresh({ allDirectories: true });
    });
  }

  usesExternalNavigation() {
    return this.hasAttribute("external-navigation");
  }

  async loadDirectory(path, options = {}) {
    this.ensureRendered();
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
      this.fileList.setDirectory(directory);
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
        const { fallbackPath: _fallbackPath, ...nextOptions } = options;
        return this.loadDirectory(options.fallbackPath, nextOptions);
      }
      if (options.allowFailure) {
        return false;
      }
      this.fileList.setError(error);
      return false;
    } finally {
      window.clearTimeout(loadingTimer);
    }
  }

  async resolvePath(path, options = {}) {
    this.ensureRendered();
    const targetPath = path ?? "";
    const loadedEntry = this.entryForPath(targetPath);
    if (loadedEntry && loadedEntry.kind !== "directory") {
      return { kind: "file", directory: null, entry: loadedEntry };
    }

    const directory = await this.loadDirectory(targetPath, { allowFailure: true });
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

  setSelectedPath(path) {
    this.ensureRendered();
    this.selectedPath = path ?? "";
    this.fileList.setSelectedPath(this.selectedPath);
  }

  clearSelectedPath() {
    this.setSelectedPath("");
  }

  async revealPath(path) {
    this.ensureRendered();
    this.setSelectedPath(path);
    await this.fileList.revealPath?.(path);
  }

  captureScroll() {
    const scroller = this.fileList?.querySelector(".file-list");
    return scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
  }

  restoreScroll(scroll) {
    if (!scroll) {
      return;
    }
    window.requestAnimationFrame(() => {
      const scroller = this.fileList?.querySelector(".file-list");
      if (scroller) {
        scroller.scrollTop = scroll.top;
        scroller.scrollLeft = scroll.left;
      }
    });
  }

  entryForPath(path) {
    this.ensureRendered();
    return this.fileList.entryForPath(path);
  }

  hasLoadedDirectory(path) {
    return this.loadedDirectoryPath === (path ?? "");
  }

  setStorageKey(key) {
    this.storageKey = key ?? null;
  }

  setError(error) {
    this.ensureRendered();
    this.loadedDirectoryPath = null;
    this.fileList.setError(error);
  }

  setWatchScope(path) {
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

  setWatchActive(active) {
    this.ensureRendered();
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

  subscribeWatchScope(path) {
    if (this.watchUnsubscribe) {
      return;
    }
    this.watchUnsubscribe = subscribeToWatch(path, {
      onReady: ({ recovered }) => {
        this.watchUnavailable = false;
        this.setRefreshState("idle");
        if (recovered) {
          this.requestRefresh({ allDirectories: true, selected: true });
        }
      },
      onChange: (change) => this.handleWatchChange(change),
      onRecover: () =>
        this.requestRefresh({ allDirectories: true, selected: true }),
      onError: () => {
        this.watchUnavailable = true;
        this.setRefreshState("unavailable");
      },
    });
  }

  handleWatchChange(change) {
    const paths = Array.isArray(change.paths) ? change.paths : [];
    this.requestRefresh({
      paths,
      allDirectories: Boolean(change.overflow),
      selected: Boolean(
        this.selectedPath &&
          (change.overflow || paths.includes(this.selectedPath)),
      ),
      revision: change.revision,
    });
  }

  requestRefresh(options = {}) {
    this.pendingRefresh.allDirectories ||= Boolean(options.allDirectories);
    this.pendingRefresh.selected ||= Boolean(options.selected);
    this.pendingRefresh.revision =
      options.revision ?? this.pendingRefresh.revision;
    for (const path of options.paths ?? []) {
      this.pendingRefresh.paths.add(path);
    }
    return this.refreshCoordinator.request();
  }

  async performPendingRefresh() {
    const pending = this.pendingRefresh;
    this.pendingRefresh = createPendingRefresh();
    await this.refreshDirectories(pending);
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

  async refreshDirectories(pending) {
    const cachedPaths = this.fileList.cachedDirectoryPaths();
    const targets = new Set();
    if (pending.allDirectories) {
      cachedPaths.forEach((path) => targets.add(path));
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

    const directories = [];
    const paths = Array.from(targets);
    for (let index = 0; index < paths.length; index += 4) {
      const batch = paths.slice(index, index + 4);
      const results = await Promise.allSettled(
        batch.map((path) => listDirectory(path)),
      );
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

  setRefreshState(state) {
    const nextState =
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

  showDirectoryLoadingAfterDelay(requestId) {
    return window.setTimeout(() => {
      if (requestId === this.directoryRequestId) {
        this.fileList.setLoading();
      }
    }, LOADING_DELAY_MS);
  }

  loadStoredDirectoryPath() {
    if (!this.storageKey) {
      return null;
    }
    try {
      return window.localStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  storeDirectoryPath(path) {
    if (!this.storageKey) {
      return;
    }
    try {
      window.localStorage.setItem(this.storageKey, path);
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
  }

  clearStoredDirectoryPath() {
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

if (!customElements.get("caffold-file-navigator")) {
  customElements.define("caffold-file-navigator", CaffoldFileNavigator);
}

function parentPath(path) {
  const parts = cleanPath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function cleanPath(path) {
  return `${path ?? ""}`
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function createPendingRefresh() {
  return {
    allDirectories: false,
    selected: false,
    paths: new Set(),
    revision: null,
  };
}
