import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.ts";
import type { GitCompare, GitCompareFile, GitRepository } from "../api.ts";
import {
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  ScrollSurfaces,
} from "../scroll-scope.ts";
import { formatLineStats } from "./dom.ts";
import {
  buildFileTreeNodes,
  type CaffoldFileTree,
  type FileTreeNode,
  type FileTreeSelectDetail,
} from "./file-tree.ts";
import "./loading-text.ts";
import { DrawnRef, drawn } from "./drawn-refs.ts";

type CompareState =
  | { status: "idle" }
  | {
      status: "loading";
      repository: GitRepository | null;
      baseRef: string;
      headRef: string;
    }
  | { status: "ready"; comparePayload: GitCompare }
  | { status: "error"; error: Error; repository: GitRepository | null };

interface CompareRef {
  name: string;
  kind: string;
}

interface BaseSelection {
  enabled: boolean;
  refs: CompareRef[];
  value: string;
}

export class CaffoldGitCompareTree extends LitElement {
  static properties = {
    state: { state: true },
    baseSelection: { state: true },
    emptyMessage: { state: true },
  };

  declare private state: CompareState;
  declare private baseSelection: BaseSelection;
  declare private emptyMessage: string;
  selectedPath = "";
  private fileKeyByPath = new Map<string, string>();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly compareBase = new DrawnRef<HTMLSpanElement>(this);
  private readonly baseRefSelect = new DrawnRef<HTMLSelectElement>(this);
  private readonly tree = new DrawnRef<CaffoldFileTree>(this);

  constructor() {
    super();
    this.state = { status: "idle" };
    this.baseSelection = { enabled: false, refs: [], value: "" };
    this.emptyMessage = "";
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const state = this.state;
    const compare = state.status === "ready" ? state.comparePayload : null;
    const files = compare?.files ?? [];
    const message =
      state.status === "loading"
        ? html`<caffold-loading-text>Loading compare...</caffold-loading-text>`
        : state.status === "error"
          ? state.error.message
          : compare && files.length === 0
            ? this.emptyMessage || "No files changed."
            : "";
    const panelClass =
      state.status === "error"
        ? "compare-tree-panel error-panel"
        : "compare-tree-panel";
    const selection = this.baseSelection;
    const shownBaseRef =
      state.status === "loading" ? state.baseRef : compare?.baseRef;
    const baseRef = selection.enabled
      ? selection.value
      : `${shownBaseRef ?? ""}`;
    const baseLabel = baseRef ? `vs ${compareRefLabel(baseRef)}` : "";
    const baseOptions = refGroups(selection.refs).map(
      (group) => html`<optgroup label=${refKindLabel(group.kind)}>
        ${group.refs.map(
          (ref) => html`<option value=${ref.name}>${ref.name}</option>`,
        )}
      </optgroup>`,
    );
    const fileCount = compare ? `${files.length} files` : "";
    const stats = formatLineStats(compare);
    return html`
      <section
        class=${panelClass}
        data-content=${message ? "message" : "tree"}
        ?aria-busy=${state.status === "loading"}
      >
        <header>
          <div class="compare-tree-primary">
            <h2>Files</h2>
            <span
              ${drawn(this.compareBase)}
              class="compare-base"
              title=${baseRef ? `Compare with ${baseRef}` : nothing}
            >
              <span class="compare-base-label">${baseLabel}</span>
              <span
                class="compare-base-chevron"
                aria-hidden="true"
                ?hidden=${!selection.enabled}
              ></span>
              <select
                ${drawn(this.baseRefSelect)}
                ${this.hints.select({
                  id: "base-ref",
                  label: selection.value
                    ? `Choose comparison base (current ${selection.value})`
                    : "Choose comparison base",
                  role: "select",
                  when: selection.enabled,
                  anchor: () => this.compareBase.value,
                  clipRoots: () => [this],
                })}
                data-compare-base-ref
                aria-label="Branch comparison base"
                ?hidden=${!selection.enabled}
                title=${selection.enabled && baseRef ? baseRef : nothing}
                @change=${this.chooseBase}
              >
                ${baseOptions}
              </select>
            </span>
          </div>
          <div class="compare-tree-secondary">
            <span class="compare-file-count">${fileCount}</span>
            <span
              class="compare-line-stats"
              ?hidden=${!stats}
              aria-label=${stats?.label ?? nothing}
            >
              <span class="is-addition">${stats?.additions ?? ""}</span>
              <span class="is-deletion">${stats?.deletions ?? ""}</span>
            </span>
          </div>
        </header>
        ${
          message
            ? html`<p
                class="surface-message compare-tree-content"
              >${message}</p>`
            : html`<caffold-file-tree
                ${drawn(this.tree)}
                class="compare-tree-content"
                @caffold:file-tree-select=${this.openFile}
              ></caffold-file-tree>`
        }
      </section>
    `;
  }

