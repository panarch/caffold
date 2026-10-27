import { html, LitElement, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { type ActionHintPull, ActionHints } from "../action-hints.js";
import {
  type FileStatusContext,
  fileStatusPresentation,
} from "../file-status.js";
import {
  type ScrollSurfacePull,
  ScrollSurfaces,
  scrollBackToTop,
} from "../scroll-scope.js";
import {
  FILE_SORT_MODES,
  type FileSortMode,
  getSettings,
  normalizeFileSortMode,
} from "../settings.js";
import { entryIcon, warmIcons } from "./icons.js";
import "./loading-text.js";
import { DrawnRef, DrawnRefs, drawn } from "./drawn-refs.js";

export const FILE_TREE_SELECT_EVENT = "caffold:file-tree-select";
export const FILE_TREE_LOAD_EVENT = "caffold:file-tree-load-children";

export type FileTreeChildren =
  | { status: "ready"; nodes: FileTreeNode[] }
  | { status: "unloaded" }
  | { status: "loading"; message?: string }
  | { status: "error"; message: string }
  | { status: "none"; nodes: FileTreeNode[] };

export interface FileTreeNode {
  key: string;
  kind: string;
  name?: string;
  path?: string;
  treePath?: string;
  title?: string;
  ariaLabel?: string;
  status?: string;
  statusContext?: FileStatusContext;
  isSymlink?: boolean;
  supported?: boolean;
  git?: { isRepoRoot?: boolean } | null;
  disabled?: boolean;
  hidden?: boolean;
  ignored?: boolean;
  variant?: string;
  selection?: boolean;
  selectable?: boolean;
  expandedByDefault?: boolean;
  order?: number;
  tone?: string;
  loading?: boolean;
  children?: FileTreeNode[] | FileTreeChildren;
  // What the owner made the node from, handed back when the node is chosen.
  source?: unknown;
}

export interface FileTreeModel {
  entityKey?: string;
  nodes?: FileTreeNode[];
  expandedKeys?: Iterable<string>;
  expandNewDirectories?: boolean;
  selectedKey?: string;
  hiddenEntriesLast?: boolean;
  listboxLabel?: string;
  statusColumn?: boolean;
}

export interface FileTreeSelectDetail {
  key: string;
  path: string;
  node: FileTreeNode;
}

interface TreeRow {
  key: string;
  node: FileTreeNode;
  depth: number;
  parentKey: string;
  passingGuideDepths: number[];
  firstSibling: boolean;
  lastSibling: boolean;
}

export class CaffoldFileTree extends LitElement {
  static properties = {
    nodes: { state: true },
    expandedKeys: { state: true },
    selectedKey: { state: true },
    hiddenEntriesLast: { state: true },
    listboxLabel: { state: true },
    statusColumn: { state: true },
    globalFileSortMode: { state: true },
  };

  declare private nodes: FileTreeNode[];
  declare private expandedKeys: Set<string>;
  declare private selectedKey: string;
  declare private hiddenEntriesLast: boolean;
  // With a label the rows are the options of a listbox whose owner keeps
  // focus in a text field, so they leave the Tab order. An owner keeps one
  // way for the tree's whole life.
  declare private listboxLabel: string;
  declare private statusColumn: boolean;
  declare private globalFileSortMode: FileSortMode;
  private entityKey: string | null = null;
  private nodeByKey = new Map<string, FileTreeNode>();
  private knownDirectoryKeys = new Set<string>();
  private pendingRevealKey: string | null = null;
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly rowsByKey = new DrawnRefs<HTMLLIElement>(this);
  private readonly entriesByKey = new DrawnRefs<HTMLButtonElement>(this);
  private readonly iconsByKey = new DrawnRefs<HTMLSpanElement>(this);
  private readonly iconsReady = () => this.requestUpdate();
  private readonly settingsChanged = (event: Event) => {
    this.globalFileSortMode = normalizeFileSortMode(
      (event as CustomEvent).detail?.settings?.fileSortMode,
    );
  };

  constructor() {
    super();
    this.nodes = [];
    this.expandedKeys = new Set();
    this.selectedKey = "";
    this.hiddenEntriesLast = false;
    this.listboxLabel = "";
    this.statusColumn = false;
    this.globalFileSortMode = normalizeFileSortMode(getSettings().fileSortMode);
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    window.addEventListener("caffold:settings-change", this.settingsChanged);
    this.globalFileSortMode = normalizeFileSortMode(getSettings().fileSortMode);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.removeEventListener("caffold:settings-change", this.settingsChanged);
  }

  // Rows declare their Action Hints: an expandable directory toggles, any
  // other entry opens, except the one already open (an owner's actions for
  // `disclosure` and `file`).
  render() {
    const listbox = Boolean(this.listboxLabel);
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          axes: ["vertical", "horizontal"],
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="file-tree-scroll"
      >
        <ol
          class="file-tree-rows"
          role=${listbox ? "listbox" : nothing}
          aria-label=${this.listboxLabel || nothing}
        >${repeat(
          this.visibleRows(),
          (row) => row.key,
          (row) => {
            const { node, depth, parentKey } = row;
            if (node.kind === "group") {
              return html`<li
                ${drawn(this.rowsByKey.of(row.key))}
                class="file-tree-group"
                data-file-tree-row-key=${row.key}
                role=${listbox ? "none" : nothing}
              >${node.name ?? ""}</li>`;
            }
            const guides = html`<span
              class="file-tree-guides"
              aria-hidden="true"
            >${row.passingGuideDepths.map(
              (guideDepth) =>
                html`<span
                  class="file-tree-guide"
                  style="--tree-guide-depth: ${guideDepth}"
                ></span>`,
            )}</span>`;
            if (node.kind === "status") {
              const name = node.name ?? "";
              // Owners add a loading row only once its wait is long enough
              // to show.
              const label = node.loading
                ? html`<caffold-loading-text immediate
                    >${name}</caffold-loading-text
                  >`
                : name;
              const statusClass =
                node.tone === "error"
                  ? "file-tree-status is-error"
                  : "file-tree-status";
              return html`<li
                ${drawn(this.rowsByKey.of(row.key))}
                class=${statusClass}
                data-file-tree-row-key=${row.key}
                data-file-tree-parent-key=${parentKey || nothing}
                role=${listbox ? "none" : nothing}
                ?data-file-tree-first-sibling=${row.firstSibling}
                ?data-file-tree-last-sibling=${row.lastSibling}
                style="--tree-depth: ${depth}"
              >${guides}${label}</li>`;
            }
            const expandable = isExpandable(node);
            const expanded =
              node.kind === "directory" && this.expandedKeys.has(node.key);
            const selected = node.key === this.selectedKey;
            const status = fileStatusPresentation(
              node.status,
              node.statusContext,
            );
            const ariaLabel =
              node.ariaLabel ?? defaultAriaLabel(node, expanded);
            const hint = {
              anchor: () => this.iconsByKey.get(node.key),
              clipRoots: () => [this.scrollport.value],
            };
            const key = encodeURIComponent(node.key);
            return html`<li
              ${drawn(this.rowsByKey.of(row.key))}
              class="file-tree-row"
              data-file-tree-row-key=${row.key}
              data-file-tree-parent-key=${parentKey || nothing}
              role=${listbox ? "none" : nothing}
              ?data-file-tree-first-sibling=${row.firstSibling}
              ?data-file-tree-last-sibling=${row.lastSibling}
            ><button
              ${drawn(this.entriesByKey.of(node.key))}
              ${
                expandable
                  ? this.hints.disclosure({
                      ...hint,
                      id: `disclosure:${key}`,
                      label: defaultAriaLabel(node, expanded),
                      role: "disclosure",
                    })
                  : this.hints.button({
                      ...hint,
                      id: `file:${key}`,
                      label: node.ariaLabel ?? `Open ${node.name ?? node.key}`,
                      role: "file",
                      when: node.selectable !== false && (listbox || !selected),
                    })
              }
              type="button"
              class="file-tree-entry file-tree-${node.kind}"
              style="--tree-depth: ${depth}"
              data-file-tree-key=${node.key}
              data-file-tree-kind=${node.kind}
              data-file-tree-path=${node.path || nothing}
              data-file-tree-status=${status.code || nothing}
              data-file-tree-status-tone=${status.code ? status.tone : nothing}
              data-file-tree-relative-path=${node.treePath || nothing}
              data-variant=${node.variant || nothing}
              ?data-hidden-entry=${Boolean(node.hidden)}
              ?data-ignored-entry=${Boolean(node.ignored)}
              ?disabled=${Boolean(node.disabled)}
              title=${node.title ?? ""}
              aria-label=${
                this.statusColumn && status.code
                  ? `${status.label}. ${ariaLabel}`
                  : ariaLabel
              }
              role=${listbox ? "option" : nothing}
              id=${listbox ? optionId(this, node.key) : nothing}
              tabindex=${listbox ? "-1" : nothing}
              aria-selected=${listbox ? `${selected}` : nothing}
              aria-expanded=${
                !listbox && node.kind === "directory" && expandable
                  ? `${expanded}`
                  : nothing
              }
              aria-current=${
                listbox || (node.kind === "directory" && expandable)
                  ? nothing
                  : node.selection === false
                    ? "false"
                    : `${selected}`
              }
              @click=${(event: Event) =>
                this.choose(node.key, event.currentTarget as HTMLElement)}
            >${guides}
              <span
                class="file-tree-status-code"
                aria-hidden="true"
              >${status.code}</span>
              <span class="file-tree-node-label">
                <span
                  ${drawn(this.iconsByKey.of(node.key))}
                  class="file-tree-icon"
                >${entryIcon({
                  name: node.name ?? "",
                  path: node.path ?? node.key,
                  kind: node.kind,
                  isSymlink: Boolean(node.isSymlink),
                  supported: node.supported !== false,
                  git: node.git,
                  expanded,
                })}</span>
                <span class="file-tree-name">${node.name ?? ""}</span>
              </span>
            </button></li>`;
          },
        )}</ol>
      </div>
    `;
  }

  updated(changed: PropertyValues) {
    if (changed.has("statusColumn")) {
      this.dataset.statusColumn = this.statusColumn ? "true" : "false";
    }
  }

  setModel(model: FileTreeModel = {}) {
    const entityKey = `${model.entityKey ?? ""}`;
    const nodes = Array.isArray(model.nodes) ? model.nodes : [];
    const index = indexNodes(nodes);
    const sameEntity = this.entityKey === entityKey;
    const explicitExpandedKeys = new Set(model.expandedKeys ?? []);

    if (!sameEntity) {
      this.expandedKeys = new Set([
        ...defaultExpandedKeys(index.nodeByKey),
        ...explicitExpandedKeys,
      ]);
    } else {
      const previousDirectoryKeys = this.knownDirectoryKeys;
      const expandedKeys = new Set(
        [...this.expandedKeys].filter((key) => index.directoryKeys.has(key)),
      );
      if (model.expandNewDirectories !== false) {
        for (const key of defaultExpandedKeys(index.nodeByKey)) {
          if (!previousDirectoryKeys.has(key)) {
            expandedKeys.add(key);
          }
        }
      }
      for (const key of explicitExpandedKeys) {
        if (index.directoryKeys.has(key)) {
          expandedKeys.add(key);
        }
      }
      this.expandedKeys = expandedKeys;
    }

    this.entityKey = entityKey;
    this.nodes = nodes;
    this.nodeByKey = index.nodeByKey;
    this.knownDirectoryKeys = index.directoryKeys;
    this.selectedKey = `${model.selectedKey ?? ""}`;
    this.hiddenEntriesLast = Boolean(model.hiddenEntriesLast);
    this.listboxLabel = `${model.listboxLabel ?? ""}`;
    this.statusColumn = Boolean(model.statusColumn);
    this.performUpdate();
    this.finishPendingReveal();
  }

  setSelectedKey(key: string | null | undefined) {
    this.selectedKey = `${key ?? ""}`;
    this.performUpdate();
  }

  focusFirstEntry() {
    const first = this.visibleRows().find(
      ({ node }) =>
        node.kind !== "group" && node.kind !== "status" && !node.disabled,
    );
    this.entriesByKey.get(first?.key ?? "")?.focus({ preventScroll: true });
  }

  expandKeys(keys: Iterable<string> | null | undefined) {
    const added = [...(keys ?? [])].filter(
      (key) => this.knownDirectoryKeys.has(key) && !this.expandedKeys.has(key),
    );
    if (added.length) {
      this.expandedKeys = new Set([...this.expandedKeys, ...added]);
      this.performUpdate();
    }
  }

  isExpanded(key: string | null | undefined) {
    return this.expandedKeys.has(`${key ?? ""}`);
  }

  hasKey(key: string | null | undefined) {
    return this.nodeByKey.has(`${key ?? ""}`);
  }

  optionIdForKey(key: string | null | undefined) {
    return this.listboxLabel && this.rowForKey(key)
      ? optionId(this, `${key ?? ""}`)
      : "";
  }

  captureScroll() {
    const scroller = this.scroller();
    return scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
  }

  restoreScroll(scroll: { top: number; left: number } | null | undefined) {
    if (!scroll) {
      return;
    }
    requestAnimationFrame(() => {
      const scroller = this.scroller();
      if (scroller) {
        scroller.scrollTop = scroll.top;
        scroller.scrollLeft = scroll.left;
      }
    });
  }

  scrollToTop() {
    const scroller = this.scroller();
    if (scroller) {
      scrollBackToTop(scroller);
    }
  }

  async revealKey(key: string) {
    await nextAnimationFrame();
    const row = this.rowForKey(key);
    const scroller = this.scroller();
    if (!row || !scroller) {
      return false;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - rowRect.top;
    } else if (rowRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += rowRect.bottom - scrollerRect.bottom;
    }
    return true;
  }

  scroller() {
    return this.scrollport.value ?? null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  scrollSurfaceScope({ label = "Files", ...pull }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  private visibleRows() {
    return visibleRows(
      this.nodes,
      this.expandedKeys,
      this.fileSortMode(),
      this.hiddenEntriesLast,
    );
  }

  private fileSortMode() {
    const override = this.getAttribute("file-sort-mode");
    return normalizeFileSortMode(override ?? this.globalFileSortMode);
  }

  private choose(key: string, button: HTMLElement) {
    const node = this.nodeByKey.get(key);
    if (!node) {
      return;
    }
    if (node.kind === "directory" && isExpandable(node)) {
      this.toggleDirectory(node, button);
      return;
    }
    if (node.selectable === false) {
      return;
    }

    if (node.selection !== false) {
      this.setSelectedKey(node.key);
    }
    this.dispatchEvent(
      new CustomEvent<FileTreeSelectDetail>(FILE_TREE_SELECT_EVENT, {
        bubbles: true,
        detail: { key: node.key, path: node.path ?? "", node },
      }),
    );
  }

  private toggleDirectory(node: FileTreeNode, button: HTMLElement) {
    const anchor = { key: node.key, top: button.getBoundingClientRect().top };
    const expandedKeys = new Set(this.expandedKeys);
    const expanded = !expandedKeys.has(node.key);
    if (expanded) {
      expandedKeys.add(node.key);
      this.pendingRevealKey = node.key;
    } else {
      expandedKeys.delete(node.key);
      if (this.pendingRevealKey === node.key) {
        this.pendingRevealKey = null;
      }
    }
    this.expandedKeys = expandedKeys;
    this.performUpdate();
    requestAnimationFrame(() => {
      const scroller = this.scroller();
      const row = this.rowForKey(anchor.key);
      if (scroller && row) {
        scroller.scrollTop += row.getBoundingClientRect().top - anchor.top;
      }
    });
    const childStatus = childState(node).status;
    if (expanded && (childStatus === "unloaded" || childStatus === "error")) {
      this.dispatchEvent(
        new CustomEvent(FILE_TREE_LOAD_EVENT, {
          bubbles: true,
          detail: { key: node.key, path: node.path ?? "" },
        }),
      );
    }
    this.finishPendingReveal();
  }

  private finishPendingReveal() {
    const parentKey = this.pendingRevealKey;
    if (!parentKey || !this.expandedKeys.has(parentKey)) {
      return;
    }
    const children = childState(this.nodeByKey.get(parentKey));
    if (children.status !== "ready" || children.nodes.length === 0) {
      return;
    }
    this.pendingRevealKey = null;
    requestAnimationFrame(() => this.revealFirstChildIfHidden(parentKey));
  }

  private revealFirstChildIfHidden(parentKey: string) {
    const scroller = this.scroller();
    const firstChild = this.visibleRows().find(
      (row) => row.parentKey === parentKey,
    );
    const child = this.rowsByKey.get(firstChild?.key ?? "");
    if (!scroller || !child) {
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const childRect = child.getBoundingClientRect();
    const visibleTop = Math.max(scrollerRect.top, childRect.top);
    const visibleBottom = Math.min(scrollerRect.bottom, childRect.bottom);
    if (visibleBottom > visibleTop) {
      return;
    }
    if (childRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += childRect.bottom - scrollerRect.bottom;
    } else if (childRect.top < scrollerRect.top) {
      scroller.scrollTop += childRect.top - scrollerRect.top;
    }
  }

  private rowForKey(key: string | null | undefined) {
    return this.rowsByKey.get(`${key ?? ""}`);
  }
}

customElements.define("caffold-file-tree", CaffoldFileTree);

export function buildFileTreeNodes(
  leaves: Iterable<FileTreeNode> | null | undefined,
  options: { namespace?: string; expandedByDefault?: boolean } = {},
) {
  interface BuiltDirectory extends FileTreeNode {
    childMap: Map<string, BuiltDirectory | FileTreeNode>;
  }
  const namespace = `${options.namespace ?? "tree"}`;
  const root = { childMap: new Map<string, BuiltDirectory | FileTreeNode>() };

  for (const candidate of leaves ?? []) {
    const treePath = cleanTreePath(candidate.treePath ?? candidate.path);
    const parts = treePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let parent: { childMap: Map<string, BuiltDirectory | FileTreeNode> } = root;
    let directoryPath = "";
    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      const mapKey = `directory:${part}`;
      let directory = parent.childMap.get(mapKey) as BuiltDirectory | undefined;
      if (!directory) {
        directory = {
          key: `${namespace}:directory:${directoryPath}`,
          kind: "directory",
          name: part,
          path: directoryPath,
          expandedByDefault: options.expandedByDefault !== false,
          childMap: new Map(),
        };
        parent.childMap.set(mapKey, directory);
      }
      parent = directory;
    }
    const name = candidate.name ?? parts.at(-1) ?? treePath;
    parent.childMap.set(`file:${candidate.key}`, {
      ...candidate,
      name,
      treePath,
    });
  }

  const finalize = (
    children: Map<string, BuiltDirectory | FileTreeNode>,
  ): FileTreeNode[] =>
    [...children.values()].map((node) => {
      if (!("childMap" in node)) {
        return node;
      }
      const { childMap, ...directory } = node;
      return {
        ...directory,
        children: readyFileTreeChildren(finalize(childMap)),
      };
    });
  return finalize(root.childMap);
}

export function readyFileTreeChildren(
  nodes: FileTreeNode[] | null | undefined,
): FileTreeChildren {
  return { status: "ready", nodes: nodes ?? [] };
}

export function unloadedFileTreeChildren(): FileTreeChildren {
  return { status: "unloaded" };
}

export function loadingFileTreeChildren(
  message = "Loading...",
): FileTreeChildren {
  return { status: "loading", message };
}

export function errorFileTreeChildren(
  message: string | null | undefined,
): FileTreeChildren {
  return {
    status: "error",
    message: `${message ?? "Unable to load directory."}`,
  };
}

function indexNodes(nodes: FileTreeNode[]) {
  const nodeByKey = new Map<string, FileTreeNode>();
  const directoryKeys = new Set<string>();

  const visit = (items: FileTreeNode[] | undefined) => {
    for (const node of items ?? []) {
      if (!node?.key) {
        continue;
      }
      nodeByKey.set(node.key, node);
      if (node.kind === "directory") {
        directoryKeys.add(node.key);
      }
      const children = childState(node);
      if (children.status === "ready") {
        visit(children.nodes);
      }
    }
  };
  visit(nodes);
  return { nodeByKey, directoryKeys };
}

function defaultExpandedKeys(nodeByKey: Map<string, FileTreeNode>) {
  return [...nodeByKey.values()]
    .filter((node) => node.kind === "directory" && node.expandedByDefault)
    .map((node) => node.key);
}

function visibleRows(
  nodes: FileTreeNode[],
  expandedKeys: Set<string>,
  fileSortMode: FileSortMode,
  hiddenEntriesLast: boolean,
) {
  const rows: TreeRow[] = [];
  const visit = (
    items: FileTreeNode[],
    depth = 0,
    parentKey = "",
    passingGuideDepths: number[] = [],
  ) => {
    const siblings = sortedNodes(items, fileSortMode, hiddenEntriesLast);
    for (const [index, node] of siblings.entries()) {
      if (node.kind === "group") {
        rows.push({
          key: node.key,
          node,
          depth: 0,
          parentKey: "",
          passingGuideDepths: [],
          firstSibling: false,
          lastSibling: false,
        });
        const children = childState(node);
        if (children.status === "ready") {
          visit(children.nodes, 0, "");
        }
        continue;
      }
      const firstSibling = index === 0;
      const lastSibling = index === siblings.length - 1;
      rows.push({
        key: node.key,
        node,
        depth,
        parentKey,
        passingGuideDepths,
        firstSibling,
        lastSibling,
      });
      if (node.kind !== "directory" || !expandedKeys.has(node.key)) {
        continue;
      }
      const childGuideDepths =
        depth > 0 && !lastSibling
          ? [...passingGuideDepths, depth - 1]
          : passingGuideDepths;
      const children = childState(node);
      if (children.status === "ready") {
        visit(children.nodes, depth + 1, node.key, childGuideDepths);
      } else if (children.status === "loading" || children.status === "error") {
        const key = `${node.key}:children-state`;
        rows.push({
          key,
          node: {
            key,
            kind: "status",
            name:
              children.message ??
              (children.status === "loading"
                ? "Loading..."
                : "Unable to load directory."),
            tone: children.status === "error" ? "error" : "muted",
            loading: children.status === "loading",
          },
          depth: depth + 1,
          parentKey: node.key,
          passingGuideDepths: childGuideDepths,
          firstSibling: true,
          lastSibling: true,
        });
      }
    }
  };
  visit(nodes);
  return rows;
}

function sortedNodes(
  nodes: FileTreeNode[] | undefined,
  fileSortMode: FileSortMode,
  hiddenEntriesLast = false,
) {
  return [...(nodes ?? [])].sort((left, right) => {
    if (left.variant === "parent" || right.variant === "parent") {
      return left.variant === right.variant
        ? 0
        : left.variant === "parent"
          ? -1
          : 1;
    }
    if (left.kind === "group" || right.kind === "group") {
      return (left.order ?? 0) - (right.order ?? 0);
    }
    if (fileSortMode !== FILE_SORT_MODES.NAME && left.kind !== right.kind) {
      return left.kind === "directory"
        ? -1
        : right.kind === "directory"
          ? 1
          : 0;
    }
    if (hiddenEntriesLast && Boolean(left.hidden) !== Boolean(right.hidden)) {
      return left.hidden ? 1 : -1;
    }
    const nameOrder = compareNamesIgnoringCase(left.name, right.name);
    if (nameOrder !== 0 || fileSortMode !== FILE_SORT_MODES.NAME) {
      return nameOrder;
    }
    return (
      compareCodePoints(left.name, right.name) ||
      compareCodePoints(left.path, right.path) ||
      compareCodePoints(left.key, right.key)
    );
  });
}

function compareNamesIgnoringCase(
  left: string | undefined,
  right: string | undefined,
) {
  return `${left ?? ""}`
    .toLocaleLowerCase()
    .localeCompare(`${right ?? ""}`.toLocaleLowerCase());
}

function compareCodePoints(
  left: string | undefined,
  right: string | undefined,
) {
  const leftText = `${left ?? ""}`;
  const rightText = `${right ?? ""}`;
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function childState(node: FileTreeNode | undefined): FileTreeChildren {
  if (Array.isArray(node?.children)) {
    return readyFileTreeChildren(node.children);
  }
  if (node?.children?.status) {
    return node.children;
  }
  return { status: "none", nodes: [] };
}

function isExpandable(node: FileTreeNode | undefined) {
  return node?.kind === "directory" && childState(node).status !== "none";
}

function defaultAriaLabel(node: FileTreeNode, expanded: boolean) {
  if (node.kind === "directory" && isExpandable(node)) {
    return `${expanded ? "Collapse" : "Expand"} ${node.name ?? ""}`;
  }
  return node.name ?? "";
}

function cleanTreePath(path: string | undefined) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function optionId(tree: Element, key: string) {
  return `${tree.id || "file-tree"}-option-${encodeURIComponent(key)}`;
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
