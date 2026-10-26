// What TypeScript modules use from foreground-recovery.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export const FOREGROUND_RECOVERY_PRESENTATION: Readonly<{
  NONE: "none";
  RECONNECTING: "reconnecting";
  OFFLINE: "offline";
  UNAVAILABLE: "unavailable";
}>;

// What one recovery attempt asks of the app shell: the route a notification
// opens, whether this is the first activation, whether the attempt is still
// the current one, and where to report how far it got.
export interface ForegroundRecoveryRequest {
  activationRoute: unknown;
  initialActivation: boolean;
  isCurrent(): boolean;
  progress: {
    activatingRoute(): void;
    validatingStatus(): void;
    validatingTransports(stages: { detail: boolean; list: boolean }): void;
  };
}

// What recovery shows, which attempt it is on, and what started it.
export interface ForegroundRecoverySnapshot {
  generation: number;
  lastTrigger: string;
  presentation: string;
}

// Brings the page's connections back when it returns to the foreground, and
// says how that is going.
export class ForegroundRecoveryLifecycle {
  constructor(options: {
    onRecover(request: ForegroundRecoveryRequest): Promise<unknown>;
    onStateChange(snapshot: ForegroundRecoverySnapshot): void;
    onSuspend(): void;
    diagnostics?: { send(records: unknown[]): Promise<unknown> };
  });
  connect(): void;
  disconnect(): void;
  requestForegroundRecovery(): Promise<unknown>;
  requestInitialActivation(options?: { discarded?: boolean }): Promise<unknown>;
  requestManualRetry(): Promise<unknown>;
  reportOriginReachable(): Promise<unknown>;
  reportLiveConnection(report: unknown): void;
  setTargets(targets: unknown): void;
  snapshot(): ForegroundRecoverySnapshot;
}
