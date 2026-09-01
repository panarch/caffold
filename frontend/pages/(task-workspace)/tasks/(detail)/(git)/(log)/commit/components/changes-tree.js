import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  buildFileTreeNodes,
  FILE_TREE_SELECT_EVENT,
} from "../../../../../../../../components/file-tree.js";
import { emptyActionHintScope } from "../../../../../../../../action-hint-scope.js";
import { emptyScrollSurfaceScope } from "../../../../../../../../scroll-scope.js";

class CaffoldCommitChangesTree extends HTMLElement {
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
        new CustomEvent("caffold:open-commit-diff", {
          bubbles: true,
          detail: {
            sha: this.state.commitPayload.commit.sha,
            path: file.path,
            status: file.status,
          },
        }),
      );
    });
    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository, commit = null) {
    this.state = { status: "loading", repository, commit };
    this.renderState();
  }

  setCommit(commitPayload) {
    this.state = { status: "ready", commitPayload };
    this.renderState();
  }

  updateCommit(commitPayload) {
    this.state = { status: "ready", commitPayload };
    this.renderState();
  }

  setError(error, repository = null, commit = null) {
    this.state = { status: "error", error, repository, commit };
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

  scrollSurfaceScope({
    scopeId = "",
    label = "Commit files",
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
        this.state?.status === "ready" && this.fileTree() === tree,
    });
  }

  renderState() {
    const state = this.state ?? { status: "idle" };
    if (state.status !== "ready") {
      const message =
        state.status === "loading"
          ? "Loading commit..."
          : state.status === "error"
            ? escapeHtml(state.error.message)
            : "";
      this.innerHTML = `
        <section class="commit-tree-panel${state.status === "error" ? " error-panel" : ""}"${
          state.status === "loading" ? ' aria-busy="true"' : ""
        }>
          ${this.renderHeader(null, null)}
          ${message ? `<p class="surface-message">${message}</p>` : "<caffold-file-tree></caffold-file-tree>"}
        </section>
      `;
      return;
    }

    const payload = state.commitPayload;
    const files = payload.files ?? [];
    this.ensureReadyPanel(files.length > 0);
    this.querySelector(":scope > .commit-tree-panel > header").innerHTML =
      this.renderHeaderContent(files.length, payload);
    if (files.length === 0) {
      this.querySelector(":scope > .commit-tree-panel > .surface-message").textContent =
        "No files changed.";
      return;
    }

    const { nodes, fileKeyByPath } = commitNodes(files);
    this.fileKeyByPath = fileKeyByPath;
    this.fileTree().setModel({
      entityKey: commitEntityKey(payload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  ensureReadyPanel(hasFiles) {
    const expected = hasFiles ? "tree" : "empty";
    const panel = this.querySelector(":scope > .commit-tree-panel");
    if (panel?.dataset.content === expected) {
      return;
    }
    this.innerHTML = `
      <section class="commit-tree-panel" data-content="${expected}">
        <header></header>
        ${hasFiles ? "<caffold-file-tree></caffold-file-tree>" : '<p class="surface-message"></p>'}
      </section>
    `;
  }

  renderHeader(_payload, count) {
    return `<header>${this.renderHeaderContent(count, null)}</header>`;
  }

  renderHeaderContent(count, stats) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;
    return `
      <div class="commit-tree-title-row">
        <h2>Commit</h2>
        <span class="commit-file-count">${escapeHtml(countLabel)}</span>
      </div>
      ${renderDiffStats(stats)}
    `;
  }
}

customElements.define("caffold-commit-changes-tree", CaffoldCommitChangesTree);

function renderDiffStats(payload) {
  if (!Number.isFinite(payload?.additions) || !Number.isFinite(payload?.deletions)) {
    return "";
  }
  const additions = new Intl.NumberFormat("en-US").format(payload.additions);
  const deletions = new Intl.NumberFormat("en-US").format(payload.deletions);
  return `
    <span class="commit-line-stats" aria-label="${escapeHtml(
      `${additions} additions and ${deletions} deletions`,
    )}">
      <span class="is-addition">+${escapeHtml(additions)}</span>
      <span class="is-deletion">-${escapeHtml(deletions)}</span>
    </span>
  `;
}

function commitNodes(files) {
  const fileKeyByPath = new Map();
  const leaves = files.map((file) => {
    const key = `commit:file:${file.repoRelativePath}`;
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
      ariaLabel: `Show commit diff for ${file.repoRelativePath}`,
      source: file,
    };
  });
  return {
    nodes: buildFileTreeNodes(leaves, { namespace: "commit" }),
    fileKeyByPath,
  };
}

function commitEntityKey(payload) {
  return [
    payload?.repository?.rootPath ??
      payload?.repository?.root ??
      payload?.repository?.path ??
      "",
    payload?.commit?.sha ?? "",
  ].join("\u0000");
}
