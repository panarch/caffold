import { escapeHtml } from "../../../components/dom.js";
import { renderGroupButton, renderHeaderNotice, renderMenuAction } from "./shared.js";

const GITHUB_POPOVER_ID = "caffold-github-actions-popover";

class CaffoldGithubHeaderAction extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.render();
  }

  set status(value) {
    const nextValue = value ?? null;
    if (sameGithubStatus(this.statusValue, nextValue)) {
      return;
    }

    this.statusValue = nextValue;
    this.renderKeepingOpenPopover();
  }

  get status() {
    return this.statusValue ?? null;
  }

  renderKeepingOpenPopover() {
    const wasOpen = !this.querySelector(".header-actions-popover")?.hidden;
    this.render();

    if (wasOpen) {
      this.openPopover();
    }
  }

  openPopover() {
    const popover = this.querySelector(".header-actions-popover");
    const button = this.querySelector("button[data-action-group]");
    if (!popover || !button) {
      return;
    }

    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
  }

  render() {
    this.innerHTML = renderGithubActions(this.status);
  }
}

customElements.define("caffold-github-header-action", CaffoldGithubHeaderAction);

function renderGithubActions(githubStatus) {
  const state = actionState(githubStatus);
  const repositoryLabel =
    state === "pending"
      ? "Checking..."
      : githubStatus?.github?.nameWithOwner ?? githubStatus?.github?.name ?? "Unavailable";
  const title =
    state === "available"
      ? "GitHub actions"
      : githubStatus?.message ?? "Checking GitHub status";

  return `
    <div class="header-action-group">
      ${renderGroupButton({
        group: "github",
        popoverId: GITHUB_POPOVER_ID,
        brandIcon: {
          light: "/assets/brand/github-invertocat-light.svg",
          dark: "/assets/brand/github-invertocat-dark.svg",
        },
        label: "GitHub",
        title,
        state,
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
        ${
          state === "available"
            ? `<div class="header-actions-menu">
                ${renderMenuAction({
                  action: "open-github-pulls-workspace",
                  icon: "GitPullRequest",
                  label: "PRs",
                  title: githubStatus.pullsAvailable
                    ? "Open Pull Requests"
                    : `Open Pull Requests (${githubStatus.message ?? "GitHub unavailable"})`,
                })}
                ${renderMenuAction({
                  action: "open-github-issues-workspace",
                  icon: "CircleDot",
                  label: "Issues",
                  title: githubStatus.issuesAvailable
                    ? "Open Issues"
                    : `Open Issues (${githubStatus.message ?? "GitHub unavailable"})`,
                })}
              </div>`
            : renderHeaderNotice(title)
        }
      </section>
    </div>
  `;
}

export function sameGithubStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.available === right.available &&
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

function actionState(status) {
  if (!status) {
    return "pending";
  }

  if (status.available === false || !status.github) {
    return "unavailable";
  }

  return "available";
}
