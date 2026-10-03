import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  TASK_STORE_RETRY_REQUEST_EVENT,
} from "../../task-store-status.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "#app/scroll-scope.js";

class CaffoldTaskStoreRecovery extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureRendered();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
    }
  }

  disconnectedCallback() {
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
    this.snapshotValue = INITIAL_TASK_STORE_STATUS_SNAPSHOT;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.innerHTML = `
      <section class="task-store-recovery-surface" aria-labelledby="task-store-recovery-title">
        <div class="task-store-recovery-card">
          <p class="task-store-recovery-eyebrow">Task setup</p>
          <h2 id="task-store-recovery-title" data-task-store-title></h2>
          <p data-task-store-message role="status"></p>
          <p class="task-store-recovery-instruction"></p>
          <div class="task-store-recovery-actions">
            <button type="button" data-task-store-recovery-action="retry"></button>
          </div>
          <p class="task-store-recovery-diagnostic" hidden></p>
        </div>
      </section>
    `;
    this.patch();
  }

  setSnapshot(snapshot) {
    this.ensureState();
    const nextSnapshot = snapshot ?? INITIAL_TASK_STORE_STATUS_SNAPSHOT;
    if (this.snapshotValue === nextSnapshot) {
      return;
    }
    this.snapshotValue = nextSnapshot;
    this.patch();
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-task-store-recovery-action]")
      : null;
    if (
      !action ||
      !this.contains(action) ||
      action.dataset.taskStoreRecoveryAction !== "retry"
    ) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(TASK_STORE_RETRY_REQUEST_EVENT, { bubbles: true }),
    );
  }

  actionHintScope({
    scopeId = "task-store-recovery",
    clipRoots = [],
  } = {}) {
    this.ensureRendered();
    const scrollport = this.querySelector(
      ":scope > .task-store-recovery-surface",
    );
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const selector = 'button[data-task-store-recovery-action="retry"]';
    const control = this.querySelector(selector);
    const targets = control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control)
      ? [buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:retry`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: control.textContent?.trim() || "Retry Task setup",
          control,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(selector) === control &&
            !control.disabled &&
            !control.hidden &&
            hasActionHintLayoutBox(control),
        })]
      : [];
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "task-store-recovery",
    label = "Task setup",
    clipRoots = [],
  } = {}) {
    this.ensureRendered();
    const scrollport = this.querySelector(
      ":scope > .task-store-recovery-surface",
    );
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(":scope > .task-store-recovery-surface") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  patch() {
    if (!this.rendered) {
      return;
    }
    const readiness = this.snapshotValue.readiness;
    const failed = readiness?.state === "failed";
    const card = this.querySelector(".task-store-recovery-card");
    card.dataset.taskStoreState = readiness?.state ?? "";
    card.querySelector("[data-task-store-title]").textContent = failed
      ? "Task data upgrade failed"
      : "Preparing Tasks…";
    card.querySelector("[data-task-store-message]").textContent = failed
      ? "Caffold could not finish preparing the local Task navigator."
      : "Caffold is preparing the local Task navigator before Tasks start.";
    card.querySelector(".task-store-recovery-instruction").textContent = failed
      ? "Retry the upgrade. The existing Task database remains unchanged until it succeeds."
      : "This finishes automatically when the local upgrade succeeds.";
    const retry = card.querySelector('[data-task-store-recovery-action="retry"]');
    retry.textContent = failed ? "Retry Task setup" : "Preparing…";
    retry.disabled = !this.snapshotValue.retryAvailable;
    const diagnostic = card.querySelector(".task-store-recovery-diagnostic");
    const diagnosticMessage = readiness?.diagnosticMessage ?? "";
    diagnostic.toggleAttribute("hidden", !diagnosticMessage);
    diagnostic.textContent = diagnosticMessage;
  }
}

if (!customElements.get("caffold-task-store-recovery")) {
  customElements.define("caffold-task-store-recovery", CaffoldTaskStoreRecovery);
}
