import { listDirectory } from "../api.js";
import { entryKindLabel, escapeHtml } from "./dom.js";
import { renderEntryIcon, warmIcons } from "./icons.js";

const TREE_LOADING_DELAY_MS = 180;

class CaffoldFileList extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-entry-path]");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.action === "toggle-directory") {
        this.toggleTreeDirectory(button.dataset.entryPath, button);
        return;
      }

      const path = button.dataset.entryPath;
      const eventName =
        button.dataset.kind === "directory"
          ? "caffold:open-directory"
          : "caffold:open-file";

      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          detail: { path, entry: this.entryForPath(path) },
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    this.setIdle();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
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
  }

  setError(error) {
    this.resetTreeState();
    this.state = { status: "error", error };
    this.render();
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="file-list-panel">
          <header><h2>Files</h2></header>
          <ol class="file-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="file-list-panel" aria-busy="true">
          <header><h2>Files</h2></header>
          <p class="surface-message">Loading files...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="file-list-panel error-panel">
          <header><h2>Files</h2></header>
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const { directory } = this.state;
    const repoMode = Boolean(directory.git);
    this.innerHTML = `
      <section class="file-list-panel">
        <header>
          <div class="file-list-title-row">
            <h2>Files</h2>
            <span class="entry-count">${directory.entries.length} entries</span>
          </div>
          ${this.renderGitSummary(directory.git)}
        </header>
        <ol class="file-list${repoMode ? " repo-tree" : ""}">
          ${this.renderParentEntry(directory.path)}
          ${repoMode ? this.renderTreeRoot(directory) : this.renderFlatEntries(directory)}
        </ol>
      </section>
    `;
  }

  renderFlatEntries(directory) {
    return directory.entries.map((entry) => this.renderEntry(entry)).join("");
  }

  renderTreeRoot(directory) {
    const treeState = this.treeState;
    if (!treeState) {
      return this.renderFlatEntries(directory);
    }

    const rootDirectory = treeState.cache.get(treeState.rootPath);
    if (!rootDirectory) {
      return this.renderTreeStatus("Loading repository...", 0);
    }

    return this.renderTreeEntries(rootDirectory.path, 0);
  }

  renderTreeEntries(path, depth) {
    const directory = this.treeState.cache.get(path);
    if (!directory) {
      return "";
    }

    return directory.entries
      .map((entry) => {
        const children = this.renderTreeChildren(entry, depth + 1);
        return `${this.renderTreeEntry(entry, depth)}${children}`;
      })
      .join("");
  }

  renderTreeChildren(entry, depth) {
    if (!isExpandableDirectory(entry) || !this.treeState.expanded.has(entry.path)) {
      return "";
    }

    if (this.treeState.loading.has(entry.path)) {
      return this.renderTreeStatus("Loading...", depth);
    }

    const error = this.treeState.errors.get(entry.path);
    if (error) {
      return this.renderTreeStatus(error.message, depth, " is-error");
    }

    return this.renderTreeEntries(entry.path, depth);
  }

  renderParentEntry(path) {
    if (!path) {
      return "";
    }

    const parentPath = parentDirectory(path);
    const parentEntry = {
      name: "..",
      path: parentPath,
      kind: "directory",
      isSymlink: false,
      supported: true,
    };

    return `
      <li>
        <button
          type="button"
          class="file-entry parent-entry"
          data-kind="directory"
          data-entry-path="${escapeHtml(parentPath)}"
          aria-label="Parent directory"
          title="Go to parent directory"
        >
          ${renderEntryIcon(parentEntry)}
          <span class="entry-name">..</span>
        </button>
      </li>
    `;
  }

  renderEntry(entry) {
    const kind = entryKindLabel(entry);
    const disabled = entry.supported ? "" : "disabled";
    const entryTitle = titleAttributeForEntry(entry);
    const className = fileEntryClassName(entry);
    const ignoredLabel = entry.gitIgnored ? " ignored by Git" : "";

    return `
      <li>
        <button
          type="button"
          class="${escapeHtml(className)}"
          data-kind="${escapeHtml(entry.kind)}"
          data-entry-path="${escapeHtml(entry.path)}"
          aria-current="${entry.path === this.selectedPath ? "true" : "false"}"
          aria-label="${escapeHtml(`${entry.name} ${kind}${ignoredLabel}`)}"
          ${disabled}
          ${entryTitle}
        >
          ${renderEntryIcon(entry)}
          <span class="entry-name">${escapeHtml(entry.name)}</span>
        </button>
      </li>
    `;
  }

  renderTreeEntry(entry, depth) {
    const kind = entryKindLabel(entry);
    const disabled = entry.supported ? "" : "disabled";
    const entryTitle = titleAttributeForEntry(entry);
    const className = fileEntryClassName(entry, "tree-entry");
    const expandable = isExpandableDirectory(entry);
    const expanded = expandable && this.treeState.expanded.has(entry.path);
    const action = expandable ? 'data-action="toggle-directory"' : "";
    const ariaExpanded = expandable ? `aria-expanded="${expanded ? "true" : "false"}"` : "";
    const toggleLabel = expandable ? (expanded ? "Collapse" : "Expand") : "";
    const ignoredLabel = entry.gitIgnored ? " ignored by Git" : "";
    const ariaLabel = toggleLabel
      ? `${toggleLabel} ${entry.name} ${kind}${ignoredLabel}`
      : `${entry.name} ${kind}${ignoredLabel}`;
    const iconEntry = expandable ? { ...entry, expanded } : entry;

    return `
      <li>
        <button
          type="button"
          class="${escapeHtml(className)}"
          style="--tree-depth: ${depth}"
          data-kind="${escapeHtml(entry.kind)}"
          data-entry-path="${escapeHtml(entry.path)}"
          aria-current="${entry.path === this.selectedPath ? "true" : "false"}"
          aria-label="${escapeHtml(ariaLabel)}"
          ${ariaExpanded}
          ${action}
          ${disabled}
          ${entryTitle}
        >
          ${renderEntryIcon(iconEntry)}
          <span class="entry-name">${escapeHtml(entry.name)}</span>
        </button>
      </li>
    `;
  }

  renderTreeStatus(message, depth, className = "") {
    return `
      <li
        class="tree-status${className}"
        style="--tree-depth: ${depth}"
      >
        ${escapeHtml(message)}
      </li>
    `;
  }

  renderGitSummary(git) {
    if (!git) {
      return "";
    }

    const branch = git.branch ?? "detached";
    const state = git.dirty ? "changes" : "clean";
    const dirtyClass = git.dirty ? " is-dirty" : "";

    return `
      <span
        class="git-summary${dirtyClass}"
        title="${escapeHtml(`Git ${branch}, ${state}`)}"
      >
        ${escapeHtml(branch)}${git.dirty ? " *" : ""}
      </span>
    `;
  }

  setSelectedPath(path) {
    const nextPath = path ?? "";
    if (this.selectedPath === nextPath) {
      return;
    }

    this.selectedPath = nextPath;
    this.patchSelectedPath();
  }

  patchSelectedPath() {
    for (const button of this.querySelectorAll('button[data-entry-path][aria-current="true"]')) {
      button.setAttribute("aria-current", "false");
    }

    if (!this.selectedPath) {
      return;
    }

    const button = this.entryButtonForPath(this.selectedPath);
    if (button) {
      button.setAttribute("aria-current", "true");
    }
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
        expanded: new Set(),
        loading: new Set(),
        errors: new Map(),
        timers: new Map(),
        requests: new Map(),
      };
    }

    this.treeState.cache.set(directory.path, directory);
    this.expandAncestors(directory.path);

    if (!this.treeState.cache.has(rootPath)) {
      this.loadTreeDirectory(rootPath);
    }
  }

  expandAncestors(path) {
    if (!this.treeState || path === this.treeState.rootPath) {
      return;
    }

    this.treeState.expanded.add(path);

    let current = path;
    while (current && current !== this.treeState.rootPath) {
      current = parentDirectory(current);
      if (current) {
        this.treeState.expanded.add(current);
      }
    }
  }

  async toggleTreeDirectory(path, button) {
    if (!this.treeState) {
      return;
    }

    const scrollAnchor = this.captureScrollAnchor(button);
    if (this.treeState.expanded.has(path)) {
      this.treeState.expanded.delete(path);
      this.render();
      this.restoreScrollAnchor(scrollAnchor);
      return;
    }

    this.treeState.expanded.add(path);
    this.treeState.errors.delete(path);
    this.render();
    this.restoreScrollAnchor(scrollAnchor, { revealPath: path });

    if (!this.treeState.cache.has(path)) {
      await this.loadTreeDirectory(path, { scrollAnchor, revealPath: path });
    }
  }

  async loadTreeDirectory(path, options = {}) {
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
          this.render();
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
        const timer = this.treeState.timers.get(path);
        window.clearTimeout(timer);
        this.treeState.timers.delete(path);
        this.treeState.requests.delete(path);
        this.treeState.loading.delete(path);
        this.render();
        this.restoreScrollAnchor(options.scrollAnchor, { revealPath: options.revealPath });
      }
    }
  }

  captureScrollAnchor(button) {
    const scroller = this.querySelector(".file-list");
    if (!button || !scroller) {
      return null;
    }

    return {
      path: button.dataset.entryPath,
      top: button.getBoundingClientRect().top,
    };
  }

  restoreScrollAnchor(anchor, options = {}) {
    if (!anchor) {
      return;
    }

    requestAnimationFrame(() => {
      const scroller = this.querySelector(".file-list");
      const button = this.entryButtonForPath(anchor.path);
      if (!scroller || !button) {
        return;
      }

      const currentTop = button.getBoundingClientRect().top;
      scroller.scrollTop += currentTop - anchor.top;
      this.revealFirstChildIfHidden(scroller, options.revealPath);
    });
  }

  revealFirstChildIfHidden(scroller, parentPath) {
    if (!parentPath) {
      return;
    }

    const firstChild = Array.from(this.querySelectorAll("button[data-entry-path]")).find(
      (button) => isDirectChildPath(button.dataset.entryPath, parentPath),
    );
    if (!firstChild) {
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const childRect = firstChild.getBoundingClientRect();
    const visibleTop = Math.max(scrollerRect.top, childRect.top);
    const visibleBottom = Math.min(scrollerRect.bottom, childRect.bottom);

    if (visibleBottom > visibleTop) {
      return;
    }

    const bottomOverflow = childRect.bottom - scrollerRect.bottom;
    const topOverflow = childRect.top - scrollerRect.top;
    if (bottomOverflow > 0) {
      scroller.scrollTop += bottomOverflow;
    } else if (topOverflow < 0) {
      scroller.scrollTop += topOverflow;
    }
  }

  entryButtonForPath(path) {
    return Array.from(this.querySelectorAll("button[data-entry-path]")).find(
      (button) => button.dataset.entryPath === path,
    );
  }

  entryForPath(path) {
    if (!path) {
      return null;
    }

    const currentEntry = this.state?.directory?.entries.find((entry) => entry.path === path);
    if (currentEntry) {
      return currentEntry;
    }

    if (!this.treeState) {
      return null;
    }

    for (const directory of this.treeState.cache.values()) {
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
    if (!this.treeState) {
      return;
    }

    for (const timer of this.treeState.timers.values()) {
      window.clearTimeout(timer);
    }
  }
}

customElements.define("caffold-file-list", CaffoldFileList);

function parentDirectory(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isHiddenEntry(entry) {
  return entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..";
}

function fileEntryClassName(entry, ...extraClassNames) {
  return [
    "file-entry",
    ...extraClassNames,
    isHiddenEntry(entry) ? "is-hidden" : "",
    entry.gitIgnored ? "is-ignored" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function titleAttributeForEntry(entry) {
  if (!entry.supported) {
    return 'title="This path resolves outside the root"';
  }

  if (entry.gitIgnored) {
    return 'title="Ignored by Git"';
  }

  return "";
}

function isExpandableDirectory(entry) {
  return entry.kind === "directory" && entry.supported;
}

function isDirectChildPath(path, parentPath) {
  if (!path || !parentPath || !path.startsWith(`${parentPath}/`)) {
    return false;
  }

  return !path.slice(parentPath.length + 1).includes("/");
}
