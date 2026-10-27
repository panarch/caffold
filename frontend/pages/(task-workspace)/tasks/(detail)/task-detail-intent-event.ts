import type { ActiveTask, ActiveTaskTopPlacement, Task } from "#app/api.js";
import type { ParsedRoute } from "#app/navigation-routes.js";

export const TASK_DETAIL_INTENT_EVENT = "caffold:task-detail-intent";

// What the dialog tells the Task screen: the Task is gone, or the delete
// failed and the Task's diagnosis is now this.
export type BrokenTaskDeleteIntent =
  | { type: "task-deleted"; threadId: string }
  | { type: "broken-delete-error"; error: unknown };

// What a request about the record tells the Task screen when it fails: the
// conversation decides what the failure says about the Task itself.
export interface TaskRequestFailedIntent {
  type: "task-request-failed";
  threadId: string;
  error: unknown;
}

// What a Task's or Section's Detail tells the Tasks screen.
export type TaskDetailIntent =
  | BrokenTaskDeleteIntent
  | TaskRequestFailedIntent
  | { type: "task-archived"; task: Task }
  | {
      type: "task-restored";
      task: ActiveTask;
      activeTopPlacement: ActiveTaskTopPlacement;
    }
  | { type: "review-route" | "domain-route"; route: ParsedRoute };

declare global {
  interface HTMLElementEventMap {
    [TASK_DETAIL_INTENT_EVENT]: CustomEvent<TaskDetailIntent>;
  }
}
