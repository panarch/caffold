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