  // A `.value` binding would land before the options it names, and the tree
  // is handed the compared files once it is drawn.
  updated(changed: PropertyValues) {
    const select = this.baseRefSelect.value;
    const { enabled, value } = this.baseSelection;
    if (enabled && select && select.value !== value) {
      select.value = value;
    }
    const state = this.state;
    const tree = this.fileTree();
    if (!changed.has("state") || state.status !== "ready" || !tree) {
      return;
    }
    const { nodes, fileKeyByPath } = compareNodes(
      state.comparePayload.files ?? [],
    );
    this.fileKeyByPath = fileKeyByPath;
    tree.setModel({
      entityKey: compareEntityKey(state.comparePayload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  setLoading(
    repository: GitRepository | null,
    comparison: { baseRef?: string | null; headRef?: string | null } = {},
  ) {
    this.state = {
      status: "loading",
      repository,
      baseRef: `${comparison.baseRef ?? ""}`,
      headRef: `${comparison.headRef ?? ""}`,
    };
  }

  setCompare(comparePayload: GitCompare) {
    this.state = { status: "ready", comparePayload };
  }

  updateCompare(comparePayload: GitCompare) {
    this.state = { status: "ready", comparePayload };
  }

  setError(error: Error, repository: GitRepository | null = null) {
    this.state = { status: "error", error, repository };
  }

  setSelectedPath(path: string | null | undefined) {
    this.selectedPath = path ?? "";
    this.fileTree()?.setSelectedKey(this.selectedKey());
  }

  setBaseSelection(
    selection: {
      refs?: Array<{ name?: string; kind?: string } | null> | null;
      value?: string | null;
    } = {},
  ) {
    const refs = normalizeRefs(selection.refs);
    this.baseSelection = {
      enabled: refs.length > 0,
      refs,
      value: `${selection.value ?? ""}`,
    };
  }

  setEmptyMessage(message: string | null | undefined) {
    this.emptyMessage = message || "No files changed.";
  }

  reset() {
    this.selectedPath = "";
    this.baseSelection = { enabled: false, refs: [], value: "" };
    this.state = { status: "idle" };
  }

  listScroller() {
    return this.fileTree()?.scroller() ?? null;
  }

  captureListScroll() {
    return this.fileTree()?.captureScroll() ?? null;
  }

  restoreListScroll(scroll: { top: number; left: number } | null | undefined) {
    this.fileTree()?.restoreScroll(scroll);
  }

  fileTree() {
    return this.tree.value ?? null;
  }

  // `actions` names what choosing the base (`select`) does and, for the
  // tree, what opening a `file` and toggling a `disclosure` do.
  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.state.status === "ready"
        ? this.fileTree()?.actionHintScope({
            ...pull,
            clipRoots: [this, ...(pull.clipRoots ?? [])],
          })
        : null,
    );
  }

  scrollSurfaceScope({
    label = "Compared files",
    ...pull
  }: ScrollSurfacePull = {}) {
    return mergeScrollSurfaceScopes(
      this.surfaces.scope(pull),
      this.state.status === "ready"
        ? this.fileTree()?.scrollSurfaceScope({
            ...pull,
            label,
            clipRoots: [this, ...(pull.clipRoots ?? [])],
          })
        : null,
    );
  }

  private chooseBase(event: Event) {
    const baseRef = (event.currentTarget as HTMLSelectElement).value;
    if (!baseRef || baseRef === this.baseSelection.value) {
      return;
    }
    this.baseSelection = { ...this.baseSelection, value: baseRef };
    this.dispatchEvent(
      new CustomEvent("caffold:select-compare-base", {
        bubbles: true,
        composed: true,
        detail: { baseRef },
      }),
    );
  }

  private openFile(event: CustomEvent<FileTreeSelectDetail>) {
    const file = comparedFile(event.detail.node);
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
  }

  private selectedKey() {
    return this.fileKeyByPath.get(this.selectedPath) ?? "";
  }
}

customElements.define("caffold-git-compare-tree", CaffoldGitCompareTree);

function comparedFile(node: FileTreeNode) {
  return node.source as GitCompareFile | undefined;
}

function compareRefLabel(ref: string) {
  return ref.replace(/^origin\//, "");
}

function normalizeRefs(
  refs: Array<{ name?: string; kind?: string } | null> | null | undefined,
): CompareRef[] {
  return (Array.isArray(refs) ? refs : [])
    .map((ref) => ({
      name: `${ref?.name ?? ""}`,
      kind: `${ref?.kind ?? "local"}`,
    }))
    .filter((ref) => ref.name);
}

// Consecutive refs of one kind share an option group.
function refGroups(refs: CompareRef[]) {
  const groups: Array<{ kind: string; refs: CompareRef[] }> = [];
  for (const ref of refs) {
    const group = groups.at(-1);
    if (group?.kind === ref.kind) {
      group.refs.push(ref);
    } else {
      groups.push({ kind: ref.kind, refs: [ref] });
    }
  }
  return groups;
}

function refKindLabel(kind: string) {
  if (kind === "head") {
    return "Current";
  }
  return kind === "remote" ? "Remote" : "Local";
}

function compareNodes(files: GitCompareFile[]) {
  const fileKeyByPath = new Map<string, string>();
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

function compareEntityKey(payload: GitCompare) {
  return [
    payload.repository?.rootPath ??
      payload.repository?.root ??
      payload.repository?.path ??
      "",
    payload.baseRef ?? "",
    payload.headRef ?? "",
  ].join("\u0000");
}
