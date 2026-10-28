import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type ActionHintPull,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "./summary/components/info.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  type CaffoldTaskDetailInfo,
  type TaskInfoIntent,
  type TaskInfoSnapshot,
  taskInfoSnapshot,
} from "./summary/components/info.js";

import styles from "./summary.css.js";

export type { TaskInfoSnapshot };

// What the summary asks of the Task screen: one of Task Info's actions.
export type TaskSummaryIntent = TaskInfoIntent;

/**
 * The open Task's heading: its title, and Task Info beside it.
 */
@customElement("caffold-task-detail-summary")
export class CaffoldTaskDetailSummary extends CaffoldElement {
  @state()
  private accessor snapshot: TaskInfoSnapshot = taskInfoSnapshot();

  static override styles = styles;

  private readonly info = new DrawnRef<CaffoldTaskDetailInfo>(this);

  override disconnectedCallback() {
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

  override render() {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-summary": CaffoldTaskDetailSummary;
  }

  interface HTMLElementEventMap {
    "caffold:task-detail-summary-intent": CustomEvent<TaskSummaryIntent>;
  }
}
