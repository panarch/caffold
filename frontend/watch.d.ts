// What TypeScript modules use from watch.js while it is still JavaScript. It
// goes when that module moves to TypeScript.

export type RefreshState = "refreshing" | "idle" | "error";

export interface RefreshCoordinator {
  request(): Promise<void>;
  readonly active: boolean;
}

export function createRefreshCoordinator(
  refresh: () => Promise<void>,
  onState?: (state: RefreshState, error?: unknown) => void,
): RefreshCoordinator;

export interface WatchChange {
  paths?: string[];
  overflow?: boolean;
  revision?: unknown;
}

export function subscribeToWatch(
  liveUpdates: unknown,
  path: string,
  listener: {
    onReady?: (ready: { recovered: boolean }) => void;
    onChange?: (change: WatchChange) => void;
    onRecover?: () => void;
    onError?: (error: unknown) => void;
  },
): () => void;
