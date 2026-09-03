import { renderEntryIcon, warmIcons } from "./icons.js";
import {
  buttonActionHintTarget,
  disclosureActionHintTarget,
  emptyActionHintScope,
} from "../action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import { fileStatusPresentation } from "../file-status.js";
import {
  FILE_SORT_MODES,
  getSettings,
  normalizeFileSortMode,
} from "../settings.js";

export const FILE_TREE_SELECT_EVENT = "caffold:file-tree-select";
export const FILE_TREE_LOAD_EVENT = "caffold:file-tree-load-children";

class CaffoldFileTree extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachIconListener();
    this.attachSettingsListener();
    warmIcons();
  }

  disconnectedCallback() {
    if (this.iconsReadyListening) {
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
      this.iconsReadyListening = false;
    }
    if (this.settingsListening) {
      window.removeEventListener(
        "caffold:settings-change",
        this.boundSettingsChange,
      );
      this.settingsListening = false;
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.entityKey = null;
    this.nodes = [];
    this.nodeByKey = new Map();
    this.expandedKeys = new Set();
    this.knownDirectoryKeys = new Set();
    this.selectedKey = "";
    this.globalFileSortMode = getSettings().fileSortMode;
    this.innerHTML = `
      <div class="file-tree-scroll">
        <ol class="file-tree-rows"></ol>
      </div>
    `;
    this.addEventListener("click", (event) => this.handleClick(event));
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.patchVisibleIcons();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  attachSettingsListener() {
    const previousMode = this.fileSortMode();
    this.globalFileSortMode = normalizeFileSortMode(getSettings().fileSortMode);
    this.boundSettingsChange ??= (event) => {
      const previous = this.fileSortMode();
      this.globalFileSortMode = normalizeFileSortMode(
        event.detail?.settings?.fileSortMode,
      );
      if (previous !== this.fileSortMode()) {
        this.reconcileRows();
      }
    };
    if (!this.settingsListening) {
      window.addEventListener(
        "caffold:settings-change",
        this.boundSettingsChange,
      );
      this.settingsListening = true;
    }
    if (previousMode !== this.fileSortMode()) {
      this.reconcileRows();
    }
  }

  fileSortMode() {
    const override = this.getAttribute("file-sort-mode");
    return normalizeFileSortMode(override ?? this.globalFileSortMode);
  }

  setModel(model = {}) {
    this.ensureRendered();
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
      this.expandedKeys = new Set(
        [...this.expandedKeys].filter((key) => index.directoryKeys.has(key)),
      );
      if (model.expandNewDirectories !== false) {
        for (const key of defaultExpandedKeys(index.nodeByKey)) {
          if (!previousDirectoryKeys.has(key)) {
            this.expandedKeys.add(key);
          }
        }
      }
      for (const key of explicitExpandedKeys) {
        if (index.directoryKeys.has(key)) {
          this.expandedKeys.add(key);
        }
      }
    }

    this.entityKey = entityKey;
    this.nodes = nodes;
    this.nodeByKey = index.nodeByKey;
    this.knownDirectoryKeys = index.directoryKeys;
    this.selectedKey = `${model.selectedKey ?? ""}`;
    this.dataset.statusColumn = model.statusColumn ? "true" : "false";
    this.reconcileRows();
    this.finishPendingReveal();
  }

  setSelectedKey(key) {
    this.ensureRendered();
    const nextKey = `${key ?? ""}`;
    if (this.selectedKey === nextKey) {
      return;
    }

    const previousKey = this.selectedKey;
    this.selectedKey = nextKey;
    this.patchSelection(previousKey);
    this.patchSelection(nextKey);
  }

  expandKeys(keys) {
    this.ensureRendered();
    let changed = false;
    for (const key of keys ?? []) {
      if (this.knownDirectoryKeys.has(key) && !this.expandedKeys.has(key)) {
        this.expandedKeys.add(key);
        changed = true;
      }
    }
    if (changed) {
      this.reconcileRows();
    }
  }

  isExpanded(key) {
    return this.expandedKeys.has(`${key ?? ""}`);
  }

  hasKey(key) {
    return this.nodeByKey.has(`${key ?? ""}`);
  }

  captureScroll() {
    const scroller = this.scroller();
    return scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
  }

  restoreScroll(scroll) {
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

  async revealKey(key) {
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
    return this.querySelector(":scope > .file-tree-scroll");
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    disclosureActionId = "",
    clipRoots = [],
    isCurrent = () => false,
    includeDirectories = false,
    labelForNode = (node) => node.ariaLabel ?? node.title ?? node.name ?? "Open file",
  } = {}) {
    this.ensureRendered();
    const scroller = this.scroller();
    if (
      !scopeId ||
      (!actionId && !disclosureActionId) ||
      !scroller ||
      this.hidden
    ) {
      return emptyActionHintScope();
    }
    const entityKey = this.entityKey;
    const targets = [...this.querySelectorAll(
      ":scope > .file-tree-scroll > .file-tree-rows > .file-tree-row > button[data-file-tree-key]",
    )].flatMap((control) => {
      const key = `${control.dataset.fileTreeKey ?? ""}`;
      const node = this.nodeByKey.get(key);
      if (!key || !node || control.disabled) {
        return [];
      }
      if (isExpandable(node)) {
        if (!disclosureActionId) {
          return [];
        }
        const anchor = control.querySelector(
          ":scope > .file-tree-node-label > .file-tree-icon",
        );
        if (!anchor) {
          return [];
        }
        const expanded = this.expandedKeys?.has(key) ??
          control.getAttribute?.("aria-expanded") === "true";
        return [disclosureActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:disclosure:${encodeURIComponent(key)}`,
          actionId: disclosureActionId,
          label: defaultAriaLabel(node, expanded),
          control,
          anchor,
          clipRoots: uniqueElements([...clipRoots, scroller]),
          isActionable: () => {
            const current = this.nodeByKey.get(key);
            return Boolean(
              this.isConnected &&
                !this.hidden &&
                this.entityKey === entityKey &&
                current &&
                isExpandable(current) &&
                this.rowForKey(key)?.querySelector(
                  ":scope > button[data-file-tree-key]",
                ) === control &&
                control.querySelector(
                  ":scope > .file-tree-node-label > .file-tree-icon",
                ) === anchor &&
                !control.disabled,
            );
          },
        })];
      }
      if (
        !actionId ||
        (node.kind === "directory" && !includeDirectories) ||
        node.selectable === false ||
        isCurrent(node)
      ) {
        return [];
      }
      const anchor = control.querySelector(
        ":scope > .file-tree-node-label > .file-tree-icon",
      );
      if (!anchor) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:file:${encodeURIComponent(key)}`,
        actionId,
        label: `${labelForNode(node) ?? ""}` || `${node.name ?? key}`,
        control,
        anchor,
        clipRoots: uniqueElements([...clipRoots, scroller]),
        isActionable: () => {
          const current = this.nodeByKey.get(key);
          return Boolean(
            this.isConnected &&
              !this.hidden &&
              this.entityKey === entityKey &&
              current &&
              (
                current.kind !== "directory" ||
                (includeDirectories && !isExpandable(current))
              ) &&
              current.selectable !== false &&
              !isCurrent(current) &&
              this.rowForKey(key)?.querySelector(
                ":scope > button[data-file-tree-key]",
              ) === control &&
              control.querySelector(
                ":scope > .file-tree-node-label > .file-tree-icon",
              ) === anchor &&
              !control.disabled,
          );
        },
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scroller],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Files",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    this.ensureRendered();
    const scrollport = this.scroller();
    if (!scopeId || !label || !scrollport || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        axes: ["vertical", "horizontal"],
        clipRoots: uniqueElements([this, scrollport, ...clipRoots]),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.scroller() === scrollport &&
          isCurrent() &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  rows() {
    return this.querySelector(":scope > .file-tree-scroll > .file-tree-rows");
  }

  handleClick(event) {
    const button = event.target.closest("button[data-file-tree-key]");
    if (!button || button.disabled || !this.contains(button)) {
      return;
    }

    const node = this.nodeByKey.get(button.dataset.fileTreeKey);
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
      new CustomEvent(FILE_TREE_SELECT_EVENT, {
        bubbles: true,
        detail: { key: node.key, path: node.path ?? "", node },
      }),
    );
  }

  toggleDirectory(node, button) {
    const anchor = this.captureScrollAnchor(button);
    const expanded = !this.expandedKeys.has(node.key);
    if (expanded) {
      this.expandedKeys.add(node.key);
      this.pendingRevealKey = node.key;
    } else {
      this.expandedKeys.delete(node.key);
      if (this.pendingRevealKey === node.key) {
        this.pendingRevealKey = null;
      }
    }

    this.reconcileRows();
    this.restoreScrollAnchor(anchor);
    if (
      expanded &&
      ["unloaded", "error"].includes(childState(node).status)
    ) {
      this.dispatchEvent(
        new CustomEvent(FILE_TREE_LOAD_EVENT, {
          bubbles: true,
          detail: { key: node.key, path: node.path ?? "" },
        }),
      );
    }
    this.finishPendingReveal();
  }

  captureScrollAnchor(button) {
    const scroller = this.scroller();
    if (!button || !scroller) {
      return null;
    }
    return {
      key: button.dataset.fileTreeKey,
      top: button.getBoundingClientRect().top,
    };
  }

  restoreScrollAnchor(anchor) {
    if (!anchor) {
      return;
    }
    requestAnimationFrame(() => {
      const scroller = this.scroller();
      const row = this.rowForKey(anchor.key);
      if (!scroller || !row) {
        return;
      }
      scroller.scrollTop += row.getBoundingClientRect().top - anchor.top;
    });
  }

  finishPendingReveal() {
    const parentKey = this.pendingRevealKey;
    if (!parentKey || !this.expandedKeys.has(parentKey)) {
      return;
    }
    const parent = this.nodeByKey.get(parentKey);
    const children = childState(parent);
    if (children.status !== "ready" || children.nodes.length === 0) {
      return;
    }
    this.pendingRevealKey = null;
    requestAnimationFrame(() => this.revealFirstChildIfHidden(parentKey));
  }

  revealFirstChildIfHidden(parentKey) {
    const scroller = this.scroller();
    const child = this.rows()?.querySelector(
      `:scope > li[data-file-tree-parent-key="${CSS.escape(parentKey)}"]`,
    );
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

  reconcileRows() {
    const list = this.rows();
    if (!list) {
      return;
    }
    const rows = visibleRows(
      this.nodes,
      this.expandedKeys,
      this.fileSortMode(),
    );
    const currentRows = new Map(
      Array.from(list.children).map((row) => [row.dataset.fileTreeRowKey, row]),
    );
    const retained = new Set();
    let cursor = list.firstElementChild;

    for (const descriptor of rows) {
      let row = currentRows.get(descriptor.key);
      if (!row) {
        row = document.createElement("li");
      }
      retained.add(descriptor.key);
      this.patchRow(row, descriptor);
      if (row !== cursor) {
        list.insertBefore(row, cursor);
      }
      cursor = row.nextElementSibling;
    }

    for (const [key, row] of currentRows) {
      if (!retained.has(key)) {
        row.remove();
      }
    }
  }

  patchRow(row, descriptor) {
    const { node, depth, parentKey } = descriptor;
    row.dataset.fileTreeRowKey = descriptor.key;
    if (parentKey) {
      row.dataset.fileTreeParentKey = parentKey;
    } else {
      delete row.dataset.fileTreeParentKey;
    }

    if (node.kind === "group") {
      row.className = "file-tree-group";
      row.textContent = node.name ?? "";
      return;
    }
    if (node.kind === "status") {
      row.className = `file-tree-status${node.tone === "error" ? " is-error" : ""}`;
      row.style.setProperty("--tree-depth", depth);
      row.textContent = node.name ?? "";
      return;
    }

    row.className = "file-tree-row";
    let button = row.querySelector(":scope > button.file-tree-entry");
    if (!button) {
      row.replaceChildren(createEntryButton());
      button = row.firstElementChild;
    }
    this.patchEntryButton(button, node, depth);
  }

  patchEntryButton(button, node, depth) {
    const expanded = node.kind === "directory" && this.expandedKeys.has(node.key);
    const status = fileStatusPresentation(node.status, node.statusContext);
    const statusVisible = this.dataset.statusColumn === "true" && Boolean(status.code);
    button.className = `file-tree-entry file-tree-${node.kind}`;
    button.style.setProperty("--tree-depth", depth);
    button.dataset.fileTreeKey = node.key;
    button.dataset.fileTreeKind = node.kind;
    if (node.path) {
      button.dataset.fileTreePath = node.path;
    } else {
      delete button.dataset.fileTreePath;
    }
    if (status.code) {
      button.dataset.fileTreeStatus = status.code;
      button.dataset.fileTreeStatusTone = status.tone;
    } else {
      delete button.dataset.fileTreeStatus;
      delete button.dataset.fileTreeStatusTone;
    }
    if (node.treePath) {
      button.dataset.fileTreeRelativePath = node.treePath;
    } else {
      delete button.dataset.fileTreeRelativePath;
    }
    if (node.variant) {
      button.dataset.variant = node.variant;
    } else {
      delete button.dataset.variant;
    }
    button.toggleAttribute("data-hidden-entry", Boolean(node.hidden));
    button.toggleAttribute("data-ignored-entry", Boolean(node.ignored));
    button.disabled = Boolean(node.disabled);
    button.title = node.title ?? "";
    const ariaLabel = node.ariaLabel ?? defaultAriaLabel(node, expanded);
    button.setAttribute(
      "aria-label",
      statusVisible ? `${status.label}. ${ariaLabel}` : ariaLabel,
    );

    if (node.kind === "directory" && isExpandable(node)) {
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      button.removeAttribute("aria-current");
    } else {
      button.removeAttribute("aria-expanded");
      button.setAttribute(
        "aria-current",
        node.selection === false ? "false" : node.key === this.selectedKey ? "true" : "false",
      );
    }

    button.querySelector(":scope > .file-tree-status-code").textContent = status.code;
    button.querySelector(
      ":scope > .file-tree-node-label > .file-tree-name",
    ).textContent = node.name ?? "";
    this.patchIcon(button, node, expanded);
  }

  patchIcon(button, node, expanded) {
    const signature = [
      node.name,
      node.path,
      node.kind,
      Boolean(node.isSymlink),
      node.supported !== false,
      Boolean(node.git?.isRepoRoot),
      expanded,
    ].join("\u0000");
    const icon = button.querySelector(":scope > .file-tree-node-label > .file-tree-icon");
    if (icon.dataset.iconSignature === signature) {
      return;
    }
    icon.dataset.iconSignature = signature;
    icon.innerHTML = renderEntryIcon({
      name: node.name ?? "",
      path: node.path ?? node.key,
      kind: node.kind,
      isSymlink: Boolean(node.isSymlink),
      supported: node.supported !== false,
      git: node.git,
      expanded,
    });
  }

  patchVisibleIcons() {
    for (const button of this.querySelectorAll("button[data-file-tree-key]")) {
      const node = this.nodeByKey.get(button.dataset.fileTreeKey);
      if (!node) {
        continue;
      }
      const icon = button.querySelector(":scope > .file-tree-node-label > .file-tree-icon");
      delete icon.dataset.iconSignature;
      this.patchIcon(button, node, this.expandedKeys.has(node.key));
    }
  }

  patchSelection(key) {
    if (!key) {
      return;
    }
    const row = this.rowForKey(key);
    const button = row?.querySelector(":scope > button.file-tree-entry");
    const node = this.nodeByKey.get(key);
    if (button && node?.selection !== false && !isExpandable(node)) {
      button.setAttribute("aria-current", key === this.selectedKey ? "true" : "false");
    }
  }

  rowForKey(key) {
    return this.rows()?.querySelector(
      `:scope > li[data-file-tree-row-key="${CSS.escape(`${key ?? ""}`)}"]`,
    );
  }
}

if (!customElements.get("caffold-file-tree")) {
  customElements.define("caffold-file-tree", CaffoldFileTree);
}

export function buildFileTreeNodes(leaves, options = {}) {
  const namespace = `${options.namespace ?? "tree"}`;
  const root = { children: new Map() };

  for (const candidate of leaves ?? []) {
    const treePath = cleanTreePath(candidate.treePath ?? candidate.path);
    const parts = treePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let parent = root;
    let directoryPath = "";
    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      const mapKey = `directory:${part}`;
      let directory = parent.children.get(mapKey);
      if (!directory) {
        directory = {
          key: `${namespace}:directory:${directoryPath}`,
          kind: "directory",
          name: part,
          path: directoryPath,
          expandedByDefault: options.expandedByDefault !== false,
          children: new Map(),
        };
        parent.children.set(mapKey, directory);
      }
      parent = directory;
    }
    const name = candidate.name ?? parts.at(-1) ?? treePath;
    parent.children.set(`file:${candidate.key}`, {
      ...candidate,
      name,
      treePath,
    });
  }

  return finalizeBuiltNodes(root.children);
}

export function readyFileTreeChildren(nodes) {
  return { status: "ready", nodes: nodes ?? [] };
}

export function unloadedFileTreeChildren() {
  return { status: "unloaded" };
}

export function loadingFileTreeChildren(message = "Loading...") {
  return { status: "loading", message };
}

export function errorFileTreeChildren(message) {
  return { status: "error", message: `${message ?? "Unable to load directory."}` };
}

function createEntryButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "file-tree-entry";
  button.innerHTML = `
    <span class="file-tree-status-code" aria-hidden="true"></span>
    <span class="file-tree-node-label">
      <span class="file-tree-icon"></span>
      <span class="file-tree-name"></span>
    </span>
  `;
  return button;
}

function indexNodes(nodes) {
  const nodeByKey = new Map();
  const directoryKeys = new Set();

  const visit = (items) => {
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

function defaultExpandedKeys(nodeByKey) {
  return [...nodeByKey.values()]
    .filter((node) => node.kind === "directory" && node.expandedByDefault)
    .map((node) => node.key);
}

function visibleRows(nodes, expandedKeys, fileSortMode) {
  const rows = [];
  const visit = (items, depth = 0, parentKey = "") => {
    for (const node of sortedNodes(items, fileSortMode)) {
      if (node.kind === "group") {
        rows.push({ key: node.key, node, depth: 0, parentKey: "" });
        const children = childState(node);
        if (children.status === "ready") {
          visit(children.nodes, 0, "");
        }
        continue;
      }
      rows.push({ key: node.key, node, depth, parentKey });
      if (node.kind !== "directory" || !expandedKeys.has(node.key)) {
        continue;
      }
      const children = childState(node);
      if (children.status === "ready") {
        visit(children.nodes, depth + 1, node.key);
      } else if (children.status === "loading" || children.status === "error") {
        rows.push({
          key: `${node.key}:children-state`,
          node: {
            key: `${node.key}:children-state`,
            kind: "status",
            name: children.message ?? (children.status === "loading" ? "Loading..." : "Unable to load directory."),
            tone: children.status === "error" ? "error" : "muted",
          },
          depth: depth + 1,
          parentKey: node.key,
        });
      }
    }
  };
  visit(nodes);
  return rows;
}

function sortedNodes(nodes, fileSortMode) {
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
    if (
      fileSortMode !== FILE_SORT_MODES.NAME &&
      left.kind !== right.kind
    ) {
      return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0;
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

function compareNamesIgnoringCase(left, right) {
  return `${left ?? ""}`
    .toLocaleLowerCase()
    .localeCompare(`${right ?? ""}`.toLocaleLowerCase());
}

function compareCodePoints(left, right) {
  const leftText = `${left ?? ""}`;
  const rightText = `${right ?? ""}`;
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function finalizeBuiltNodes(children) {
  return [...children.values()].map((node) => {
    if (node.kind !== "directory") {
      return node;
    }
    return {
      ...node,
      children: readyFileTreeChildren(finalizeBuiltNodes(node.children)),
    };
  });
}

function childState(node) {
  if (Array.isArray(node?.children)) {
    return readyFileTreeChildren(node.children);
  }
  if (node?.children?.status) {
    return node.children;
  }
  return { status: "none", nodes: [] };
}

function isExpandable(node) {
  return node?.kind === "directory" && childState(node).status !== "none";
}

function defaultAriaLabel(node, expanded) {
  if (node.kind === "directory" && isExpandable(node)) {
    return `${expanded ? "Collapse" : "Expand"} ${node.name ?? ""}`;
  }
  return node.name ?? "";
}

function cleanTreePath(path) {
  return `${path ?? ""}`
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function uniqueElements(elements) {
  return [...new Set(elements.filter(Boolean))];
}
