// What TypeScript modules use from stream.js while it is still JavaScript.
// It goes when that module moves to TypeScript.

import type { TaskAbsence } from "#app/api.js";
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
    subscribe:
      | ((
          contextKey: string,
          listener: LiveSubscriptionListener,
        ) => LiveSubscription)
      | null;
    // Each gateway event, with its payload as JSON text, and the subscription
    // it came through.
    onEvent: (
      type: string,
      event: { data: string },
      contextKey: string,
      metadata: { source: LiveSubscription },
    ) => void;
    onReconcile?: (
      contextKey: string,
      isCurrent: () => boolean,
      metadata?: { recovery?: boolean },
    ) => Promise<unknown>;
    onStateChange: (
      state: TaskTransportState,
      previousState: TaskTransportState,
    ) => void;
    // An owner that reads its own bootstrap from the stream says when the
    // stream is ready, in place of a reconcile.
    waitUntilReady?: (
      contextKey: string,
      isCurrent: () => boolean,
      metadata: { recovery: boolean; source: LiveSubscription },
    ) => Promise<boolean>;
    onConnectionInvalidated?: (source: LiveSubscription) => void;
    onSubjectGone?: (absence: TaskAbsence, contextKey: string) => void;
    retryDelaysMs?: number[];
  });
  readonly state: TaskTransportState;
  readonly contextKey: string;
  activate(
    contextKey: string,
    options?: { force?: boolean; validating?: boolean },
  ): void;
  retry(options?: { reconcile?: boolean }): void;
  suspend(): void;
  recover(contextKey?: string): Promise<TaskStreamRecovery>;
  deactivate(): void;
  // Another request found the Task archived or missing.
  subjectGone(absence: TaskAbsence): void;
}
