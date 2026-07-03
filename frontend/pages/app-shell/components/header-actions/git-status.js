import { escapeHtml } from "../../../../components/dom.js";
import { renderGroupButton, renderHeaderNotice, renderMenuAction } from "./shared.js";

const GIT_POPOVER_ID = "caffold-git-actions-popover";

class CaffoldGitHeaderAction extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.render();
  }

  set status(value) {
    const nextValue = value ?? null;
    if (sameGitStatus(this.statusValue, nextValue)) {
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
    this.innerHTML = renderGitActions(this.status);
  }
}

customElements.define("caffold-git-header-action", CaffoldGitHeaderAction);

function renderGitActions(gitStatus) {
  const state = actionState(gitStatus);
  const rawCount = gitStatus?.count;
  const count = Number(rawCount);
  const countKnown = rawCount !== null && rawCount !== undefined && Number.isFinite(count);
  const badge =
    state === "available" && countKnown && count > 0
      ? count > 99
        ? "99+"
        : `${count}`
      : "";
  const countLabel =
    state === "pending" || (state === "available" && !countKnown)
      ? "Checking..."
      : state === "unavailable"
        ? "Unavailable"
        : `${count} changed ${count === 1 ? "file" : "files"}`;
  const title =
    state === "available"
      ? `Git actions, ${countLabel}`
      : gitStatus?.message ?? "Checking Git status";

  return `
    <div class="header-action-group">
      ${renderGroupButton({
        group: "git",
        popoverId: GIT_POPOVER_ID,
        brandIcon: {
          light: "/assets/brand/git-logomark-light.svg",
          dark: "/assets/brand/git-logomark-dark.svg",
        },
        label: "Git",
        title,
        badge,
        state,
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
        ${
          state === "available"
            ? `<div class="header-actions-menu">
                ${renderMenuAction({
                  action: "open-diff-workspace",
                  icon: "FileDiff",
                  label: "Diff",
                  title: "Open Diff",
                  metric: countKnown ? `${count}` : "",
                })}
                ${renderMenuAction({
                  action: "open-compare-workspace",
                  icon: "GitCompare",
                  label: "Compare",
                  title: "Open Compare",
                })}
                ${renderMenuAction({
                  action: "open-log-workspace",
                  icon: "History",
                  label: "Log",
                  title: "Open Log",
                })}
              </div>`
            : renderHeaderNotice(title)
        }
      </section>
    </div>
  `;
}

export function sameGitStatus(left, right) {
  if (!left || !right) {
    return !left && !right;
  }

  return (
    left.available === right.available &&
    left.message === right.message &&
    left.branch === right.branch &&
    left.dirty === right.dirty &&
    left.count === right.count
  );
}

function actionState(status) {
  if (!status) {
    return "pending";
  }

  if (status.available === false) {
    return "unavailable";
  }

  return "available";
}
