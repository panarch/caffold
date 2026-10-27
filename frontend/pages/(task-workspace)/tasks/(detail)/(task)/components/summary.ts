import { html, LitElement, nothing } from "lit";
import {
  type ActionHintPull,
  emptyActionHintScope,
} from "#app/action-hints.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import "./summary/components/info.ts";
import {
  type CaffoldTaskDetailInfo,
  type TaskInfoIntent,
  type TaskInfoSnapshot,
  taskInfoSnapshot,
} from "./summary/components/info.ts";

export type { TaskInfoSnapshot };

// What the summary asks of the Task screen: one of Task Info's actions.
export type TaskSummaryIntent = TaskInfoIntent;

/**
 * The open Task's heading: its title, and Task Info beside it.
 */
export class CaffoldTaskDetailSummary extends LitElement {
  static properties = {
    snapshot: { state: true },
  };

  declare private snapshot: TaskInfoSnapshot;
  private readonly info = new DrawnRef<CaffoldTaskDetailInfo>(this);

  constructor() {
    super();
    this.snapshot = taskInfoSnapshot();
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  setSnapshot(snapshot: Partial<TaskInfoSnapshot> = {}) {
    this.snapshot = taskInfoSnapshot(snapshot);
  }

  deactivate() {
    this.info.value?.deactivate();
  }

  detailsButton() {
    return this.info.value?.detailsButton() ?? null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.info.value?.actionHintScope(pull) ?? emptyActionHintScope();
  }

  keyboardNavigationContexts(options: { scopeId?: string } = {}) {
    return this.info.value?.keyboardNavigationContexts(options) ?? [];
  }

  render() {
    const task = this.snapshot.task;
    if (!task) {
      return nothing;
    }
    return html`
      <div class="task-detail-heading">
        <h2 title=${task.title}>${task.title}</h2>
      </div>
      <div class="task-detail-right">
        <caffold-task-detail-info
          ${drawn(this.info)}
          .snapshot=${this.snapshot}
          @caffold:task-detail-info-intent=${this.infoIntent}
        ></caffold-task-detail-info>
      </div>
    `;
  }

  private infoIntent(event: CustomEvent<TaskInfoIntent>) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<TaskSummaryIntent>("caffold:task-detail-summary-intent", {
        bubbles: true,
        composed: true,
        detail: { type: event.detail.type },
      }),
    );
  }
}

customElements.define("caffold-task-detail-summary", CaffoldTaskDetailSummary);
