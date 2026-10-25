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
