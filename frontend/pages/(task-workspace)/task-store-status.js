import { getTaskStoreStatus, retryTaskStoreMigration } from "../../api.js";
import { TaskStoreStatusLifecycle } from "./task-store-status/lifecycle.js";
import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
} from "./task-store-status/model.js";

export const TASK_STORE_RETRY_REQUEST_EVENT = "caffold:request-task-store-retry";

export {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
};

export function createTaskStoreStatusLifecycle({
  loadStatus = getTaskStoreStatus,
  retryMigration = retryTaskStoreMigration,
  onSnapshotChange,
} = {}) {
  return new TaskStoreStatusLifecycle({
    loadStatus,
    retryMigration,
    onSnapshotChange,
  });
}
