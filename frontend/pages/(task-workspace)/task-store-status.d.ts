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
