import { getTaskStoreStatus, retryTaskStoreMigration } from "../../api.js";
import {
  TaskStoreStatusLifecycle,
  type TaskStoreStatusLifecycleOptions,
} from "./task-store-status/lifecycle.js";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
} from "./task-store-status/model.js";

export type {
  TaskOperationsPresentation,
  TaskStoreStatusSnapshot,
} from "./task-store-status/model.js";

// What a screen asks when the person retries a failed store upgrade.
export const TASK_STORE_RETRY_REQUEST_EVENT =
  "caffold:request-task-store-retry";

export {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
};

export function createTaskStoreStatusLifecycle({
  loadStatus = getTaskStoreStatus,
  retryMigration = retryTaskStoreMigration,
  onSnapshotChange,
}: Partial<
  Pick<
    TaskStoreStatusLifecycleOptions,
    "loadStatus" | "retryMigration" | "onSnapshotChange"
  >
> = {}) {
  return new TaskStoreStatusLifecycle({
    loadStatus,
    retryMigration,
    onSnapshotChange,
  });
}
