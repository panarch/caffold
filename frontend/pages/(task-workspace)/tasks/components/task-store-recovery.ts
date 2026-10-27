import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  TASK_STORE_RETRY_REQUEST_EVENT,
  type TaskStoreStatusSnapshot,
} from "#app/pages/(task-workspace)/task-store-status.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

const PREPARING_MESSAGE =
  "Caffold is preparing the local Task navigator before Tasks start.";
const FAILED_MESSAGE =
  "Caffold could not finish preparing the local Task navigator.";
const PREPARING_INSTRUCTION =
  "This finishes automatically when the local upgrade succeeds.";
const FAILED_INSTRUCTION =
  "Retry the upgrade. The existing Task database remains unchanged until it succeeds.";

/**
 * What the Tasks screen shows instead of Tasks while the Task store is being
 * upgraded, or after its upgrade failed and can be retried.
 */
export class CaffoldTaskStoreRecovery extends LitElement {
  static properties = {
    snapshot: { state: true },
  };

  declare private snapshot: TaskStoreStatusSnapshot;
  private readonly surface = new DrawnRef<HTMLElement>(this);
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.surface.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);

  constructor() {
    super();
    this.snapshot = INITIAL_TASK_STORE_STATUS_SNAPSHOT;
  }

  createRenderRoot() {
    return this;
  }

  setSnapshot(snapshot: TaskStoreStatusSnapshot | null | undefined) {
    const next = snapshot ?? INITIAL_TASK_STORE_STATUS_SNAPSHOT;
    if (this.snapshot === next) {
      return;
    }
    this.snapshot = next;
  }

  actionHintScope({
    scopeId = "task-store-recovery",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "task-store-recovery",
    label = "Task setup",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  render() {
    const readiness = this.snapshot.readiness;
    const failed = readiness?.state === "failed";
    const diagnostic = readiness?.diagnosticMessage ?? "";
    const retry = failed ? "Retry Task setup" : "Preparing…";
    return html`
      <section
        ${drawn(this.surface)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.surface.value],
        })}
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
              ${this.hints.button({
                id: "retry",
                label: retry,
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-task-store-recovery-action="retry"
              ?disabled=${!this.snapshot.retryAvailable}
              @click=${this.requestRetry}
            >${retry}</button>
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
