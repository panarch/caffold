import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

class CaffoldHeaderActions extends HTMLElement {
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
        "open-compare-workspace": "caffold:open-compare-workspace",
        "open-log-workspace": "caffold:open-log-workspace",
        "open-diff-workspace": "caffold:open-diff-workspace",
        "open-github-issues-workspace": "caffold:open-github-issues-workspace",
      }[button.dataset.action];
      if (!eventName) {
        return;
      }

      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();

    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  set gitStatus(value) {
    const nextValue = value ?? null;
    if (sameGitStatus(this.gitStatusValue, nextValue)) {
      return;
    }

    this.gitStatusValue = nextValue;
    this.render();
  }

  get gitStatus() {
    return this.gitStatusValue ?? null;
  }

  set githubStatus(value) {
    const nextValue = value ?? null;
    if (sameGithubStatus(this.githubStatusValue, nextValue)) {
      return;
    }

    this.githubStatusValue = nextValue;
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

customElements.define("caffold-header-actions", CaffoldHeaderActions);

function sameGitStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.branch === right.branch &&
    left.dirty === right.dirty &&
    left.count === right.count
  );
}

function sameGithubStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.ghAvailable === right.ghAvailable &&
    left.authenticated === right.authenticated &&
    left.issuesAvailable === right.issuesAvailable &&
    left.message === right.message &&
    left.github?.owner === right.github?.owner &&
    left.github?.name === right.github?.name &&
    left.github?.nameWithOwner === right.github?.nameWithOwner &&
    left.github?.url === right.github?.url
  );
}
