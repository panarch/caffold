import { escapeHtml } from "../../../../../../../components/dom.js";
import { renderEntryIcon, warmIcons } from "../../../../../../../components/icons.js";

class CaffoldCommitChangesTree extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-node-key], button[data-commit-path]");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.nodeKey) {
        this.toggleDirectory(button.dataset.nodeKey, button);
        return;
      }

      this.setSelectedPath(button.dataset.commitPath);
      this.dispatchEvent(
        new CustomEvent("caffold:open-commit-diff", {
          bubbles: true,
          detail: {
            sha: button.dataset.commitSha,
            path: button.dataset.commitPath,
            status: button.dataset.commitStatus,
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

  setLoading(repository, commit = null) {
    this.state = { status: "loading", repository, commit };
    this.render();
  }

  setCommit(commitPayload) {
    const tree = buildCommitTree(commitPayload.files ?? []);
    this.expandedKeys = new Set(tree.directoryKeys);
    this.state = { status: "ready", commitPayload, tree };
    this.render();
  }

  setError(error, repository = null, commit = null) {
    this.state = { status: "error", error, repository, commit };
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
    for (const button of this.querySelectorAll('button[data-commit-path][aria-current="true"]')) {
      button.setAttribute("aria-current", "false");
    }

    if (!this.selectedPath) {
      return;
    }

    const button = this.querySelector(
      `button[data-commit-path="${CSS.escape(this.selectedPath)}"]`,
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
        <section class="commit-tree-panel">
          ${this.renderHeader(null, null, null)}
          <ol class="commit-tree-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="commit-tree-panel" aria-busy="true">
          ${this.renderHeader(this.state.repository, this.state.commit, null)}
          <p class="surface-message">Loading commit...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="commit-tree-panel error-panel">
          ${this.renderHeader(this.state.repository, this.state.commit, null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const payload = this.state.commitPayload;
    const files = payload.files ?? [];
    this.innerHTML = `
      <section class="commit-tree-panel">
        ${this.renderHeader(payload.repository, payload.commit, files.length)}
        ${
          files.length === 0
            ? `<p class="surface-message">No files changed.</p>`
            : `<ol class="commit-tree-list">${this.renderNodes(this.state.tree.children, 0)}</ol>`
        }
      </section>
    `;
  }

  renderHeader(_repository, _commit, count) {
    const countLabel = count === null || count === undefined ? "" : `${count} files`;

    return `
      <header>
        <div class="commit-tree-title-row">
          <h2>Commit</h2>
          <span class="commit-file-count">${escapeHtml(countLabel)}</span>
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
          class="commit-entry commit-directory"
          style="--tree-depth: ${depth}"
          data-node-key="${escapeHtml(node.key)}"
          aria-expanded="${expanded ? "true" : "false"}"
          aria-label="${escapeHtml(`${expanded ? "Collapse" : "Expand"} ${node.name}`)}"
        >
          <span class="commit-status-code" aria-hidden="true"></span>
          <span class="commit-node-label">
            ${renderEntryIcon(entry)}
            <span class="commit-name">${escapeHtml(node.name)}</span>
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
          class="commit-entry commit-file"
          style="--tree-depth: ${depth}"
          data-commit-sha="${escapeHtml(this.state.commitPayload.commit.sha)}"
          data-commit-path="${escapeHtml(file.path)}"
          data-commit-status="${escapeHtml(file.status)}"
          aria-current="${selected ? "true" : "false"}"
          aria-label="${escapeHtml(`Show commit diff for ${file.repoRelativePath}`)}"
          title="${escapeHtml(file.repoRelativePath)}"
        >
          <span class="commit-status-code">${escapeHtml(file.status)}</span>
          <span class="commit-node-label">
            ${renderEntryIcon(entry)}
            <span class="commit-name">${escapeHtml(name)}</span>
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
    const scroller = this.querySelector(".commit-tree-list");
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
      const scroller = this.querySelector(".commit-tree-list");
      const button = this.querySelector(`button[data-node-key="${CSS.escape(anchor.key)}"]`);
      if (!scroller || !button) {
        return;
      }

      const currentTop = button.getBoundingClientRect().top;
      scroller.scrollTop += currentTop - anchor.top;
    });
  }
}

customElements.define("caffold-commit-changes-tree", CaffoldCommitChangesTree);

function buildCommitTree(files) {
  const root = { kind: "root", children: new Map() };
  const directoryKeys = [];

  for (const file of files) {
    const parts = file.repoRelativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let children = root.children;
    let directoryPath = "";

    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      const key = `commit:${directoryPath}`;
      let directory = children.get(key);

      if (!directory) {
        directory = {
          kind: "directory",
          name: part,
          key,
          children: new Map(),
        };
        children.set(key, directory);
        directoryKeys.push(key);
      }

      children = directory.children;
    }

    children.set(`commit:file:${file.repoRelativePath}`, {
      kind: "file",
      name: parts[parts.length - 1],
      file,
    });
  }

  return { children: root.children, directoryKeys };
}

function sortedNodes(children) {
  return Array.from(children.values()).sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  });
}
