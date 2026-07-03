import { escapeHtml } from "../../../../../../components/dom.js";
import { renderEntryIcon, warmIcons } from "../../../../../../components/icons.js";

const SECTIONS = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
  ["untracked", "Untracked"],
];

class CaffoldGitDiffChangesTree extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-node-key], button[data-change-path]");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.nodeKey) {
        this.toggleDirectory(button.dataset.nodeKey, button);
        return;
      }

      this.setSelectedPath(button.dataset.changePath);
      this.dispatchEvent(
        new CustomEvent("caffold:open-git-diff", {
          bubbles: true,
          detail: {
            path: button.dataset.changePath,
            kind: button.dataset.changeKind,
            status: button.dataset.changeStatus,
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

  setLoading(repository) {
    this.state = { status: "loading", repository };
    this.render();
  }

  setStatus(gitStatus) {
    const tree = buildChangeTree(gitStatus.files);
    this.expandedKeys = new Set(tree.directoryKeys);
    this.state = { status: "ready", gitStatus, tree };
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
    for (const button of this.querySelectorAll('button[data-change-path][aria-current="true"]')) {
      button.setAttribute("aria-current", "false");
    }

    if (!this.selectedPath) {
      return;
    }

    const button = this.querySelector(
      `button[data-change-path="${CSS.escape(this.selectedPath)}"]`,
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
        <section class="changes-tree-panel">
          ${this.renderHeader(null, null)}
          <ol class="changes-tree-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="changes-tree-panel" aria-busy="true">
          ${this.renderHeader(this.state.repository, null)}
          <p class="surface-message">Loading changes...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="changes-tree-panel error-panel">
          ${this.renderHeader(this.state.repository, null)}
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const files = this.state.gitStatus.files;
    this.innerHTML = `
      <section class="changes-tree-panel">
        ${this.renderHeader(this.state.gitStatus.repository, files.length)}
        ${
          files.length === 0
            ? `<p class="surface-message">No changes.</p>`
            : `<ol class="changes-tree-list">${this.renderSections()}</ol>`
        }
      </section>
    `;
  }

  renderHeader(repository, count) {
    const branch = repository?.branch ?? "HEAD";
    const countLabel = count === null || count === undefined ? "" : `${count} changes`;

    return `
      <header>
        <div class="changes-tree-title-row">
          <h2>Changes</h2>
          <span class="change-count">${escapeHtml(countLabel)}</span>
        </div>
        ${
          repository
            ? `<span class="changes-branch${repository.dirty ? " is-dirty" : ""}">
                ${escapeHtml(branch)}${repository.dirty ? " *" : ""}
              </span>`
            : ""
        }
      </header>
    `;
  }

  renderSections() {
    return SECTIONS.map(([category, label]) => {
      const section = this.state.tree.sections.get(category);
      if (!section || section.children.size === 0) {
        return "";
      }

      return `
        <li class="change-section-label">${escapeHtml(label)}</li>
        ${this.renderNodes(section.children, 0)}
      `;
    }).join("");
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
          class="change-entry change-directory"
          style="--tree-depth: ${depth}"
          data-node-key="${escapeHtml(node.key)}"
          aria-expanded="${expanded ? "true" : "false"}"
          aria-label="${escapeHtml(`${expanded ? "Collapse" : "Expand"} ${node.name}`)}"
        >
          <span class="change-status-code" aria-hidden="true"></span>
          <span class="change-node-label">
            ${renderEntryIcon(entry)}
            <span class="change-name">${escapeHtml(node.name)}</span>
          </span>
        </button>
      </li>
      ${expanded ? this.renderNodes(node.children, depth + 1) : ""}
    `;
  }

  renderFile(file, depth) {
    const name = file.repoRelativePath.split("/").filter(Boolean).pop() ?? file.repoRelativePath;
    const kind = file.untracked ? "untracked" : file.category;
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
          class="change-entry change-file"
          style="--tree-depth: ${depth}"
          data-change-path="${escapeHtml(file.path)}"
          data-change-kind="${escapeHtml(kind)}"
          data-change-status="${escapeHtml(file.status)}"
          aria-current="${selected ? "true" : "false"}"
          aria-label="${escapeHtml(`Show diff for ${file.repoRelativePath}`)}"
          title="${escapeHtml(file.repoRelativePath)}"
        >
          <span class="change-status-code">${escapeHtml(file.status)}</span>
          <span class="change-node-label">
            ${renderEntryIcon(entry)}
            <span class="change-name">${escapeHtml(name)}</span>
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
    const scroller = this.querySelector(".changes-tree-list");
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
      const scroller = this.querySelector(".changes-tree-list");
      const button = this.querySelector(`button[data-node-key="${CSS.escape(anchor.key)}"]`);
      if (!scroller || !button) {
        return;
      }

      const currentTop = button.getBoundingClientRect().top;
      scroller.scrollTop += currentTop - anchor.top;
    });
  }
}

customElements.define("caffold-git-diff-changes-tree", CaffoldGitDiffChangesTree);

function buildChangeTree(files) {
  const sections = new Map(
    SECTIONS.map(([category]) => [category, { kind: "section", children: new Map() }]),
  );
  const directoryKeys = [];

  for (const file of files) {
    const section = sections.get(file.category);
    if (!section) {
      continue;
    }

    const parts = file.repoRelativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let children = section.children;
    let directoryPath = "";

    for (const part of parts.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${part}` : part;
      const key = `${file.category}:${directoryPath}`;
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

    children.set(`${file.category}:file:${file.repoRelativePath}`, {
      kind: "file",
      name: parts[parts.length - 1],
      file,
    });
  }

  return { sections, directoryKeys };
}

function sortedNodes(children) {
  return Array.from(children.values()).sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.toLowerCase().localeCompare(right.name.toLowerCase());
  });
}
