import { escapeHtml } from "../../../../../../components/dom.js";
import { renderEntryIcon, warmIcons } from "../../../../../../components/icons.js";

class CaffoldGithubPullFilesTree extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-node-key], button[data-pull-file-path]");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.nodeKey) {
        this.toggleDirectory(button.dataset.nodeKey, button);
        return;
      }

      this.setSelectedPath(button.dataset.pullFilePath);
      this.dispatchEvent(
        new CustomEvent("caffold:open-github-pull-file", {
          bubbles: true,
          detail: {
            path: button.dataset.pullFilePath,
            status: button.dataset.pullFileStatus,
          },
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    if (!this.state) {
      this.reset();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setLoading(repository, number = null) {
    this.state = { status: "loading", repository, number };
    this.render();
  }

  setFiles(payload) {
    const tree = buildPullFilesTree(payload.files ?? []);
    this.expandedKeys = new Set(tree.directoryKeys);
    this.state = { status: "ready", payload, tree };
    this.render();
  }

  setError(error, repository = null) {
    this.state = { status: "error", error, repository };
    this.render();
  }

  setSelectedPath(path) {
    const nextPath = path ?? "";
    if (this.selectedPath === nextPath) {
      return;
    }

    this.selectedPath = nextPath;
    this.patchSelectedPath();
  }

  patchSelectedPath() {
    for (const button of this.querySelectorAll('button[data-pull-file-path][aria-current="true"]')) {
      button.setAttribute("aria-current", "false");
    }

    if (!this.selectedPath) {
      return;
    }

    const button = this.querySelector(
      `button[data-pull-file-path="${CSS.escape(this.selectedPath)}"]`,
    );
    if (button) {
      button.setAttribute("aria-current", "true");
    }
  }

  reset() {
    this.selectedPath = "";
    this.expandedKeys = new Set();
    this.state = { status: "idle" };
    this.render();
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="github-pull-files-panel">
          ${this.renderHeader(null)}
          <ol class="github-pull-files-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="github-pull-files-panel" aria-busy="true">
          ${this.renderHeader(null)}
          <p class="surface-message">Loading pull request files...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="github-pull-files-panel error-panel">
          ${this.renderHeader(null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const payload = this.state.payload;
    const files = payload.files ?? [];
    this.innerHTML = `
      <section class="github-pull-files-panel">
        ${this.renderHeader(files.length)}
        ${
          files.length === 0
            ? `<p class="surface-message">No files changed.</p>`
            : `<ol class="github-pull-files-list">${this.renderNodes(this.state.tree.children, 0)}</ol>`
        }
      </section>
    `;
  }

  renderHeader(count) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;

    return `
      <header>
        <div class="github-pull-files-title-row">
          <h2>Files</h2>
          <span class="github-pull-files-count">${escapeHtml(countLabel)}</span>
        </div>
      </header>
    `;
  }

  renderNodes(children, depth) {
    return sortedNodes(children)
      .map((node) =>
        node.kind === "directory"
          ? this.renderDirectory(node, depth)
          : this.renderFile(node.file, depth),
      )
      .join("");
  }

  renderDirectory(node, depth) {
    const expanded = this.expandedKeys.has(node.key);
    const entry = {
      name: node.name,
      path: node.key,
      kind: "directory",
      isSymlink: false,
      supported: true,
      expanded,
    };

    return `
      <li>
        <button
          type="button"
          class="github-pull-file-entry github-pull-file-directory"
          style="--tree-depth: ${depth}"
          data-node-key="${escapeHtml(node.key)}"
          aria-expanded="${expanded ? "true" : "false"}"
          aria-label="${escapeHtml(`${expanded ? "Collapse" : "Expand"} ${node.name}`)}"
        >
          <span class="github-pull-file-status-code" aria-hidden="true"></span>
          <span class="github-pull-file-node-label">
            ${renderEntryIcon(entry)}
            <span class="github-pull-file-name">${escapeHtml(node.name)}</span>
          </span>
        </button>
      </li>
      ${expanded ? this.renderNodes(node.children, depth + 1) : ""}
    `;
  }

  renderFile(file, depth) {
    const name = file.repoRelativePath.split("/").filter(Boolean).pop() ?? file.repoRelativePath;
    const selected = file.path === this.selectedPath;
    const entry = {
      name,
      path: file.path,
      kind: "file",
      isSymlink: false,
      supported: true,
    };

    return `
      <li>
        <button
          type="button"
          class="github-pull-file-entry github-pull-file"
          style="--tree-depth: ${depth}"
          data-pull-file-path="${escapeHtml(file.path)}"
          data-pull-file-status="${escapeHtml(file.status)}"
          aria-current="${selected ? "true" : "false"}"
          aria-label="${escapeHtml(`Show pull request diff for ${file.repoRelativePath}`)}"
          title="${escapeHtml(file.repoRelativePath)}"
        >
          <span class="github-pull-file-status-code">${escapeHtml(file.status)}</span>
          <span class="github-pull-file-node-label">
            ${renderEntryIcon(entry)}
            <span class="github-pull-file-name">${escapeHtml(name)}</span>
          </span>
        </button>
      </li>
    `;
  }

  toggleDirectory(key, button) {
    const anchor = this.captureScrollAnchor(button);
    if (this.expandedKeys.has(key)) {
      this.expandedKeys.delete(key);
    } else {
      this.expandedKeys.add(key);
    }

    this.render();
    this.restoreScrollAnchor(anchor);
  }

  captureScrollAnchor(button) {
    const scroller = this.querySelector(".github-pull-files-list");
    if (!button || !scroller) {
      return null;
    }

    return {
      key: button.dataset.nodeKey,
      top: button.getBoundingClientRect().top,
    };
  }

  restoreScrollAnchor(anchor) {
    if (!anchor) {
      return;
    }

    requestAnimationFrame(() => {
      const scroller = this.querySelector(".github-pull-files-list");
      const button = this.querySelector(`button[data-node-key="${CSS.escape(anchor.key)}"]`);
      if (!scroller || !button) {
        return;
      }

      scroller.scrollTop += button.getBoundingClientRect().top - anchor.top;
    });
  }
}

customElements.define("caffold-github-pull-files-tree", CaffoldGithubPullFilesTree);

function buildPullFilesTree(files) {
  const root = { kind: "directory", key: "", name: "", children: new Map() };
  const directoryKeys = [];

  for (const file of files) {
    const parts = file.repoRelativePath.split("/").filter(Boolean);
    let current = root;
    let key = "";

    for (const part of parts.slice(0, -1)) {
      key = key ? `${key}/${part}` : part;
      if (!current.children.has(part)) {
        current.children.set(part, {
          kind: "directory",
          key,
          name: part,
          children: new Map(),
        });
        directoryKeys.push(key);
      }

      current = current.children.get(part);
    }

    const name = parts.at(-1) ?? file.repoRelativePath;
    current.children.set(`${name}\0${file.path}`, {
      kind: "file",
      name,
      file,
    });
  }

  return { children: root.children, directoryKeys };
}

function sortedNodes(nodes) {
  return [...nodes.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}
