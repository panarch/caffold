import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../action-hints.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../../../keyboard-navigation.js";
import "../../../../../keyboard-navigation/components/presentation.js";

const GITHUB_INTENT_EVENT = "caffold:task-detail-github-intent";
const UNAVAILABLE_TITLE =
  "Git and GitHub are unavailable outside a Git worktree";

let taskDetailGithubInstanceId = 0;

class CaffoldTaskDetailGithub extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
    }
    if (this.githubTrigger()) {
      this.patch();
    } else {
      this.render();
    }
  }

  disconnectedCallback() {
    this.deactivate();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    taskDetailGithubInstanceId += 1;
    this.popoverId = `task-github-actions-${taskDetailGithubInstanceId}`;
    this.snapshot = { available: false };
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    this.snapshot = { available: Boolean(snapshot.available) };
    if (this.githubTrigger()) {
      this.patch();
    } else {
      this.render();
    }
  }

  deactivate() {
    const popover = this.githubPopover();
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  actionHintScope({ scopeId = "task-detail", clipRoots = [] } = {}) {
    this.ensureState();
    const control = this.githubTrigger();
    const popover = this.githubPopover();
    if (!scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: `${scopeId}:github:open`,
        actionId: ACTION_HINT_ACTION.GITHUB_OPEN,
        label: control.getAttribute("aria-label") || "Open GitHub workspace",
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.available &&
          this.githubTrigger() === control &&
          this.githubPopover() === popover &&
          control.getAttribute("popovertarget") === popover.id &&
          !control.disabled &&
          !popover.matches(":popover-open"),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({ scopeId = "task-detail" } = {}) {
    const popover = this.githubPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!scopeId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:github`;
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: this.githubActionHintScope({ contextId, popover }),
      },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "GitHub workspace actions",
          popover,
          isCurrent: () =>
            this.isConnected &&
            this.snapshot.available &&
            this.githubPopover() === popover,
        }),
      },
    })];
  }

  githubActionHintScope({ contextId, popover }) {
    if (!popover) {
      return emptyActionHintScope();
    }
    const targets = [...popover.querySelectorAll(
      ":scope > button[data-github-button-action]",
    )].flatMap((control) => {
      const destination = `${control.dataset.reviewKind ?? ""}`;
      if (!["pulls", "issues"].includes(destination) || control.disabled) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${contextId}:${destination}`,
        actionId: ACTION_HINT_ACTION.GITHUB_DESTINATION,
        label: control.textContent?.trim() || destination,
        control,
        clipRoots: [popover],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.available &&
          this.githubPopover() === popover &&
          popover.matches(":popover-open") &&
          popover.contains(control) &&
          control.dataset.reviewKind === destination &&
          !control.disabled,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [popover],
      scrollRoots: [popover],
    };
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-github-button-action]");
    if (!action || action.matches(":disabled")) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(GITHUB_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          type: "open-github-tool",
          reviewKind: action.dataset.reviewKind ?? null,
        },
      }),
    );
  }

  render() {
    this.ensureState();
    this.innerHTML = `
      <button
        type="button"
        class="task-github-button"
        popovertarget="${this.popoverId}"
      >
        <span class="task-github-icon" aria-hidden="true"></span>
      </button>
      <div
        id="${this.popoverId}"
        class="task-github-popover"
        popover="auto"
        role="group"
        aria-label="GitHub workspace actions"
      >
        <button
          type="button"
          popovertarget="${this.popoverId}"
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="pulls"
        >Pull Requests</button>
        <button
          type="button"
          popovertarget="${this.popoverId}"
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="issues"
        >Issues</button>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </div>
    `;
    this.patch();
  }

  patch() {
    const trigger = this.githubTrigger();
    if (!trigger) {
      return;
    }
    const available = this.snapshot.available;
    if (!available) {
      this.deactivate();
    }
    trigger.disabled = !available;
    trigger.setAttribute(
      "aria-label",
      available ? "Open GitHub workspace" : "GitHub unavailable",
    );
    trigger.title = available ? "Open GitHub workspace" : UNAVAILABLE_TITLE;
  }

  githubTrigger() {
    return this.querySelector(":scope > .task-github-button");
  }

  githubPopover() {
    return this.querySelector(":scope > .task-github-popover");
  }
}

if (!customElements.get("caffold-task-detail-github")) {
  customElements.define("caffold-task-detail-github", CaffoldTaskDetailGithub);
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
