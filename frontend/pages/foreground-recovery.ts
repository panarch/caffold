import type { LiveConnectionReport } from "./(task-workspace)/live-updates.ts";
import {
  ForegroundRecoveryDiagnostics,
  type ForegroundRecoveryDiagnosticsOptions,
} from "./foreground-recovery/diagnostics.ts";
import {
  ForegroundRecoveryRuntime,
  type ForegroundRecoveryRuntimeOptions,
  type ForegroundRecoveryRuntimeSnapshot,
  type RecoveryAttempt,
} from "./foreground-recovery/lifecycle.ts";
import {
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRIGGER,
  type ForegroundRecoveryNode,
  selectForegroundRecoveryPresentation,
} from "./foreground-recovery/machine.ts";

// Public presentation contract consumed by the App Shell notice.
export const FOREGROUND_RECOVERY_PRESENTATION = Object.freeze({
  NONE: "none",
  RECONNECTING: "reconnecting",
  OFFLINE: "offline",
  UNAVAILABLE: "unavailable",
});

export type ForegroundRecoveryPresentation =
  (typeof FOREGROUND_RECOVERY_PRESENTATION)[keyof typeof FOREGROUND_RECOVERY_PRESENTATION];

// What one recovery attempt asks of the app shell: the route a notification
// opens, whether this is the first activation, whether the attempt is still
// the current one, and where to report how far it got.
export interface ForegroundRecoveryRequest {
  activationRoute: string;
  initialActivation: boolean;
  isCurrent(): boolean;
  progress: ReturnType<typeof foregroundRecoveryProgress>;
}

// What recovery shows, which attempt it is on, and what started it.
export interface ForegroundRecoverySnapshot {
  generation: number;
  lastTrigger: string | null;
  presentation: ForegroundRecoveryPresentation;
}

// Public feature owner. Browser/runtime details and the control graph remain private.
export class ForegroundRecoveryLifecycle {
  private readonly onStateChange: (
    snapshot: ForegroundRecoverySnapshot,
  ) => void;
  private readonly diagnostics: ForegroundRecoveryDiagnostics;
  private readonly runtime: ForegroundRecoveryRuntime;

  constructor({
    onRecover = () => Promise.resolve(),
    onStateChange = () => {},
    diagnostics = {},
    ...runtimeOptions
  }: Omit<ForegroundRecoveryRuntimeOptions, "onRecover" | "onStateChange"> & {
    onRecover?: (request: ForegroundRecoveryRequest) => Promise<unknown>;
    onStateChange?: (snapshot: ForegroundRecoverySnapshot) => void;
    diagnostics?: ForegroundRecoveryDiagnosticsOptions;
  } = {}) {
    this.onStateChange = onStateChange;
    this.diagnostics = new ForegroundRecoveryDiagnostics(diagnostics);
    this.runtime = new ForegroundRecoveryRuntime({
      ...runtimeOptions,
      onRecover: (request) => onRecover(publicRecoveryRequest(request)),
      onStateChange: (snapshot) => {
        const publicSnapshot = publicRecoverySnapshot(snapshot);
        this.diagnostics.observe(snapshot, publicSnapshot.presentation);
        this.onStateChange(publicSnapshot);
      },
    });
  }

  connect() {
    this.diagnostics.connect();
    this.runtime.connect();
  }

  disconnect() {
    this.runtime.disconnect();
    this.diagnostics.disconnect();
  }

  requestForegroundRecovery() {
    return this.runtime.requestForegroundRecovery();
  }

  requestInitialActivation({
    discarded = false,
  }: {
    discarded?: boolean;
  } = {}) {
    return this.runtime.requestForegroundRecovery({
      intent: FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
      trigger: discarded
        ? FOREGROUND_RECOVERY_TRIGGER.DISCARDED_DOCUMENT
        : FOREGROUND_RECOVERY_TRIGGER.BOOTSTRAP,
    });
  }

  requestManualRetry() {
    return this.runtime.requestForegroundRecovery({
      trigger: FOREGROUND_RECOVERY_TRIGGER.MANUAL_RETRY,
    });
  }

  reportOriginReachable() {
    return this.runtime.reportOriginReachable();
  }

  // One report from the workspace's live connection, timed for the
  // diagnostics as it arrives.
  reportLiveConnection(report: LiveConnectionReport) {
    this.diagnostics.reportConnection(report);
  }

  setTargets(targets: unknown) {
    this.runtime.setTargets(targets);
  }

  snapshot(): ForegroundRecoverySnapshot {
    return publicRecoverySnapshot(this.runtime.snapshot());
  }
}

function publicRecoveryRequest({
  activationRoute,
  intent,
  isCurrent,
  reportStage,
}: RecoveryAttempt): ForegroundRecoveryRequest {
  return Object.freeze({
    activationRoute,
    initialActivation: intent === FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
    isCurrent,
    progress: foregroundRecoveryProgress(reportStage),
  });
}

function foregroundRecoveryProgress(
  reportStage: (nodeType: ForegroundRecoveryNode) => boolean,
) {
  return Object.freeze({
    activatingRoute: () =>
      reportStage(FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE),
    validatingStatus: () =>
      reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS),
    validatingTransports: ({
      detail = false,
      list = false,
    }: {
      detail?: boolean;
      list?: boolean;
    } = {}) => {
      if (list && detail) {
        return reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL);
      }
      if (list) {
        return reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_LIST);
      }
      if (detail) {
        return reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL);
      }
      return false;
    },
  });
}

function publicRecoverySnapshot(
  snapshot: ForegroundRecoveryRuntimeSnapshot,
): ForegroundRecoverySnapshot {
  return Object.freeze({
    generation: snapshot.generation,
    lastTrigger: snapshot.lastTrigger,
    presentation: selectForegroundRecoveryPresentation(
      snapshot,
      FOREGROUND_RECOVERY_PRESENTATION,
    ),
  });
}
