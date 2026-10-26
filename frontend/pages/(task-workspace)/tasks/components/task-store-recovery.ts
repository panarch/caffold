import { html, LitElement } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  TASK_STORE_RETRY_REQUEST_EVENT,
  type TaskStoreStatusSnapshot,
} from "#app/pages/(task-workspace)/task-store-status.ts";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";

const PREPARING_MESSAGE =
  "Caffold is preparing the local Task navigator before Tasks start.";
const FAILED_MESSAGE =
  "Caffold could not finish preparing the local Task navigator.";
const PREPARING_INSTRUCTION =
  "This finishes automatically when the local upgrade succeeds.";
const FAILED_INSTRUCTION =
  "Retry the upgrade. The existing Task database remains unchanged until it succeeds.";
const RETRY_BUTTON = 'button[data-task-store-recovery-action="retry"]';
const SURFACE = ":scope > .task-store-recovery-surface";

/**
 * What the Tasks screen shows instead of Tasks while the Task store is being
 * upgraded, or after its upgrade failed and can be retried.
 *
 * The Tasks screen hands it each store snapshot and reads its Action Hints
 * and scroll surface right after, so it draws at once.
 */
export class CaffoldTaskStoreRecovery extends LitElement {
  private snapshot: TaskStoreStatusSnapshot =
    INITIAL_TASK_STORE_STATUS_SNAPSHOT;

  createRenderRoot() {
    return this;
  }

  setSnapshot(snapshot: TaskStoreStatusSnapshot | null | undefined) {
    const next = snapshot ?? INITIAL_TASK_STORE_STATUS_SNAPSHOT;
    if (this.snapshot === next) {
      return;
    }
    this.snapshot = next;
    this.requestUpdate();
    this.performUpdate();
  }

  actionHintScope({
    scopeId = "task-store-recovery",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const scrollport = this.querySelector(SURFACE);
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const control = this.querySelector<HTMLButtonElement>(RETRY_BUTTON);
    const targets =
      control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control)
        ? [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: `${scopeId}:retry`,
              actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              label: control.textContent?.trim() || "Retry Task setup",
              control,
              clipRoots: [this, scrollport, ...clipRoots],
              isActionable: () =>
                this.isConnected &&
                !this.hidden &&
                this.querySelector(RETRY_BUTTON) === control &&
                !control.disabled &&
                !control.hidden &&
                hasActionHintLayoutBox(control),
            }),
          ]
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
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    this.performUpdate();
    const scrollport = this.querySelector(SURFACE);
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots],
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(SURFACE) === scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    const readiness = this.snapshot.readiness;
    const failed = readiness?.state === "failed";
    const diagnostic = readiness?.diagnosticMessage ?? "";
    return html`
      <section
        class="task-store-recovery-surface"
        aria-labelledby="task-store-recovery-title"
      >
        <div
          class="task-store-recovery-card"
          data-task-store-state=${readiness?.state ?? ""}
        >
          <p class="task-store-recovery-eyebrow">Task setup</p>
          <h2 id="task-store-recovery-title" data-task-store-title>${
            failed ? "Task data upgrade failed" : "Preparing Tasks…"
          }</h2>
          <p data-task-store-message role="status">${
            failed ? FAILED_MESSAGE : PREPARING_MESSAGE
          }</p>
          <p class="task-store-recovery-instruction">${
            failed ? FAILED_INSTRUCTION : PREPARING_INSTRUCTION
          }</p>
          <div class="task-store-recovery-actions">
            <button
              type="button"
              data-task-store-recovery-action="retry"
              ?disabled=${!this.snapshot.retryAvailable}
              @click=${this.requestRetry}
            >${failed ? "Retry Task setup" : "Preparing…"}</button>
          </div>
          <p class="task-store-recovery-diagnostic" ?hidden=${!diagnostic}>${
            diagnostic
          }</p>
        </div>
      </section>
    `;
  }

  private requestRetry() {
    this.dispatchEvent(
      new CustomEvent(TASK_STORE_RETRY_REQUEST_EVENT, { bubbles: true }),
    );
  }
}

customElements.define("caffold-task-store-recovery", CaffoldTaskStoreRecovery);
