import { escapeHtml } from "./dom.js";

class CodgerPathbar extends HTMLElement {
  connectedCallback() {
    this.addEventListener("click", (event) => {
      const gitButton = event.target.closest("button[data-action='toggle-git-mode']");
      if (gitButton) {
        this.dispatchEvent(
          new CustomEvent("codger:toggle-git-mode", {
            bubbles: true,
          }),
        );
        return;
      }

      const button = event.target.closest("button[data-path]");
      if (!button) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("codger:navigate", {
          bubbles: true,
          detail: { path: button.dataset.path },
        }),
      );
    });

    this.render();
  }

  set path(value) {
    this.currentPath = value ?? "";
    this.render();
  }

  set homePath(value) {
    this.homePathValue = value || null;
    this.render();
  }

  set gitStatus(value) {
    this.gitStatusValue = value ?? null;
    this.render();
  }

  get path() {
    return this.currentPath ?? "";
  }

  get homePath() {
    return this.homePathValue ?? null;
  }

  get gitStatus() {
    return this.gitStatusValue ?? null;
  }

  render() {
    const crumbs = buildCrumbs(this.path, this.homePath);

    this.innerHTML = `
      <nav class="pathbar" aria-label="Current path">
        <span class="pathbar-label">Path</span>
        <ol class="path-crumbs">
          ${crumbs
            .map(
              (crumb, index) => `
                <li>
                  <button type="button" data-path="${escapeHtml(crumb.path)}" ${
                    index === crumbs.length - 1 ? 'aria-current="page"' : ""
                  }>
                    ${escapeHtml(crumb.label)}
                  </button>
                </li>
              `,
            )
            .join("")}
        </ol>
        ${this.renderGitButton()}
      </nav>
    `;
  }

  renderGitButton() {
    const gitStatus = this.gitStatus;
    if (!gitStatus) {
      return "";
    }

    const branch = gitStatus.branch ?? "HEAD";
    const count = gitStatus.count;
    const countLabel = count === null || count === undefined ? "" : `${count}`;
    const dirtyLabel = gitStatus.dirty ? "*" : "";
    const className = [
      "git-mode-button",
      gitStatus.dirty ? "is-dirty" : "",
      gitStatus.active ? "is-active" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const actionLabel = gitStatus.active ? "Show files" : "Show changes";

    return `
      <button
        type="button"
        class="${escapeHtml(className)}"
        data-action="toggle-git-mode"
        title="${escapeHtml(`${actionLabel} for ${branch}`)}"
        aria-label="${escapeHtml(`${actionLabel} for ${branch}`)}"
        aria-pressed="${gitStatus.active ? "true" : "false"}"
      >
        <span class="git-branch">${escapeHtml(branch)}${dirtyLabel}</span>
        <span class="git-count">${escapeHtml(countLabel.trim())}</span>
      </button>
    `;
  }
}

customElements.define("codger-pathbar", CodgerPathbar);

function buildCrumbs(path, homePath) {
  if (!homePath) {
    return relativeCrumbs(path, "~", "");
  }

  if (path === homePath || path.startsWith(`${homePath}/`)) {
    const relativeToHome = path.slice(homePath.length).replace(/^\//, "");
    return relativeCrumbs(relativeToHome, "~", homePath);
  }

  return relativeCrumbs(path, "/", "");
}

function relativeCrumbs(path, rootLabel, rootPath) {
  const parts = path.split("/").filter(Boolean);
  const crumbs = [{ label: rootLabel, path: rootPath }];
  let nextPath = rootPath;

  for (const part of parts) {
    nextPath = nextPath ? `${nextPath}/${part}` : part;
    crumbs.push({ label: part, path: nextPath });
  }

  return crumbs;
}
