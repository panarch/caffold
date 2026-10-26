import { getTaskStoreStatus, retryTaskStoreMigration } from "../../api.ts";
import {
  TaskStoreStatusLifecycle,
  type TaskStoreStatusLifecycleOptions,
} from "./task-store-status/lifecycle.ts";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
} from "./task-store-status/model.ts";

export type {
  TaskOperationsPresentation,
  TaskStoreStatusSnapshot,
} from "./task-store-status/model.ts";

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
