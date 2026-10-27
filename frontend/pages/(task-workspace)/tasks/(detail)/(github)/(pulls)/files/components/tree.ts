import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintPull,
  emptyActionHintScope,
} from "#app/action-hints.js";
import type { GitHubPullFile, GitHubPullFiles } from "#app/api.js";
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

const LOADING_FILES = "Loading pull request files...";

type FilesState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; payload: GitHubPullFiles }
  | { status: "error"; error: Error };

export class CaffoldGithubPullFilesTree extends LitElement {
  static properties = {
    state: { state: true },
  };

  declare private state: FilesState;
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
    const payload = state.status === "ready" ? state.payload : null;
    const files = payload?.files ?? [];
    const message =
      state.status === "loading"
        ? html`<caffold-loading-text>${LOADING_FILES}</caffold-loading-text>`
        : state.status === "error"
          ? state.error.message
          : payload && files.length === 0
            ? "No files changed."
            : "";
    const panelClass =
      state.status === "error"
        ? "github-pull-files-panel error-panel"
        : "github-pull-files-panel";
    const countLabel = payload ? `${files.length} files` : "";
    return html`
      <section
        class=${panelClass}
        data-content=${payload ? (files.length ? "tree" : "empty") : nothing}
        aria-busy=${state.status === "loading" ? "true" : nothing}
      >
        <header>
          <div class="github-pull-files-title-row">
            <h2>Files</h2>
            <span class="github-pull-files-count">${countLabel}</span>
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

  // The tree is handed the pull request's files once it is drawn.
  updated(changed: PropertyValues) {
    const state = this.state;
    if (!changed.has("state") || state.status !== "ready") {
      return;
    }
    const tree = this.fileTree();
    if (!tree) {
      return;
    }
    const { nodes, fileKeyByPath } = pullFileNodes(state.payload.files);
    this.fileKeyByPath = fileKeyByPath;
    tree.setModel({
      entityKey: pullEntityKey(state.payload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  setLoading() {
    this.state = { status: "loading" };
  }

  setFiles(payload: GitHubPullFiles) {
    this.state = { status: "ready", payload };
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
    label = "Pull request files",
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
    const file = pullFile(event.detail.node);
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
  }

  private fileTree() {
    return this.treeElement.value;
  }

  private selectedKey() {
    return this.fileKeyByPath.get(this.selectedPath) ?? "";
  }
}

customElements.define(
  "caffold-github-pull-files-tree",
  CaffoldGithubPullFilesTree,
);

function pullFile(node: FileTreeNode) {
  return node.source as GitHubPullFile | undefined;
}

function pullFileNodes(files: GitHubPullFile[]) {
  const fileKeyByPath = new Map<string, string>();
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

function pullEntityKey(payload: GitHubPullFiles) {
  return [
    payload.repository?.rootPath ??
      payload.repository?.root ??
      payload.repository?.path ??
      "",
    payload.number,
  ].join("\u0000");
}
