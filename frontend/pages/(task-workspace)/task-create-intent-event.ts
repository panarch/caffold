import type { ComposerSubmission } from "./tasks/components/composer.js";
import type { TurnSubmissionOptions } from "./tasks/components/task-turn-options.js";

export const TASK_CREATE_INTENT_EVENT = "caffold:task-create-intent";

// A request to start a Task, with as much of a submission as its asker has.
// The owner that takes it sets `accepted` and the `completion` that settles
// once the new Task holds the submission.
export interface TaskStartIntent {
  type: "start";
  request: {
    cwd?: string;
    titleSource: string;
  } & Partial<TurnSubmissionOptions>;
  submission: Partial<ComposerSubmission>;
  accepted: boolean;
  completion: Promise<unknown> | null;
}

export type TaskCreateIntentDetail =
  | { type: "choose-cwd"; path: string }
  | TaskStartIntent;

declare global {
  interface HTMLElementEventMap {
    [TASK_CREATE_INTENT_EVENT]: CustomEvent<TaskCreateIntentDetail>;
  }
}
