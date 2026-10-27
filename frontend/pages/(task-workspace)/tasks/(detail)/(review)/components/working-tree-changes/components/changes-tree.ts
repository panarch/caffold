import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintPull,
  emptyActionHintScope,
} from "#app/action-hints.js";
import type { GitChangedFile, GitStatus } from "#app/api.js";
import { fileStatusPresentation } from "#app/file-status.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { formatLineStats } from "#components/dom.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import {
  buildFileTreeNodes,
  type CaffoldFileTree,
  type FileTreeNode,
  type FileTreeSelectDetail,
  readyFileTreeChildren,
} from "#components/file-tree.js";
import "#components/loading-text.js";

const SECTIONS = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
] as const;

// The repository a loading or failed read was for, as far as it is known.
export interface ChangesRepository {
  rootPath?: string;
  path?: string;
  branch?: string | null;
  dirty?: boolean;
}

type ChangesState =
  | { status: "idle" }
  | { status: "loading"; repository: ChangesRepository | null }
  | { status: "ready"; gitStatus: GitStatus }
  | { status: "error"; error: Error; repository: ChangesRepository | null };

export class CaffoldGitDiffChangesTree extends LitElement {
  static properties = {
    state: { state: true },
  };

  declare private state: ChangesState;
  private readonly treeElement = new DrawnRef<CaffoldFileTree>(this);
  private selectedPath = "";
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
    const ready = state.status === "ready";
    const files = ready ? state.gitStatus.files : [];
    const repository = ready
      ? state.gitStatus.repository
      : state.status === "idle"
        ? null
        : state.repository;
    const message =
      state.status === "loading"
        ? html`<caffold-loading-text>Loading changes...</caffold-loading-text>`
        : state.status === "error"
          ? state.error.message
          : ready && files.length === 0
            ? "No changes."
            : "";
    const panelClass =
      state.status === "error"
        ? "changes-tree-panel error-panel"
        : "changes-tree-panel";
    const countLabel = ready ? `${files.length} changes` : "";
    const branch = repository?.branch ?? "HEAD";
    const branchClass = repository?.dirty
      ? "changes-branch is-dirty"
      : "changes-branch";
    const stats = formatLineStats(ready ? state.gitStatus : null);
    return html`
      <section
        class=${panelClass}
        data-content=${ready ? (files.length ? "tree" : "empty") : nothing}
        aria-busy=${state.status === "loading" ? "true" : nothing}
      >
        <header>
          <div class="changes-tree-title-row">
            <h2>Changes</h2>
            <span class="change-count">${countLabel}</span>
          </div>
          <div class="changes-tree-meta-row">
            ${
              repository
                ? html`<span class=${branchClass}>${branch}${
                    repository.dirty ? " *" : ""
                  }</span>`
                : html`<span></span>`
            }
            ${
              stats
                ? html`<span
                    class="change-line-stats"
                    aria-label=${stats.label}
                  >
                    <span class="is-addition">${stats.additions}</span>
                    <span class="is-deletion">${stats.deletions}</span>
                  </span>`
                : nothing
            }
          </div>
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

  // The tree is handed the changed files once it is drawn.
  updated(changed: PropertyValues) {
    const state = this.state;
    if (!changed.has("state") || state.status !== "ready") {
      return;
    }
    const tree = this.fileTree();
    if (!tree) {
      return;
    }
    const { nodes, fileKeyByPath } = changeNodes(state.gitStatus.files);
    this.fileKeyByPath = fileKeyByPath;
    tree.setModel({
      entityKey:
        state.gitStatus.repository?.rootPath ??
        state.gitStatus.repository?.path ??
        "working-tree",
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  setLoading(repository: ChangesRepository | null) {
    this.state = { status: "loading", repository };
  }

  setStatus(gitStatus: GitStatus) {
    this.state = { status: "ready", gitStatus };
  }

  updateStatus(gitStatus: GitStatus) {
    this.state = { status: "ready", gitStatus };
  }

  setError(error: Error, repository: ChangesRepository | null = null) {
    this.state = { status: "error", error, repository };
  }

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(this.selectedKey());
  }

  captureListScroll() {
    return this.fileTree()?.captureScroll() ?? null;
  }

  restoreListScroll(scroll: { top: number; left: number } | null | undefined) {
    this.fileTree()?.restoreScroll(scroll);
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
    label = "Working tree changes",
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

  private openFile(event: CustomEvent<FileTreeSelectDetail>) {
    const file = changedFile(event.detail.node);
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
          status: fileStatusPresentation(file.status, file).code,
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

customElements.define(
  "caffold-git-diff-changes-tree",
  CaffoldGitDiffChangesTree,
);

function changedFile(node: FileTreeNode) {
  return node.source as GitChangedFile | undefined;
}

function changeNodes(files: GitChangedFile[]) {
  const fileKeyByPath = new Map<string, string>();
  const nodes = SECTIONS.flatMap(([category, label], order) => {
    const categoryFiles = files.filter(
      (file) => (file.untracked ? "unstaged" : file.category) === category,
    );
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
    return [
      {
        key: `changes:group:${category}`,
        kind: "group",
        name: label,
        order,
        children: readyFileTreeChildren(
          buildFileTreeNodes(leaves, { namespace: category }),
        ),
      },
    ];
  });
  return { nodes, fileKeyByPath };
}

function normalizeRepoPath(path: string) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}
