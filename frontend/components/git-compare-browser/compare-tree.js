import { escapeHtml } from "../dom.js";
import {
  buildFileTreeNodes,
  FILE_TREE_SELECT_EVENT,
} from "../file-tree.js";

class CaffoldGitCompareTree extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      const file = event.detail.node.source;
      if (!file) {
        return;
      }
      this.selectedPath = file.path;
      this.dispatchEvent(
        new CustomEvent("caffold:open-compare-diff", {
          bubbles: true,
          detail: { path: file.path, status: file.status },
        }),
      );
    });
    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository, comparison = {}) {
    this.state = {
      status: "loading",
      repository,
      baseRef: `${comparison.baseRef ?? ""}`,
      headRef: `${comparison.headRef ?? ""}`,
    };
    this.renderState();
  }

  setCompare(comparePayload) {
    this.state = { status: "ready", comparePayload };
    this.renderState();
  }

  updateCompare(comparePayload) {
    this.state = { status: "ready", comparePayload };
    this.renderState();
  }

  setError(error, repository = null) {
    this.state = { status: "error", error, repository };
    this.renderState();
  }

  setSelectedPath(path) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(this.selectedKey());
  }

  setEmptyMessage(message) {
    this.emptyMessage = message || "No files changed.";
    if (this.state?.status === "ready" && !this.state.comparePayload.files?.length) {
      this.renderState();
    }
  }

  reset() {
    this.selectedPath = "";
    this.state = { status: "idle" };
    this.renderState();
  }

  captureListScroll() {
    return this.fileTree()?.captureScroll() ?? null;
  }

  restoreListScroll(scroll) {
    this.fileTree()?.restoreScroll(scroll);
  }

  fileTree() {
    return this.querySelector("caffold-file-tree");
  }

  selectedKey() {
    return this.fileKeyByPath?.get(this.selectedPath) ?? "";
  }

  renderState() {
    const state = this.state ?? { status: "idle" };
    if (state.status !== "ready") {
      const message =
        state.status === "loading"
          ? "Loading compare..."
          : state.status === "error"
            ? escapeHtml(state.error.message)
            : "";
      this.innerHTML = `
        <section class="compare-tree-panel${state.status === "error" ? " error-panel" : ""}"${
          state.status === "loading" ? ' aria-busy="true"' : ""
        }>
          ${this.renderHeader(state, null)}
          ${message ? `<p class="surface-message">${message}</p>` : "<caffold-file-tree></caffold-file-tree>"}
        </section>
      `;
      return;
    }

    const payload = state.comparePayload;
    const files = payload.files ?? [];
    this.ensureReadyPanel(files.length > 0);
    this.querySelector(":scope > .compare-tree-panel > header").innerHTML =
      this.renderHeaderContent(payload, files.length);
    if (files.length === 0) {
      this.querySelector(":scope > .compare-tree-panel > .surface-message").textContent =
        this.emptyMessage || "No files changed.";
      return;
    }

    const { nodes, fileKeyByPath } = compareNodes(files);
    this.fileKeyByPath = fileKeyByPath;
    this.fileTree().setModel({
      entityKey: compareEntityKey(payload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  ensureReadyPanel(hasFiles) {
    const expected = hasFiles ? "tree" : "empty";
    const panel = this.querySelector(":scope > .compare-tree-panel");
    if (panel?.dataset.content === expected) {
      return;
    }
    this.innerHTML = `
      <section class="compare-tree-panel" data-content="${expected}">
        <header></header>
        ${hasFiles ? "<caffold-file-tree></caffold-file-tree>" : '<p class="surface-message"></p>'}
      </section>
    `;
  }

  renderHeader(payload, count) {
    return `<header>${this.renderHeaderContent(payload, count)}</header>`;
  }

  renderHeaderContent(payload, count) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;
    const baseRef = `${payload?.baseRef ?? ""}`;
    return `
      <div class="compare-tree-title-row">
        <h2>Files</h2>
        <span class="compare-file-count">${escapeHtml(countLabel)}</span>
      </div>
      <div class="compare-tree-meta-row">
        ${baseRef
          ? `<span class="compare-base" title="Compare with ${escapeHtml(baseRef)}">vs ${escapeHtml(compareRefLabel(baseRef))}</span>`
          : "<span></span>"}
        ${renderDiffStats(payload)}
      </div>
    `;
  }
}

customElements.define("caffold-git-compare-tree", CaffoldGitCompareTree);

function renderDiffStats(payload) {
  if (!Number.isFinite(payload?.additions) || !Number.isFinite(payload?.deletions)) {
    return "";
  }
  const additions = new Intl.NumberFormat("en-US").format(payload.additions);
  const deletions = new Intl.NumberFormat("en-US").format(payload.deletions);
  return `
    <span class="compare-line-stats" aria-label="${escapeHtml(
      `${additions} additions and ${deletions} deletions`,
    )}">
      <span class="is-addition">+${escapeHtml(additions)}</span>
      <span class="is-deletion">-${escapeHtml(deletions)}</span>
    </span>
  `;
}

function compareRefLabel(ref) {
  return `${ref ?? ""}`.replace(/^origin\//, "");
}

function compareNodes(files) {
  const fileKeyByPath = new Map();
  const leaves = files.map((file) => {
    const key = `compare:file:${file.repoRelativePath}`;
    if (!fileKeyByPath.has(file.path)) {
      fileKeyByPath.set(file.path, key);
    }
    return {
      key,
      kind: "file",
      path: file.path,
      treePath: file.repoRelativePath,
      status: file.status,
      title: file.repoRelativePath,
      ariaLabel: `Show compare diff for ${file.repoRelativePath}`,
      source: file,
    };
  });
  return {
    nodes: buildFileTreeNodes(leaves, { namespace: "compare" }),
    fileKeyByPath,
  };
}

function compareEntityKey(payload) {
  return [
    payload?.repository?.rootPath ??
      payload?.repository?.root ??
      payload?.repository?.path ??
      "",
    payload?.baseRef ?? "",
    payload?.headRef ?? "",
  ].join("\u0000");
}
