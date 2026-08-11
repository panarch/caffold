import {
  buildFileTreeNodes,
  FILE_TREE_SELECT_EVENT,
} from "../file-tree.js";

class CaffoldGitCompareTree extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.addEventListener("change", (event) => {
      const select = event.target.closest?.("select[data-compare-base-ref]");
      if (!select || !this.contains(select)) {
        return;
      }
      const baseRef = `${select.value ?? ""}`;
      if (!baseRef || baseRef === this.baseSelection?.value) {
        return;
      }
      this.baseSelection = { ...this.baseSelection, value: baseRef };
      this.patchBasePresentation(baseRef);
      this.dispatchEvent(
        new CustomEvent("caffold:select-compare-base", {
          bubbles: true,
          composed: true,
          detail: { baseRef },
        }),
      );
    });
    this.addEventListener(FILE_TREE_SELECT_EVENT, (event) => {
      const file = event.detail.node.source;
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
    });
    if (!this.state) {
      this.reset();
    }
  }

  setLoading(repository, comparison = {}) {
    this.state = {
      status: "loading",
      repository,
      baseRef: `${comparison.baseRef ?? ""}`,
      headRef: `${comparison.headRef ?? ""}`,
    };
    this.renderState();
  }

  setCompare(comparePayload) {
    this.state = { status: "ready", comparePayload };
    this.renderState();
  }

  updateCompare(comparePayload) {
    this.state = { status: "ready", comparePayload };
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

  setBaseSelection(selection = {}) {
    const refs = normalizeRefs(selection.refs);
    const refsKey = refsFingerprint(refs);
    this.baseSelection = {
      enabled: refs.length > 0,
      refs,
      value: `${selection.value ?? ""}`,
    };
    this.ensurePanel();
    if (refsKey !== this.baseRefsKey) {
      this.baseRefsKey = refsKey;
      replaceRefOptions(this.baseRefSelect(), refs);
    }
    this.patchHeader(this.headerPayload(), this.headerFileCount());
  }

  setEmptyMessage(message) {
    this.emptyMessage = message || "No files changed.";
    if (this.state?.status === "ready" && !this.state.comparePayload.files?.length) {
      this.renderState();
    }
  }

  reset() {
    this.selectedPath = "";
    this.baseSelection = { enabled: false, refs: [], value: "" };
    this.baseRefsKey = "";
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

  renderState() {
    const state = this.state ?? { status: "idle" };
    const ready = state.status === "ready";
    const payload = ready ? state.comparePayload : state;
    const files = ready ? payload.files ?? [] : [];
    const message =
      state.status === "loading"
        ? "Loading compare..."
        : state.status === "error"
          ? state.error.message
          : ready && files.length === 0
            ? this.emptyMessage || "No files changed."
            : "";
    const panel = this.ensurePanel(message ? "message" : "tree");
    panel.classList.toggle("error-panel", state.status === "error");
    panel.toggleAttribute("aria-busy", state.status === "loading");
    this.patchHeader(payload, ready ? files.length : null);
    if (message) {
      patchText(this.message(), message);
      return;
    }

    if (!ready) {
      return;
    }

    const { nodes, fileKeyByPath } = compareNodes(files);
    this.fileKeyByPath = fileKeyByPath;
    this.fileTree().setModel({
      entityKey: compareEntityKey(payload),
      nodes,
      selectedKey: this.selectedKey(),
      statusColumn: true,
    });
  }

  ensurePanel(content = null) {
    let panel = this.querySelector(":scope > .compare-tree-panel");
    if (!panel) {
      this.innerHTML = `
        <section class="compare-tree-panel" data-content="tree">
          <header>
            <div class="compare-tree-primary">
              <h2>Files</h2>
              <span class="compare-base">
                <span class="compare-base-label"></span>
                <span class="compare-base-chevron" aria-hidden="true" hidden></span>
                <select data-compare-base-ref aria-label="Branch comparison base" hidden></select>
              </span>
            </div>
            <div class="compare-tree-secondary">
              <span class="compare-file-count"></span>
              <span class="compare-line-stats" hidden>
                <span class="is-addition"></span>
                <span class="is-deletion"></span>
              </span>
            </div>
          </header>
          <caffold-file-tree class="compare-tree-content"></caffold-file-tree>
        </section>
      `;
      panel = this.querySelector(":scope > .compare-tree-panel");
    }
    if (content && panel.dataset.content !== content) {
      const next = document.createElement(content === "message" ? "p" : "caffold-file-tree");
      next.className =
        content === "message"
          ? "surface-message compare-tree-content"
          : "compare-tree-content";
      panel.querySelector(":scope > .compare-tree-content")?.replaceWith(next);
      panel.dataset.content = content;
    }
    return panel;
  }

  patchHeader(payload, count) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;
    const baseRef = this.baseSelection?.enabled
      ? this.baseSelection.value
      : `${payload?.baseRef ?? ""}`;
    patchText(this.querySelector(".compare-file-count"), countLabel);
    this.patchBasePresentation(baseRef);
    this.patchDiffStats(payload);
  }

  patchBasePresentation(baseRef) {
    const enabled = Boolean(this.baseSelection?.enabled);
    const label = this.querySelector(".compare-base-label");
    const base = this.querySelector(".compare-base");
    const chevron = this.querySelector(".compare-base-chevron");
    const select = this.baseRefSelect();
    const text = baseRef ? `vs ${compareRefLabel(baseRef)}` : "";
    patchText(label, text);
    setAttribute(base, "title", baseRef ? `Compare with ${baseRef}` : null);
    chevron?.toggleAttribute("hidden", !enabled);
    select?.toggleAttribute("hidden", !enabled);
    setAttribute(select, "title", enabled && baseRef ? baseRef : null);
    if (enabled && select && select.value !== baseRef) {
      select.value = baseRef;
    }
  }

  patchDiffStats(payload) {
    const stats = diffStats(payload);
    const container = this.querySelector(".compare-line-stats");
    container?.toggleAttribute("hidden", !stats);
    setAttribute(container, "aria-label", stats?.label ?? null);
    patchText(container?.querySelector(".is-addition"), stats?.additions ?? "");
    patchText(container?.querySelector(".is-deletion"), stats?.deletions ?? "");
  }

  headerPayload() {
    return this.state?.status === "ready" ? this.state.comparePayload : this.state;
  }

  headerFileCount() {
    return this.state?.status === "ready"
      ? (this.state.comparePayload?.files?.length ?? 0)
      : null;
  }

  baseRefSelect() {
    return this.querySelector("select[data-compare-base-ref]");
  }

  message() {
    return this.querySelector(":scope > .compare-tree-panel > .surface-message");
  }
}

