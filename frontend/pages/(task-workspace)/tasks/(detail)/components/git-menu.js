import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../action-hints.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../keyboard-navigation-context.js";
import "../../../components/keyboard-navigation-presentation.js";

const GIT_INTENT_EVENT = "caffold:task-detail-git-intent";
const UNAVAILABLE_TITLE =
  "Git and GitHub are unavailable outside a Git worktree";

let taskDetailGitInstanceId = 0;

class CaffoldTaskDetailGit extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
    }
    if (this.gitTrigger()) {
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
    taskDetailGitInstanceId += 1;
    this.popoverId = `task-git-actions-${taskDetailGitInstanceId}`;
    this.snapshot = { available: false };
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    this.snapshot = { available: Boolean(snapshot.available) };
    if (this.gitTrigger()) {
      this.patch();
    } else {
      this.render();
    }
  }

  deactivate() {
    const popover = this.gitPopover();
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
    const control = this.gitTrigger();
    const popover = this.gitPopover();
    if (!scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: `${scopeId}:git:open`,
        actionId: ACTION_HINT_ACTION.GIT_OPEN,
        label: control.getAttribute("aria-label") || "Open Git workspace",
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.available &&
          this.gitTrigger() === control &&
          this.gitPopover() === popover &&
          control.getAttribute("popovertarget") === popover.id &&
          !control.disabled &&
          !popover.matches(":popover-open"),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({ scopeId = "task-detail" } = {}) {
    const popover = this.gitPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    if (!scopeId || !popover || !dialog || !hud) {
      return [];
    }
    const contextId = `${scopeId}:git`;
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: this.gitActionHintScope({ contextId, popover }),
      },
      scroll: {
        hud,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "Git workspace actions",
          popover,
          isCurrent: () =>
            this.isConnected &&
            this.snapshot.available &&
            this.gitPopover() === popover,
        }),
      },
    })];
  }

  gitActionHintScope({ contextId, popover }) {
    if (!popover) {
      return emptyActionHintScope();
    }
    const targets = [...popover.querySelectorAll(
      ":scope > button[data-git-button-action]",
    )].flatMap((control) => {
      const destination = `${control.dataset.reviewKind ?? ""}`;
      if (!["compare", "log"].includes(destination) || control.disabled) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${contextId}:${destination}`,
        actionId: ACTION_HINT_ACTION.GIT_DESTINATION,
        label: control.textContent?.trim() || destination,
        control,
        clipRoots: [popover],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.available &&
          this.gitPopover() === popover &&
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
    const action = closestElement(event.target, "[data-git-button-action]");
    if (!action || action.matches(":disabled")) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(GIT_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          type: "open-git-tool",
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
        class="task-git-button"
        popovertarget="${this.popoverId}"
      >
        <span class="task-git-icon" aria-hidden="true"></span>
      </button>
      <div
        id="${this.popoverId}"
        class="task-git-popover"
        popover="auto"
        role="group"
        aria-label="Git workspace actions"
      >
        <button
          type="button"
          popovertarget="${this.popoverId}"
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="compare"
        >Compare</button>
        <button
          type="button"
          popovertarget="${this.popoverId}"
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="log"
        >Log</button>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </div>
    `;
    this.patch();
  }

  patch() {
    const trigger = this.gitTrigger();
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
      available ? "Open Git workspace" : "Git unavailable",
    );
    trigger.title = available ? "Open Git workspace" : UNAVAILABLE_TITLE;
  }

  gitTrigger() {
    return this.querySelector(":scope > .task-git-button");
  }

  gitPopover() {
    return this.querySelector(":scope > .task-git-popover");
  }
}

if (!customElements.get("caffold-task-detail-git")) {
  customElements.define("caffold-task-detail-git", CaffoldTaskDetailGit);
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}
