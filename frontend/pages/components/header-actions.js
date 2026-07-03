import { sameCodexStatus } from "./header-actions/codex-status.js";
import { sameGitStatus } from "./header-actions/git-status.js";
import { sameGithubStatus } from "./header-actions/github-status.js";
import { warmIcons } from "../../components/icons.js";

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
    this.syncActionStatuses();
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
    this.syncActionStatuses();
  }

  get githubStatus() {
    return this.githubStatusValue ?? null;
  }

  set codexStatus(value) {
    const nextValue = value ?? null;
    if (sameCodexStatus(this.codexStatusValue, nextValue)) {
      return;
    }

    this.codexStatusValue = nextValue;
    this.syncActionStatuses();
  }

  get codexStatus() {
    return this.codexStatusValue ?? null;
  }

  render() {
    this.innerHTML = `
      <div class="header-actions" aria-label="Review actions">
        <caffold-git-header-action></caffold-git-header-action>
        <caffold-github-header-action></caffold-github-header-action>
        <caffold-codex-header-action></caffold-codex-header-action>
      </div>
    `;
    this.syncActionStatuses();
  }

  renderKeepingOpenPopover() {
    const openPopover = this.querySelector(".header-actions-popover:not([hidden])");
    const openGroup = openPopover?.dataset.actionGroup;
    this.render();

    if (openGroup) {
      this.openPopoverByGroup(openGroup);
    }
  }

  syncActionStatuses() {
    const gitAction = this.querySelector("caffold-git-header-action");
    const githubAction = this.querySelector("caffold-github-header-action");
    const codexAction = this.querySelector("caffold-codex-header-action");

    if (gitAction) {
      gitAction.status = this.gitStatus;
    }
    if (githubAction) {
      githubAction.status = this.githubStatus;
    }
    if (codexAction) {
      codexAction.status = this.codexStatus;
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

}

customElements.define("caffold-header-actions", CaffoldHeaderActions);
