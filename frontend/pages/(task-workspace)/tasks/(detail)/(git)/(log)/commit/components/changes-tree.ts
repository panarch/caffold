import { html, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type ActionHintPull,
  emptyActionHintScope,
} from "#app/action-hints.js";
import type { GitCommit, GitCommitFile } from "#app/api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import {
  buildFileTreeNodes,
  type CaffoldFileTree,
  type FileTreeNode,
  type FileTreeSelectDetail,
} from "#components/file-tree.js";
import "#components/loading-text.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./changes-tree.css.js";

export interface OpenCommitDiffDetail {
  sha: string;
  path: string;
  status: string;
}

type CommitState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; commitPayload: GitCommit }
  | { status: "error"; error: Error };

@customElement("caffold-commit-changes-tree")
export class CaffoldCommitChangesTree extends CaffoldElement {
  @state()
  private accessor state: CommitState = { status: "idle" };

  static override styles = styles;

  private readonly treeElement = new DrawnRef<CaffoldFileTree>(this);
  selectedPath = "";
  private fileKeyByPath = new Map<string, string>();

  override render() {
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
                ${drawn(this.treeElement)}
                @caffold:file-tree-select=${this.openFile}
              ></caffold-file-tree>`
        }
      </section>
    `;
  }

  // The tree is handed the commit's files once it is drawn.
  override updated(changed: PropertyValues) {
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

  actionHintScope({ clipRoots = [], ...pull }: ActionHintPull = {}) {
    const tree = this.fileTree();
    return this.state.status === "ready" && tree
      ? tree.actionHintScope({ ...pull, clipRoots: [this, ...clipRoots] })
      : emptyActionHintScope();
  }

  scrollSurfaceScope({
    label = "Commit files",
    clipRoots = [],
    ...pull
  }: ScrollSurfacePull = {}) {
    const tree = this.fileTree();
    return this.state.status === "ready" && tree
      ? tree.scrollSurfaceScope({
          ...pull,
          label,
          clipRoots: [this, ...clipRoots],
        })
      : emptyScrollSurfaceScope();
  }

  // Where the list scrolls, which the page keeps while a file is open.
  scroller() {
    return this.fileTree()?.scroller() ?? null;
  }

  private openFile(event: CustomEvent<FileTreeSelectDetail>) {
    const file = commitFile(event.detail.node);
    if (!file || this.state.status !== "ready") {
      return;
    }
    this.selectedPath = file.path;
    this.dispatchEvent(
      new CustomEvent<OpenCommitDiffDetail>("caffold:open-commit-diff", {
        bubbles: true,
        composed: true,
        detail: {
          sha: this.state.commitPayload.commit.sha,
          path: file.path,
          status: file.status,
        },
      }),
    );
  }

  private fileTree() {
    return this.treeElement.value;
  }

  private selectedKey() {
    return this.fileKeyByPath.get(this.selectedPath) ?? "";
  }
}

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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-commit-changes-tree": CaffoldCommitChangesTree;
  }

  interface HTMLElementEventMap {
    "caffold:open-commit-diff": CustomEvent<OpenCommitDiffDetail>;
  }
}
