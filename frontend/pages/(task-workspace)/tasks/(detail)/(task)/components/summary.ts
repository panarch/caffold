import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
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
 *
 * The Tasks Detail layout hands it the Task's snapshot and reads its Action
 * Hints and keyboard context right after, so it draws at once.
 */
export class CaffoldTaskDetailSummary extends LitElement {
  private snapshot: TaskInfoSnapshot = taskInfoSnapshot();

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  setSnapshot(snapshot: Partial<TaskInfoSnapshot> = {}) {
    this.snapshot = taskInfoSnapshot(snapshot);
    this.requestUpdate();
    this.performUpdate();
  }

  deactivate() {
    this.taskInfo()?.deactivate();
  }

  actionHintScope(options: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    return this.taskInfo()?.actionHintScope(options) ?? emptyActionHintScope();
  }

  keyboardNavigationContexts(options: { scopeId?: string } = {}) {
    this.performUpdate();
    return this.taskInfo()?.keyboardNavigationContexts(options) ?? [];
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

  private taskInfo() {
    return this.querySelector<CaffoldTaskDetailInfo>(
      "caffold-task-detail-info",
    );
  }
}

customElements.define("caffold-task-detail-summary", CaffoldTaskDetailSummary);
