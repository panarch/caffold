import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

const GIT_POPOVER_ID = "caffold-git-actions-popover";
const GITHUB_POPOVER_ID = "caffold-github-actions-popover";

class CaffoldHeaderActions extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const groupButton = event.target.closest("button[data-action-group]");
      if (groupButton) {
        this.togglePopover(groupButton);
        return;
      }

      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const eventName = {
        "open-compare-workspace": "caffold:open-compare-workspace",
        "open-log-workspace": "caffold:open-log-workspace",
        "open-diff-workspace": "caffold:open-diff-workspace",
        "open-github-issues-workspace": "caffold:open-github-issues-workspace",
        "open-github-pulls-workspace": "caffold:open-github-pulls-workspace",
      }[button.dataset.action];
      if (!eventName) {
        return;
      }

      this.closeAllPopovers();
      this.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
    });
    this.boundIconsReady = () => this.renderKeepingOpenPopover();
    this.boundDocumentClick = (event) => {
      if (!this.contains(event.target)) {
        this.closeAllPopovers();
      }
    };
    this.boundDocumentKeyDown = (event) => {
      if (event.key === "Escape") {
        const openButton = this.querySelector('button[aria-expanded="true"]');
        this.closeAllPopovers();
        openButton?.focus();
      }
    };
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    document.addEventListener("click", this.boundDocumentClick);
    document.addEventListener("keydown", this.boundDocumentKeyDown);
    warmIcons();

    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    document.removeEventListener("click", this.boundDocumentClick);
    document.removeEventListener("keydown", this.boundDocumentKeyDown);
  }

  set gitStatus(value) {
    const nextValue = value ?? null;
    if (sameGitStatus(this.gitStatusValue, nextValue)) {
      return;
    }

    this.gitStatusValue = nextValue;
    this.renderKeepingOpenPopover();
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
    this.renderKeepingOpenPopover();
  }

  get githubStatus() {
    return this.githubStatusValue ?? null;
  }

  render() {
    this.innerHTML = `
      <div class="header-actions" aria-label="Review actions">
        ${this.renderGitActions()}
        ${this.renderGitHubActions()}
      </div>
    `;
  }

  renderKeepingOpenPopover() {
    const openPopover = this.querySelector(".header-actions-popover:not([hidden])");
    const openGroup = openPopover?.dataset.actionGroup;
    this.render();

    if (openGroup) {
      this.openPopoverByGroup(openGroup);
    }
  }

  togglePopover(groupButton) {
    const targetId = groupButton.getAttribute("aria-controls");
    const target = targetId ? this.querySelector(`#${targetId}`) : null;
    const shouldOpen = target?.hidden;

    this.closeAllPopovers();

    if (target && shouldOpen) {
      target.hidden = false;
      groupButton.setAttribute("aria-expanded", "true");
    }
  }

  openPopoverByGroup(group) {
    const popover = this.querySelector(
      `.header-actions-popover[data-action-group="${group}"]`,
    );
    const button = this.querySelector(`button[data-action-group="${group}"]`);

    if (!popover || !button) {
      return;
    }

    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }

  closeAllPopovers() {
    this.querySelectorAll(".header-actions-popover").forEach((popover) => {
      popover.hidden = true;
    });
    this.querySelectorAll("button[data-action-group]").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
  }

  renderGitActions() {
    const gitStatus = this.gitStatus;
    if (!gitStatus) {
      return "";
    }

    const count = Number(gitStatus.count ?? 0);
    const badge = count > 0 ? (count > 99 ? "99+" : `${count}`) : "";
    const countLabel = `${count} changed ${count === 1 ? "file" : "files"}`;

    return `
      <div class="header-action-group">
        ${this.renderGroupButton({
          group: "git",
          popoverId: GIT_POPOVER_ID,
          brandIcon: {
            light: "/assets/brand/git-logomark-light.svg",
            dark: "/assets/brand/git-logomark-dark.svg",
          },
          label: "Git",
          title: `Git actions, ${countLabel}`,
          badge,
        })}
        <section
          id="${GIT_POPOVER_ID}"
          class="header-actions-popover"
          data-action-group="git"
          aria-label="Git actions"
          hidden
        >
          <header class="header-actions-popover-header">
            <h2>Git</h2>
            <span>${escapeHtml(countLabel)}</span>
          </header>
          <div class="header-actions-menu">
            ${this.renderMenuAction({
              action: "open-diff-workspace",
              icon: "FileDiff",
              label: "Diff",
              title: "Open Diff",
              metric: `${count}`,
            })}
            ${this.renderMenuAction({
              action: "open-compare-workspace",
              icon: "GitCompare",
              label: "Compare",
              title: "Open Compare",
            })}
            ${this.renderMenuAction({
              action: "open-log-workspace",
              icon: "History",
              label: "Log",
              title: "Open Log",
            })}
          </div>
        </section>
      </div>
    `;
  }

  renderGitHubActions() {
    const githubStatus = this.githubStatus;
    if (!githubStatus?.github) {
      return "";
    }

    const repositoryLabel =
      githubStatus.github.nameWithOwner ?? githubStatus.github.name ?? "GitHub";

    return `
      <div class="header-action-group">
        ${this.renderGroupButton({
          group: "github",
          popoverId: GITHUB_POPOVER_ID,
          brandIcon: {
            light: "/assets/brand/github-invertocat-light.svg",
            dark: "/assets/brand/github-invertocat-dark.svg",
          },
          label: "GitHub",
          title: "GitHub actions",
        })}
        <section
          id="${GITHUB_POPOVER_ID}"
          class="header-actions-popover"
          data-action-group="github"
          aria-label="GitHub actions"
          hidden
        >
          <header class="header-actions-popover-header">
            <h2>GitHub</h2>
            <span>${escapeHtml(repositoryLabel)}</span>
          </header>
          <div class="header-actions-menu">
            ${this.renderMenuAction({
              action: "open-github-pulls-workspace",
              icon: "GitPullRequest",
              label: "PRs",
              title: githubStatus.pullsAvailable
                ? "Open Pull Requests"
                : `Open Pull Requests (${githubStatus.message ?? "GitHub unavailable"})`,
            })}
            ${this.renderMenuAction({
              action: "open-github-issues-workspace",
              icon: "CircleDot",
              label: "Issues",
              title: githubStatus.issuesAvailable
                ? "Open Issues"
                : `Open Issues (${githubStatus.message ?? "GitHub unavailable"})`,
            })}
          </div>
        </section>
      </div>
    `;
  }

  renderGroupButton({
    group,
    popoverId,
    icon,
    brandIcon = null,
    label,
    title,
    badge = "",
  }) {
    return `
      <button
        type="button"
        class="header-action-group-button"
        data-action-group="${escapeHtml(group)}"
        aria-controls="${escapeHtml(popoverId)}"
        aria-expanded="false"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}"
      >
        ${
          brandIcon
            ? renderBrandIcon(brandIcon, label)
            : renderInlineIcon(icon, label, "header-action-icon")
        }
        ${
          badge
            ? `<span class="header-action-badge" aria-hidden="true">${escapeHtml(badge)}</span>`
            : ""
        }
      </button>
    `;
  }

  renderMenuAction({
    action,
    icon,
    label,
    title,
    metric = "",
  }) {
    const metricText = metric === null || metric === undefined ? "" : `${metric}`.trim();

    return `
      <button
        type="button"
        class="header-menu-item"
        data-action="${escapeHtml(action)}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(title)}"
      >
        ${renderInlineIcon(icon, title, "header-menu-icon")}
        <span class="header-menu-label">${escapeHtml(label)}</span>
        ${
          metricText
            ? `<span class="header-menu-metric">${escapeHtml(metricText)}</span>`
            : ""
        }
      </button>
    `;
  }
}

customElements.define("caffold-header-actions", CaffoldHeaderActions);

function renderBrandIcon(icon, label) {
  return `
    <picture class="header-action-brand-picture" aria-hidden="true">
      <source
        srcset="${escapeHtml(icon.dark)}"
        media="(prefers-color-scheme: dark)"
      />
      <img
        class="header-action-icon header-action-brand-icon"
        src="${escapeHtml(icon.light)}"
        alt=""
        draggable="false"
      />
    </picture>
    <span class="sr-only">${escapeHtml(label)}</span>
  `;
}

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
    left.pullsAvailable === right.pullsAvailable &&
    left.message === right.message &&
    left.github?.owner === right.github?.owner &&
    left.github?.name === right.github?.name &&
    left.github?.nameWithOwner === right.github?.nameWithOwner &&
    left.github?.url === right.github?.url
  );
}
