import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  buildFileTreeNodes,
  FILE_TREE_SELECT_EVENT,
} from "../../../../../../../../components/file-tree.js";
import { emptyActionHintScope } from "../../../../../../../../action-hint-scope.js";

class CaffoldGithubPullFilesTree extends HTMLElement {
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
        new CustomEvent("caffold:open-github-pull-file", {
          bubbles: true,
          detail: { path: file.path, status: file.status },
        }),
      );
    });
    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository, number = null) {
    this.state = { status: "loading", repository, number };
    this.renderState();
  }

  setFiles(payload) {
    this.state = { status: "ready", payload };
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
          ? "Loading pull request files..."
          : state.status === "error"
            ? escapeHtml(state.error.message)
            : "";
      this.innerHTML = `
        <section class="github-pull-files-panel${state.status === "error" ? " error-panel" : ""}"${
          state.status === "loading" ? ' aria-busy="true"' : ""
        }>
          ${this.renderHeader(null)}
          ${message ? `<p class="surface-message">${message}</p>` : "<caffold-file-tree></caffold-file-tree>"}
        </section>
      `;
      return;
    }

    const payload = state.payload;
    const files = payload.files ?? [];
    this.ensureReadyPanel(files.length > 0);
    this.querySelector(":scope > .github-pull-files-panel > header").innerHTML =
      this.renderHeaderContent(files.length);
    if (files.length === 0) {
      this.querySelector(":scope > .github-pull-files-panel > .surface-message").textContent =
        "No files changed.";
      return;
    }

    const { nodes, fileKeyByPath } = pullFileNodes(files);
    this.fileKeyByPath = fileKeyByPath;
    this.fileTree().setModel({
      entityKey: pullEntityKey(payload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  ensureReadyPanel(hasFiles) {
    const expected = hasFiles ? "tree" : "empty";
    const panel = this.querySelector(":scope > .github-pull-files-panel");
    if (panel?.dataset.content === expected) {
      return;
    }
    this.innerHTML = `
      <section class="github-pull-files-panel" data-content="${expected}">
        <header></header>
        ${hasFiles ? "<caffold-file-tree></caffold-file-tree>" : '<p class="surface-message"></p>'}
      </section>
    `;
  }

  renderHeader(count) {
    return `<header>${this.renderHeaderContent(count)}</header>`;
  }

  renderHeaderContent(count) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;
    return `
      <div class="github-pull-files-title-row">
        <h2>Files</h2>
        <span class="github-pull-files-count">${escapeHtml(countLabel)}</span>
      </div>
    `;
  }
}

customElements.define("caffold-github-pull-files-tree", CaffoldGithubPullFilesTree);

function pullFileNodes(files) {
  const fileKeyByPath = new Map();
  const leaves = files.map((file) => {
    const key = `pull:file:${file.repoRelativePath}`;
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
      ariaLabel: `Show pull request diff for ${file.repoRelativePath}`,
      source: file,
    };
  });
  return {
    nodes: buildFileTreeNodes(leaves, { namespace: "pull" }),
    fileKeyByPath,
  };
}

function pullEntityKey(payload) {
  return [
    payload?.repository?.rootPath ??
      payload?.repository?.root ??
      payload?.repository?.path ??
      "",
    payload?.number ?? payload?.pullRequest?.number ?? "",
  ].join("\u0000");
}