customElements.define("caffold-git-compare-tree", CaffoldGitCompareTree);

function diffStats(payload) {
  if (!Number.isFinite(payload?.additions) || !Number.isFinite(payload?.deletions)) {
    return null;
  }
  const additions = new Intl.NumberFormat("en-US").format(payload.additions);
  const deletions = new Intl.NumberFormat("en-US").format(payload.deletions);
  return {
    label: `${additions} additions and ${deletions} deletions`,
    additions: `+${additions}`,
    deletions: `-${deletions}`,
  };
}

function compareRefLabel(ref) {
  return `${ref ?? ""}`.replace(/^origin\//, "");
}

function normalizeRefs(refs) {
  return (Array.isArray(refs) ? refs : [])
    .map((ref) => ({
      name: `${ref?.name ?? ""}`,
      kind: `${ref?.kind ?? "local"}`,
    }))
    .filter((ref) => ref.name);
}

function refsFingerprint(refs) {
  return refs.map((ref) => `${ref.kind}\u0000${ref.name}`).join("\u0001");
}

function replaceRefOptions(select, refs) {
  if (!select) {
    return;
  }
  const groups = [];
  let group = null;
  let previousKind = null;
  for (const ref of refs) {
    if (ref.kind !== previousKind) {
      group = document.createElement("optgroup");
      group.label = refKindLabel(ref.kind);
      groups.push(group);
      previousKind = ref.kind;
    }
    const option = document.createElement("option");
    option.value = ref.name;
    option.textContent = ref.name;
    group.append(option);
  }
  select.replaceChildren(...groups);
}

function refKindLabel(kind) {
  if (kind === "head") {
    return "Current";
  }
  return kind === "remote" ? "Remote" : "Local";
}

function patchText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

function setAttribute(element, name, value) {
  if (!element) {
    return;
  }
  if (value === null || value === undefined || value === "") {
    if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
    return;
  }
  if (element.getAttribute(name) !== `${value}`) {
    element.setAttribute(name, `${value}`);
  }
}

function compareNodes(files) {
  const fileKeyByPath = new Map();
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

function compareEntityKey(payload) {
  return [
    payload?.repository?.rootPath ??
      payload?.repository?.root ??
      payload?.repository?.path ??
      "",
    payload?.baseRef ?? "",
    payload?.headRef ?? "",
  ].join("\u0000");
}
