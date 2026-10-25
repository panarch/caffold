import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import type { GitCommit, GitCommitFile } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
import {
  buildFileTreeNodes,
  type CaffoldFileTree,
  type FileTreeNode,
  type FileTreeSelectDetail,
} from "#components/file-tree.ts";
import "#components/loading-text.ts";

type CommitState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; commitPayload: GitCommit }
  | { status: "error"; error: Error };

export class CaffoldCommitChangesTree extends LitElement {
  static properties = {
    state: { state: true },
  };

  declare private state: CommitState;
  selectedPath = "";
  private fileKeyByPath = new Map<string, string>();

  constructor() {
    super();
    this.state = { status: "idle" };
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const state = this.state;
    const payload = state.status === "ready" ? state.commitPayload : null;
    const files = payload?.files ?? [];
    const message =
      state.status === "loading"
        ? html`<caffold-loading-text>Loading commit...</caffold-loading-text>`
        : state.status === "error"
          ? state.error.message
          : payload && files.length === 0
            ? "No files changed."
            : "";
    const panelClass =
      state.status === "error"
        ? "commit-tree-panel error-panel"
        : "commit-tree-panel";
    const countLabel = payload ? `${files.length} files` : "";
    const stats = payload ? lineStats(payload) : null;
    return html`
      <section
        class=${panelClass}
        data-content=${payload ? (files.length ? "tree" : "empty") : nothing}
        aria-busy=${state.status === "loading" ? "true" : nothing}
      >
        <header>
          <div class="commit-tree-title-row">
            <h2>Commit</h2>
            <span class="commit-file-count">${countLabel}</span>
          </div>
          ${
            stats
              ? html`<span class="commit-line-stats" aria-label=${stats.label}>
                  <span class="is-addition">+${stats.additions}</span>
                  <span class="is-deletion">-${stats.deletions}</span>
                </span>`
              : nothing
          }
        </header>
        ${
          message
            ? html`<p class="surface-message">${message}</p>`
            : html`<caffold-file-tree
                @caffold:file-tree-select=${this.openFile}
              ></caffold-file-tree>`
        }
      </section>
    `;
  }

  // The tree is handed the commit's files once it is drawn.
  updated(changed: PropertyValues) {
    const state = this.state;
    if (!changed.has("state") || state.status !== "ready") {
      return;
    }
    const tree = this.fileTree();
    if (!tree) {
      return;
    }
    const { nodes, fileKeyByPath } = commitNodes(state.commitPayload.files);
    this.fileKeyByPath = fileKeyByPath;
    tree.setModel({
      entityKey: commitEntityKey(state.commitPayload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  setLoading() {
    this.state = { status: "loading" };
  }

  setCommit(commitPayload: GitCommit) {
    this.state = { status: "ready", commitPayload };
  }

  updateCommit(commitPayload: GitCommit) {
    this.state = { status: "ready", commitPayload };
  }

  setError(error: Error) {
    this.state = { status: "error", error };
  }

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(this.selectedKey());
  }

  reset() {
    this.selectedPath = "";
    this.state = { status: "idle" };
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    clipRoots = [],
  }: ActionHintScopeOptions & {
    disclosureActionId?: string;
  } = {}): ActionHintScope {
    const tree = this.fileTree();
    if (
      !scopeId ||
      (!actionId && !disclosureActionId) ||
      this.hidden ||
      this.state.status !== "ready" ||
      !tree
    ) {
      return emptyActionHintScope();
    }
    return tree.actionHintScope({
      scopeId,
      actionId,
      disclosureActionId,
      clipRoots: [this, ...clipRoots],
      isCurrent: (node) => commitFile(node)?.path === this.selectedPath,
      labelForNode: (node) => node.ariaLabel || `Open ${node.name}`,
    });
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Commit files",
    clipRoots = [],
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const tree = this.fileTree();
    if (!scopeId || this.hidden || this.state.status !== "ready" || !tree) {
      return emptyScrollSurfaceScope();
    }
    return tree.scrollSurfaceScope({
      scopeId,
      label,
      clipRoots: [this, ...clipRoots],
      isCurrent: () =>
        this.state.status === "ready" && this.fileTree() === tree,
    });
  }

  private openFile(event: CustomEvent<FileTreeSelectDetail>) {
    const file = commitFile(event.detail.node);
    if (!file || this.state.status !== "ready") {
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
  }

  private fileTree() {
    return this.querySelector<CaffoldFileTree>("caffold-file-tree");
  }

  private selectedKey() {
    return this.fileKeyByPath.get(this.selectedPath) ?? "";
  }
}

customElements.define("caffold-commit-changes-tree", CaffoldCommitChangesTree);

function commitFile(node: FileTreeNode) {
  return node.source as GitCommitFile | undefined;
}

function lineStats({ additions, deletions }: GitCommit) {
  if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
    return null;
  }
  const format = new Intl.NumberFormat("en-US");
  return {
    label: `${format.format(additions)} additions and ${format.format(deletions)} deletions`,
    additions: format.format(additions),
    deletions: format.format(deletions),
  };
}

function commitNodes(files: GitCommitFile[]) {
  const fileKeyByPath = new Map<string, string>();
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

function commitEntityKey(payload: GitCommit) {
  return [
    payload.repository?.rootPath ??
      payload.repository?.root ??
      payload.repository?.path ??
      "",
    payload.commit.sha,
  ].join("\u0000");
}
