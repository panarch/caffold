// What TypeScript modules use from stream.js while it is still JavaScript.
// It goes when that module moves to TypeScript.

import type {
  LiveSubscription,
  LiveSubscriptionListener,
} from "../live-updates.js";
import type { TaskTransportState } from "./runtime-state.js";

// How a recovery ended: reconciled, failed with `error`, or `stale` because a
// newer request took its place.
export interface TaskStreamRecovery {
  ok: boolean;
  stale?: boolean;
  error?: unknown;
}

// One owner's Task stream on the workspace gateway.
export class TaskStreamLifecycle {
  constructor(options: {
    subscribe: (
      contextKey: string,
      listener: LiveSubscriptionListener,
    ) => LiveSubscription;
    // Each gateway event, with its payload as JSON text.
    onEvent: (type: string, event: { data: string }) => void;
    onReconcile: (
      contextKey: string,
      isCurrent: () => boolean,
      metadata?: { recovery?: boolean },
    ) => Promise<unknown>;
    onStateChange: (
      state: TaskTransportState,
      previousState: TaskTransportState,
    ) => void;
  });
  readonly state: TaskTransportState;
  activate(contextKey: string): void;
  retry(options?: { reconcile?: boolean }): void;
  suspend(): void;
  recover(contextKey?: string): Promise<TaskStreamRecovery>;
  deactivate(): void;
}
