import { entryKindLabel, escapeHtml } from "./dom.js";
import { renderEntryIcon, warmIcons } from "./icons.js";

class CodgerFileList extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-entry-path]");
      if (!button || button.disabled) {
        return;
      }

      const eventName =
        button.dataset.kind === "directory"
          ? "codger:open-directory"
          : "codger:open-file";

      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          detail: { path: button.dataset.entryPath },
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();

    this.setIdle();
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  setLoading() {
    this.state = { status: "loading" };
    this.render();
  }

  setIdle() {
    this.state = { status: "idle" };
    this.render();
  }

  setDirectory(directory) {
    this.state = { status: "ready", directory };
    this.render();
  }

  setError(error) {
    this.state = { status: "error", error };
    this.render();
  }

  render() {
    if (!this.state || this.state.status === "idle") {
      this.innerHTML = `
        <section class="file-list-panel">
          <header><h2>Files</h2></header>
          <ol class="file-list"></ol>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="file-list-panel" aria-busy="true">
          <header><h2>Files</h2></header>
          <p class="surface-message">Loading files...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="file-list-panel error-panel">
          <header><h2>Files</h2></header>
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const { directory } = this.state;
    this.innerHTML = `
      <section class="file-list-panel">
        <header>
          <h2>Files</h2>
          <span>${directory.entries.length} entries</span>
        </header>
        <ol class="file-list">
          ${this.renderParentEntry(directory.path)}
          ${directory.entries.map((entry) => this.renderEntry(entry)).join("")}
        </ol>
      </section>
    `;
  }

  renderParentEntry(path) {
    if (!path) {
      return "";
    }

    const parentPath = parentDirectory(path);
    const parentEntry = {
      name: "..",
      path: parentPath,
      kind: "directory",
      isSymlink: false,
      supported: true,
    };

    return `
      <li>
        <button
          type="button"
          class="file-entry parent-entry"
          data-kind="directory"
          data-entry-path="${escapeHtml(parentPath)}"
          aria-label="Parent directory"
          title="Go to parent directory"
        >
          ${renderEntryIcon(parentEntry)}
          <span class="entry-name">..</span>
        </button>
      </li>
    `;
  }

  renderEntry(entry) {
    const kind = entryKindLabel(entry);
    const disabled = entry.supported ? "" : "disabled";
    const blockedTitle = entry.supported ? "" : 'title="This path resolves outside the root"';
    const hiddenClass = isHiddenEntry(entry) ? " is-hidden" : "";

    return `
      <li>
        <button
          type="button"
          class="file-entry${hiddenClass}"
          data-kind="${escapeHtml(entry.kind)}"
          data-entry-path="${escapeHtml(entry.path)}"
          aria-current="${entry.path === this.selectedPath ? "true" : "false"}"
          aria-label="${escapeHtml(`${entry.name} ${kind}`)}"
          ${disabled}
          ${blockedTitle}
        >
          ${renderEntryIcon(entry)}
          <span class="entry-name">${escapeHtml(entry.name)}</span>
        </button>
      </li>
    `;
  }

  setSelectedPath(path) {
    this.selectedPath = path;
    this.render();
  }
}

customElements.define("codger-file-list", CodgerFileList);

function parentDirectory(path) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isHiddenEntry(entry) {
  return entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..";
}
