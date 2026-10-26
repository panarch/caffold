// What TypeScript modules use from task-store-status.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

// What the Task store last said about whether it can take Task operations.
export interface TaskStoreStatusSnapshot {
  readiness: {
    state: string;
    blocksTaskOperations: boolean;
    diagnosticMessage: string;
  } | null;
  retryAvailable: boolean;
}

// The snapshot before the store has said anything.
export const INITIAL_TASK_STORE_STATUS_SNAPSHOT: TaskStoreStatusSnapshot;

// What a screen asks when the person retries a failed store upgrade.
export const TASK_STORE_RETRY_REQUEST_EVENT: string;

export function taskStoreBlocksTaskOperations(
  snapshot: TaskStoreStatusSnapshot | null,
): boolean;

// Whether Task operations can run now, and what a blocked control says. `key`
// changes whenever anything else does.
export interface TaskOperationsPresentation {
  key: string;
  phase: string;
  blocked: boolean;
  title: string;
  message: string;
}

export function taskStoreOperationsPresentation(
  snapshot: TaskStoreStatusSnapshot | null,
): TaskOperationsPresentation;

// The workspace's one Task store status: it asks the store, rechecks while an
// upgrade runs, and retries a failed one.
export interface TaskStoreStatusLifecycle {
  connect(): void;
  disconnect(): void;
  suspend(): void;
  resume(): void;
  check(): Promise<unknown>;
  retry(): void;
  snapshot(): TaskStoreStatusSnapshot;
}

export function createTaskStoreStatusLifecycle(options: {
  onSnapshotChange(snapshot: TaskStoreStatusSnapshot): void;
}): TaskStoreStatusLifecycle;
