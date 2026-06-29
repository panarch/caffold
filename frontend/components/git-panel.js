import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

const SECTIONS = [
  ["unstaged", "Unstaged"],
  ["staged", "Staged"],
  ["untracked", "Untracked"],
];

class CodgerGitPanel extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const actionButton = event.target.closest("button[data-action]");
      if (!actionButton) {
        return;
      }

      const action = actionButton.dataset.action;
      if (action === "close") {
        this.close();
        return;
      }

      if (action === "refresh") {
        this.dispatchEvent(new CustomEvent("codger:refresh-git", { bubbles: true }));
        return;
      }

      if (action === "open-file") {
        this.dispatchEvent(
          new CustomEvent("codger:open-git-file", {
            bubbles: true,
            detail: { path: actionButton.dataset.path },
          }),
        );
        this.close();
        return;
      }

      if (action === "open-diff") {
        this.dispatchEvent(
          new CustomEvent("codger:open-git-diff", {
            bubbles: true,
            detail: {
              path: actionButton.dataset.path,
              kind: actionButton.dataset.kind,
            },
          }),
        );
        this.close();
      }
    });

    this.addEventListener("click", (event) => {
      if (event.target.classList.contains("git-panel-backdrop")) {
        this.close();
      }
    });

    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();

    if (!this.state) {
      this.state = { open: false, status: "idle" };
      this.render();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  open() {
    this.state = { ...this.state, open: true };
    this.render();
  }

  close() {
    this.state = { ...this.state, open: false };
    this.render();
  }

  setLoading(repository) {
    this.state = { ...this.state, status: "loading", repository };
    this.render();
  }

  setStatus(status) {
    this.state = { ...this.state, status: "ready", gitStatus: status };
    this.render();
  }

  setError(error, repository = null) {
    this.state = { ...this.state, status: "error", error, repository };
    this.render();
  }

  reset() {
    this.state = { open: false, status: "idle" };
    this.render();
  }

  render() {
    if (!this.state?.open) {
      this.innerHTML = "";
      return;
    }

    const repository = this.state.gitStatus?.repository ?? this.state.repository;
    const branch = repository?.branch ?? "HEAD";

    this.innerHTML = `
      <div class="git-panel-backdrop">
        <section class="git-panel" aria-label="Git review panel">
          <header>
            <div>
              <h2>Git</h2>
              <p>${escapeHtml(branch)}${repository?.dirty ? " *" : ""}</p>
            </div>
            <div class="git-panel-actions">
              ${this.renderIconButton("refresh", "Refresh Git status", "RefreshCw")}
              ${this.renderIconButton("close", "Close Git panel", "X")}
            </div>
          </header>
          <div class="git-panel-body">
            ${this.renderBody()}
          </div>
        </section>
      </div>
    `;
  }

  renderBody() {
    if (this.state.status === "loading") {
      return `<p class="surface-message">Loading Git status...</p>`;
    }

    if (this.state.status === "error") {
      return `<p class="surface-message">${escapeHtml(this.state.error.message)}</p>`;
    }

    if (this.state.status !== "ready") {
      return `<p class="surface-message">No Git repository selected.</p>`;
    }

    const files = this.state.gitStatus.files;
    if (files.length === 0) {
      return `<p class="surface-message">No changes.</p>`;
    }

    return SECTIONS.map(([category, label]) =>
      this.renderSection(label, files.filter((file) => file.category === category)),
    ).join("");
  }

  renderSection(label, files) {
    if (files.length === 0) {
      return "";
    }

    return `
      <section class="git-change-section">
        <h3>${escapeHtml(label)}</h3>
        <ol>
          ${files.map((file) => this.renderFile(file)).join("")}
        </ol>
      </section>
    `;
  }

  renderFile(file) {
    const kind = file.untracked ? "untracked" : file.category;

    return `
      <li>
        <span class="git-status-code">${escapeHtml(file.status)}</span>
        <button
          type="button"
          class="git-file-path"
          data-action="open-file"
          data-path="${escapeHtml(file.path)}"
        >
          ${escapeHtml(file.repoRelativePath)}
        </button>
        <button
          type="button"
          class="git-diff-button"
          data-action="open-diff"
          data-path="${escapeHtml(file.path)}"
          data-kind="${escapeHtml(kind)}"
          title="Show diff"
          aria-label="${escapeHtml(`Show diff for ${file.repoRelativePath}`)}"
        >
          ${renderInlineIcon("FileDiff", "Show diff", "git-panel-icon-svg")}
        </button>
      </li>
    `;
  }

  renderIconButton(action, label, icon) {
    return `
      <button
        type="button"
        class="git-icon-button"
        data-action="${escapeHtml(action)}"
        title="${escapeHtml(label)}"
        aria-label="${escapeHtml(label)}"
      >
        ${renderInlineIcon(icon, label, "git-panel-icon-svg")}
      </button>
    `;
  }
}

customElements.define("codger-git-panel", CodgerGitPanel);
