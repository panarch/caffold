import type { ActiveTaskRecovery, Task } from "#app/api.js";

export const TASK_NAVIGATOR_INTENT_EVENT = "caffold:task-navigator-intent";

// What the list asks of its navigator's owner.
export type ActiveTaskListIntent =
  | { type: "select-task"; threadId: string }
  | {
      type: "select-task-recovery";
      threadId: string;
      recovery: ActiveTaskRecovery;
    }
  | { type: "select-section"; sectionId: string };

// What the list asks of its navigator's owner: deleting a Task needs the
// person to confirm it first.
export interface ArchivedTaskListIntent {
  type: "delete-archived-task";
  task: Task;
}

// What the navigator asks of its owner beside what its lists ask.
export type TaskNavigatorIntent =
  | { type: "open-task-switcher" }
  | { type: "new-task" };

export type TaskNavigatorIntentDetail =
  | ActiveTaskListIntent
  | ArchivedTaskListIntent
  | TaskNavigatorIntent;

declare global {
  interface HTMLElementEventMap {
    [TASK_NAVIGATOR_INTENT_EVENT]: CustomEvent<TaskNavigatorIntentDetail>;
  }
}
