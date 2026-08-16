import { ForegroundRecoveryRuntime } from "./foreground-recovery/lifecycle.js";
import {
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRIGGER,
  selectForegroundRecoveryPresentation,
} from "./foreground-recovery/machine.js";

// Public presentation contract consumed by the App Shell notice.
export const FOREGROUND_RECOVERY_PRESENTATION = Object.freeze({
  NONE: "none",
  RECONNECTING: "reconnecting",
  OFFLINE: "offline",
  UNAVAILABLE: "unavailable",
});

// Public feature owner. Browser/runtime details and the control graph remain private.
export class ForegroundRecoveryLifecycle {
  constructor({
    onRecover = () => Promise.resolve(),
    onStateChange = () => {},
    ...runtimeOptions
  } = {}) {
    this.onStateChange = onStateChange;
    this.runtime = new ForegroundRecoveryRuntime({
      ...runtimeOptions,
      onRecover: (request) => onRecover(publicRecoveryRequest(request)),
      onStateChange: (snapshot) =>
        this.onStateChange(publicRecoverySnapshot(snapshot)),
    });
  }

  connect() {
    this.runtime.connect();
  }

  disconnect() {
    this.runtime.disconnect();
  }

  requestForegroundRecovery() {
    return this.runtime.requestForegroundRecovery();
  }

  requestInitialActivation({ discarded = false } = {}) {
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

  setTargets(targets) {
    this.runtime.setTargets(targets);
  }

  snapshot() {
    return publicRecoverySnapshot(this.runtime.snapshot());
  }
}

function publicRecoveryRequest({
  activationRoute,
  intent,
  isCurrent,
  reportStage,
}) {
  return Object.freeze({
    activationRoute,
    initialActivation:
      intent === FOREGROUND_RECOVERY_INTENT.INITIAL_ACTIVATION,
    isCurrent,
    progress: foregroundRecoveryProgress(reportStage),
  });
}

function foregroundRecoveryProgress(reportStage) {
  return Object.freeze({
    activatingRoute: () =>
      reportStage(FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE),
    validatingStatus: () =>
      reportStage(FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS),
    validatingTransports: ({ detail = false, list = false } = {}) => {
      if (list && detail) {
        return reportStage(
          FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
        );
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

function publicRecoverySnapshot(snapshot) {
  return Object.freeze({
    generation: snapshot.generation,
    lastTrigger: snapshot.lastTrigger,
    presentation: selectForegroundRecoveryPresentation(
      snapshot,
      FOREGROUND_RECOVERY_PRESENTATION,
    ),
  });
}
