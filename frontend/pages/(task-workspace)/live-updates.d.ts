// What TypeScript modules use from live-updates.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

// What a subscriber hears from its channel on the workspace gateway.
export interface LiveSubscriptionListener {
  onOpen(): void;
  onError(
    error: unknown,
    options?: { exhausted?: boolean; physical?: boolean },
  ): void;
  onEvent(type: string, payload: unknown): void;
  onInvalidated(): void;
}

// One subscription on the gateway.
export interface LiveSubscription {
  close(): void;
  retry(): void;
}

// The workspace's one live connection, shared by its channels.
export class WorkspaceLiveUpdates {
  subscribeTaskList(listener: LiveSubscriptionListener): LiveSubscription;
  retry(): void;
}
