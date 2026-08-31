import { escapeHtml } from "../../../../../../components/dom.js";
import { fileStatusPresentation } from "../../../../../../file-status.js";
import {
  buildFileTreeNodes,
  FILE_TREE_SELECT_EVENT,
  readyFileTreeChildren,
} from "../../../../../../components/file-tree.js";
import { emptyActionHintScope } from "../../../../../../action-hint-scope.js";

const SECTIONS = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
];

class CaffoldGitDiffChangesTree extends HTMLElement {
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
        new CustomEvent("caffold:open-git-diff", {
          bubbles: true,
          detail: {
            path: file.path,
            kind: file.untracked ? "untracked" : file.category,
            status: displayStatus(file),
          },
        }),
      );
    });
    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository) {
    this.state = { status: "loading", repository };
    this.renderState();
  }

  setStatus(gitStatus) {
    this.state = { status: "ready", gitStatus };
    this.renderState();
  }

  updateStatus(gitStatus) {
    this.state = { status: "ready", gitStatus };
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

  captureListScroll() {
    return this.fileTree()?.captureScroll() ?? null;
  }

  restoreListScroll(scroll) {
    this.fileTree()?.restoreScroll(scroll);
  }

  reset() {
    this.selectedPath = "";
    this.state = { status: "idle" };
    this.renderState();
  }

  fileTree() {
    return this.querySelector("caffold-file-tree");
  }

  selectedKey() {
    return this.fileKeyByPath?.get(this.selectedPath) ?? "";
  }

  actionHintScope({ scopeId = "", actionId = "", clipRoots = [] } = {}) {
    const tree = this.fileTree();
    if (
      !scopeId ||
      !actionId ||
      this.hidden ||
      this.state?.status !== "ready" ||
      !tree
    ) {
      return emptyActionHintScope();
    }
    return tree.actionHintScope({
      scopeId,
      actionId,
      clipRoots: [this, ...clipRoots],
      isCurrent: (node) => node.source?.path === this.selectedPath,
      labelForNode: (node) => node.ariaLabel || `Open ${node.name}`,
    });
  }

  renderState() {
    const state = this.state ?? { status: "idle" };
    if (state.status !== "ready") {
      const message =
        state.status === "loading"
          ? "Loading changes..."
          : state.status === "error"
            ? escapeHtml(state.error.message)
            : "";
      this.innerHTML = `
        <section class="changes-tree-panel${state.status === "error" ? " error-panel" : ""}"${
          state.status === "loading" ? ' aria-busy="true"' : ""
        }>
          ${this.renderHeader(state.repository, null)}
          ${message ? `<p class="surface-message">${message}</p>` : "<caffold-file-tree></caffold-file-tree>"}
        </section>
      `;
      return;
    }

    const files = state.gitStatus.files;
    this.ensureReadyPanel(files.length > 0);
    this.querySelector(":scope > .changes-tree-panel > header").innerHTML =
      this.renderHeaderContent(state.gitStatus.repository, files.length, state.gitStatus);
    if (files.length === 0) {
      this.querySelector(":scope > .changes-tree-panel > .surface-message").textContent =
        "No changes.";
      return;
    }
    this.updateTreeModel();
  }

  ensureReadyPanel(hasFiles) {
    const expected = hasFiles ? "tree" : "empty";
    const panel = this.querySelector(":scope > .changes-tree-panel");
    if (panel?.dataset.content === expected) {
      return;
    }
    this.innerHTML = `
      <section class="changes-tree-panel" data-content="${expected}">
        <header></header>
        ${hasFiles ? "<caffold-file-tree></caffold-file-tree>" : '<p class="surface-message"></p>'}
      </section>
    `;
  }

  updateTreeModel() {
    const { nodes, fileKeyByPath } = changeNodes(this.state.gitStatus.files);
    this.fileKeyByPath = fileKeyByPath;
    this.fileTree().setModel({
      entityKey:
        this.state.gitStatus.repository?.rootPath ??
        this.state.gitStatus.repository?.path ??
        "working-tree",
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  renderHeader(repository, count, stats = null) {
    return `<header>${this.renderHeaderContent(repository, count, stats)}</header>`;
  }

  renderHeaderContent(repository, count, stats = null) {
    const branch = repository?.branch ?? "HEAD";
    const countLabel = count === null || count === undefined ? "" : `${count} changes`;
    return `
      <div class="changes-tree-title-row">
        <h2>Changes</h2>
        <span class="change-count">${escapeHtml(countLabel)}</span>
      </div>
      <div class="changes-tree-meta-row">
        ${repository
          ? `<span class="changes-branch${repository.dirty ? " is-dirty" : ""}">${escapeHtml(branch)}${repository.dirty ? " *" : ""}</span>`
          : "<span></span>"}
        ${renderDiffStats(stats)}
      </div>
    `;
  }
}

customElements.define("caffold-git-diff-changes-tree", CaffoldGitDiffChangesTree);

function changeNodes(files) {
  const fileKeyByPath = new Map();
  const nodes = SECTIONS.flatMap(([category, label], order) => {
    const categoryFiles = files.filter((file) => displayCategory(file) === category);
    if (categoryFiles.length === 0) {
      return [];
    }
    const leaves = categoryFiles.map((file) => {
      const repoRelativePath = normalizeRepoPath(file.repoRelativePath);
      const key = `${category}:file:${repoRelativePath}`;
      if (!fileKeyByPath.has(file.path)) {
        fileKeyByPath.set(file.path, key);
      }
      return {
        key,
        kind: "file",
        path: file.path,
        treePath: repoRelativePath,
        status: file.status,
        statusContext: file,
        title: repoRelativePath,
        ariaLabel: `Show diff for ${repoRelativePath}`,
        source: file,
      };
    });
    return [{
      key: `changes:group:${category}`,
      kind: "group",
      name: label,
      order,
      children: readyFileTreeChildren(
        buildFileTreeNodes(leaves, { namespace: category }),
      ),
    }];
  });
  return { nodes, fileKeyByPath };
}

function normalizeRepoPath(path) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function renderDiffStats(payload) {
  if (!Number.isFinite(payload?.additions) || !Number.isFinite(payload?.deletions)) {
    return "";
  }
  const additions = new Intl.NumberFormat("en-US").format(payload.additions);
  const deletions = new Intl.NumberFormat("en-US").format(payload.deletions);
  return `
    <span class="change-line-stats" aria-label="${escapeHtml(
      `${additions} additions and ${deletions} deletions`,
    )}">
      <span class="is-addition">+${escapeHtml(additions)}</span>
      <span class="is-deletion">-${escapeHtml(deletions)}</span>
    </span>
  `;
}

function displayCategory(file) {
  return file.untracked ? "unstaged" : file.category;
}

function displayStatus(file) {
  return fileStatusPresentation(file.status, file).code;
}
