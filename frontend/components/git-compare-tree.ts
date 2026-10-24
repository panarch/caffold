import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  mergeActionHintScopes,
  selectActionHintTarget,
} from "../action-hint-scope.js";
import type { GitCompare, GitCompareFile, GitRepository } from "../api.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "../scroll-scope.js";
import { formatLineStats } from "./dom.ts";
import {
  buildFileTreeNodes,
  type CaffoldFileTree,
  type FileTreeNode,
  type FileTreeSelectDetail,
} from "./file-tree.ts";
import "./loading-text.ts";

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

  constructor() {
    super();
    this.state = { status: "idle" };
    this.baseSelection = { enabled: false, refs: [], value: "" };
    this.emptyMessage = "";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
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
                class="compare-tree-content"
                @caffold:file-tree-select=${this.openFile}
              ></caffold-file-tree>`
        }
      </section>
    `;
  }

  // A `.value` binding would land before the options it names.
  updated() {
    const select = this.baseRefSelect();
    const { enabled, value } = this.baseSelection;
    if (enabled && select && select.value !== value) {
      select.value = value;
    }
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
    this.showState();
  }

  setCompare(comparePayload: GitCompare) {
    this.state = { status: "ready", comparePayload };
    this.showState();
  }

  updateCompare(comparePayload: GitCompare) {
    this.state = { status: "ready", comparePayload };
    this.showState();
  }

  setError(error: Error, repository: GitRepository | null = null) {
    this.state = { status: "error", error, repository };
    this.showState();
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
    this.performUpdate();
  }

  setEmptyMessage(message: string | null | undefined) {
    this.emptyMessage = message || "No files changed.";
    this.performUpdate();
  }

  reset() {
    this.selectedPath = "";
    this.baseSelection = { enabled: false, refs: [], value: "" };
    this.state = { status: "idle" };
    this.showState();
  }

  captureListScroll() {
    return this.fileTree()?.captureScroll() ?? null;
  }

  restoreListScroll(scroll: { top: number; left: number } | null | undefined) {
    this.fileTree()?.restoreScroll(scroll);
  }

  fileTree() {
    return this.querySelector<CaffoldFileTree>("caffold-file-tree");
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    selectActionId = "",
    clipRoots = [],
  }: ActionHintScopeOptions & {
    disclosureActionId?: string;
    selectActionId?: string;
  } = {}): ActionHintScope {
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const tree = this.fileTree();
    return mergeActionHintScopes(
      selectActionId
        ? this.baseSelectActionHintScope({
            scopeId,
            actionId: selectActionId,
            clipRoots,
          })
        : null,
      (actionId || disclosureActionId) && this.state.status === "ready" && tree
        ? tree.actionHintScope({
            scopeId,
            actionId,
            disclosureActionId,
            clipRoots: [this, ...clipRoots],
            isCurrent: (node) => comparedFile(node)?.path === this.selectedPath,
            labelForNode: (node) =>
              node.ariaLabel ||
              `Open ${comparedFile(node)?.repoRelativePath ?? node.name}`,
          })
        : null,
    );
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Compared files",
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

  private baseSelectActionHintScope({
    scopeId,
    actionId,
    clipRoots,
  }: {
    scopeId: string;
    actionId: string;
    clipRoots: Element[];
  }): ActionHintScope {
    if (!actionId) {
      return emptyActionHintScope();
    }
    const control = this.baseRefSelect();
    const anchor = this.querySelector(".compare-base");
    const selection = this.baseSelection;
    if (
      !this.isConnected ||
      !selection.enabled ||
      !selection.refs.length ||
      !control ||
      !anchor ||
      control.hidden ||
      control.disabled
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        selectActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:base-ref`,
          actionId,
          label: selection.value
            ? `Choose comparison base (current ${selection.value})`
            : "Choose comparison base",
          control,
          anchor,
          clipRoots: [this, ...clipRoots],
          isActionable: () => {
            const currentSelection = this.baseSelection;
            return Boolean(
              this.isConnected &&
                !this.hidden &&
                currentSelection.enabled &&
                currentSelection.refs.length &&
                this.baseRefSelect() === control &&
                this.querySelector(".compare-base") === anchor &&
                !control.hidden &&
                !control.disabled,
            );
          },
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  // Draws the state, and for compared files hands the tree their nodes.
  private showState() {
    this.performUpdate();
    const state = this.state;
    const tree = this.fileTree();
    if (state.status !== "ready" || !tree) {
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

  private chooseBase(event: Event) {
    const baseRef = (event.currentTarget as HTMLSelectElement).value;
    if (!baseRef || baseRef === this.baseSelection.value) {
      return;
    }
    this.baseSelection = { ...this.baseSelection, value: baseRef };
    this.performUpdate();
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

  private baseRefSelect() {
    return this.querySelector<HTMLSelectElement>(
      "select[data-compare-base-ref]",
    );
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
