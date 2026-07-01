import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

class CodgerHeaderActions extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const eventName = {
        "open-compare-workspace": "codger:open-compare-workspace",
        "open-log-workspace": "codger:open-log-workspace",
        "open-diff-workspace": "codger:open-diff-workspace",
        "open-github-issues-workspace": "codger:open-github-issues-workspace",
      }[button.dataset.action];
      if (!eventName) {
        return;
      }

      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();

    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  set gitStatus(value) {
    this.gitStatusValue = value ?? null;
    this.render();
  }

  get gitStatus() {
    return this.gitStatusValue ?? null;
  }

  set githubStatus(value) {
    this.githubStatusValue = value ?? null;
    this.render();
  }

  get githubStatus() {
    return this.githubStatusValue ?? null;
  }

  render() {
    this.innerHTML = `
      <div class="header-actions" aria-label="Review actions">
        ${this.renderGitToggle()}
        ${this.renderGitHubActions()}
      </div>
    `;
  }

  renderGitToggle() {
    const gitStatus = this.gitStatus;
    if (!gitStatus) {
      return "";
    }

    return `
      ${this.renderAction({
        action: "open-diff-workspace",
        icon: "FileDiff",
        label: "Diff",
        count: gitStatus.count,
        title: "Open Diff",
        metricLabel: "changed",
      })}
      ${this.renderAction({
        action: "open-compare-workspace",
        icon: "GitCompare",
        label: "Compare",
        title: "Open Compare",
      })}
      ${this.renderAction({
        action: "open-log-workspace",
        icon: "History",
        label: "Log",
        title: "Open Log",
      })}
    `;
  }

  renderGitHubActions() {
    const githubStatus = this.githubStatus;
    if (!githubStatus?.github) {
      return "";
    }

    return this.renderAction({
      action: "open-github-issues-workspace",
      icon: "CircleDot",
      label: "Issues",
      title: githubStatus.issuesAvailable
        ? "Open Issues"
        : `Open Issues (${githubStatus.message ?? "GitHub unavailable"})`,
    });
  }

  renderAction({
    action,
    icon,
    label,
    count = null,
    title,
    metricLabel = "",
  }) {
    const className = "header-action-button";
    const actionLabel = title;
    const countText = count === null || count === undefined ? "" : `${count}`.trim();
    const countAria =
      countText && metricLabel
        ? `, ${countText} ${metricLabel} ${count === 1 ? "file" : "files"}`
        : "";

    return `
      <button
        type="button"
        class="${escapeHtml(className)}"
        data-action="${escapeHtml(action)}"
        title="${escapeHtml(actionLabel)}"
        aria-label="${escapeHtml(`${actionLabel}${countAria}`)}"
      >
        ${renderInlineIcon(icon, actionLabel, "header-action-icon")}
        <span class="header-action-label">${escapeHtml(label)}</span>
        ${
          countText
            ? `<span class="header-action-count">${escapeHtml(countText)}</span>`
            : ""
        }
      </button>
    `;
  }
}

customElements.define("codger-header-actions", CodgerHeaderActions);
