// Control graph

export const FOREGROUND_RECOVERY_NODE = Object.freeze({
  // The lifecycle owns no browser listeners and permits no foreground work.
  DETACHED: "detached",

  // The lifecycle is connected but the document is hidden; work stays pending.
  SUSPENDED: "suspended",

  // The visible document has no active recovery or retry timer.
  READY: "ready",

  // The page is reading the backend's canonical readiness snapshot.
  VALIDATING_STATUS: "validating-status",

  // A requested or readiness-gated Task route is being applied.
  ACTIVATING_ROUTE: "activating-route",

  // Only the active Task-list projection and transport are reconciling.
  VALIDATING_LIST: "validating-list",

  // Only the selected Task-detail projection and transport are reconciling.
  VALIDATING_DETAIL: "validating-detail",

  // Task list and selected detail are reconciling concurrently.
  VALIDATING_LIST_AND_DETAIL: "validating-list-and-detail",

  // A bounded retry delay is running while the page remains usable and visible.
  BACKING_OFF: "backing-off",

  // Connectivity is known unavailable, so HTTP, SSE, and retry work are paused.
  OFFLINE: "offline",

  // The bounded retry budget is spent; explicit global Retry remains available.
  EXHAUSTED: "exhausted",
});

// Complete control graph. No reducer branch may move a node outside this table.
export const FOREGROUND_RECOVERY_TRANSITIONS = Object.freeze({
  [FOREGROUND_RECOVERY_NODE.DETACHED]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
  ]),
  [FOREGROUND_RECOVERY_NODE.SUSPENDED]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  ]),
  [FOREGROUND_RECOVERY_NODE.READY]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  ]),
  [FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ]),
  [FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ]),
  [FOREGROUND_RECOVERY_NODE.VALIDATING_LIST]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ]),
  [FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ]),
  [FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.READY,
    FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
    FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
  ]),
  [FOREGROUND_RECOVERY_NODE.BACKING_OFF]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.BACKING_OFF,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  ]),
  [FOREGROUND_RECOVERY_NODE.OFFLINE]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  ]),
  [FOREGROUND_RECOVERY_NODE.EXHAUSTED]: Object.freeze([
    FOREGROUND_RECOVERY_NODE.EXHAUSTED,
    FOREGROUND_RECOVERY_NODE.DETACHED,
    FOREGROUND_RECOVERY_NODE.SUSPENDED,
    FOREGROUND_RECOVERY_NODE.OFFLINE,
    FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  ]),
});

// Nodes entered while one recovery attempt actively owns foreground work.
const ATTEMPT_STAGE_NODES = new Set([
  FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
  FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
  FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
  FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
]);

// Reducer events

export const FOREGROUND_RECOVERY_EVENT = Object.freeze({
  // Browser facts changed without directly choosing a control node.
  OBSERVATION_UPDATED: "observation-updated",

  // Task list or detail published a new transport projection.
  TARGETS_UPDATED: "targets-updated",

  // The lifecycle attached its browser listeners.
  CONNECTED: "connected",

  // The lifecycle detached and invalidated all outstanding work.
  DISCONNECTED: "disconnected",

  // The document became unusable while hidden.
  SUSPENDED: "suspended",

  // Connectivity became definitely unavailable.
  WENT_OFFLINE: "went-offline",

  // A recovery request must wait for visibility or current work to finish.
  REQUEST_QUEUED: "request-queued",

  // A compatible hint was absorbed by the current in-flight attempt.
  REQUEST_COALESCED: "request-coalesced",

  // One status-first recovery generation began.
  ATTEMPT_STARTED: "attempt-started",

  // The recovery owner reported its current validation stage.
  STAGE_ENTERED: "stage-entered",

  // The current generation completed successfully.
  ATTEMPT_SETTLED: "attempt-settled",

  // A newer coalesced hint made a network failure stale.
  ATTEMPT_SUPERSEDED: "attempt-superseded",

  // A bounded delay began before the next attempt.
  BACKOFF_STARTED: "backoff-started",

  // The bounded retry budget was exhausted.
  RETRY_EXHAUSTED: "retry-exhausted",
});

// Recovery request contract

// Trigger is bounded diagnostic provenance, never a node, edge, or UI message.
export const FOREGROUND_RECOVERY_TRIGGER = Object.freeze({
  // The normal application bootstrap requested initial foreground activation.
  BOOTSTRAP: "bootstrap",

  // A newly loaded document replaced one the browser had discarded.
  DISCARDED_DOCUMENT: "discarded",

  // An already initialized app shell reconnected to the document.
  APP_RECONNECTED: "reconnect",

  // The document became visible again.
  DOCUMENT_VISIBLE: "visibility",

  // The browser restored the document from its back-forward cache.
  BFCACHE_RESTORED: "pageshow",

  // Page Lifecycle resumed a previously frozen document.
  DOCUMENT_RESUMED: "resume",

  // The top-level window regained focus after losing it.
  WINDOW_FOCUSED: "focus",

  // The browser reported that connectivity may be usable again.
  NETWORK_ONLINE: "online",

  // Network Information reported a meaningful connection-type edge.
  CONNECTION_CHANGED: "connection",

  // The service worker focused this page for a validated notification route.
  NOTIFICATION_ACTIVATED: "notification",

  // The user invoked the one global recovery Retry action.
  MANUAL_RETRY: "manual-retry",
});

// Intent selects workspace work without adding another control-graph dimension.
export const FOREGROUND_RECOVERY_INTENT = Object.freeze({
  // Existing bootstrap owns initial status and transport construction.
  INITIAL_ACTIVATION: "initial-activation",

  // An existing document must refresh status and reconcile active transports.
  RECONCILE: "reconcile",
});

// State reduction

export function createForegroundRecoveryState({ observation, targets } = {}) {
  return freezeState({
    node: createNode(FOREGROUND_RECOVERY_NODE.DETACHED),
    generation: 0,
    // The latest bounded diagnostic label; never an edge or UI message.
    lastTrigger: null,
    observation: normalizeObservation(observation),
    targets: normalizeTargets(targets),
    // The request currently owned by this generation.
    activeRequest: null,
    // Distinct work that must run after visibility or the active generation.
    pendingRequest: null,
    // A compatible hint absorbed by the active generation.
    coalescedRequest: null,
  });
}

export function transitionForegroundRecovery(state, event = {}) {
  switch (event.type) {
    case FOREGROUND_RECOVERY_EVENT.OBSERVATION_UPDATED: {
      const observation = normalizeObservation(event.observation);
      if (observationsEqual(state.observation, observation)) {
        return state;
      }
      return replaceState(state, {
        observation,
      });
    }
    case FOREGROUND_RECOVERY_EVENT.TARGETS_UPDATED: {
      const targets = normalizeTargets(event.targets);
      if (targetsEqual(state.targets, targets)) {
        return state;
      }
      return replaceState(state, {
        targets,
      });
    }
    case FOREGROUND_RECOVERY_EVENT.CONNECTED: {
      const observation = normalizeObservation(event.observation);
      const type = observation.visibility !== "visible"
        ? FOREGROUND_RECOVERY_NODE.SUSPENDED
        : isDefinitelyOfflineObservation(observation)
          ? FOREGROUND_RECOVERY_NODE.OFFLINE
          : FOREGROUND_RECOVERY_NODE.READY;
      return transitionNode(state, type, {
        attempt: 0,
        changes: { observation },
      });
    }
    case FOREGROUND_RECOVERY_EVENT.DISCONNECTED: {
      const generation = state.generation + 1;
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.DETACHED, {
        attempt: 0,
        changes: {
          generation,
          activeRequest: null,
          pendingRequest: null,
          coalescedRequest: null,
        },
      });
    }
    case FOREGROUND_RECOVERY_EVENT.SUSPENDED: {
      const generation = state.generation + 1;
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.SUSPENDED, {
        attempt: 0,
        changes: {
          generation,
          activeRequest: null,
          pendingRequest: requestToResume(state),
          coalescedRequest: null,
        },
      });
    }
    case FOREGROUND_RECOVERY_EVENT.WENT_OFFLINE: {
      const generation = state.generation + 1;
      const nodeType = state.observation.visibility === "visible"
        ? FOREGROUND_RECOVERY_NODE.OFFLINE
        : FOREGROUND_RECOVERY_NODE.SUSPENDED;
      return transitionNode(state, nodeType, {
        attempt: 0,
        changes: {
          generation,
          activeRequest: null,
          pendingRequest: requestToResume(state),
          coalescedRequest: null,
        },
      });
    }
    case FOREGROUND_RECOVERY_EVENT.REQUEST_QUEUED:
      return replaceState(state, {
        pendingRequest: mergePendingRequest(state.pendingRequest, event.request),
        lastTrigger: event.request?.trigger ?? state.lastTrigger,
      });
    case FOREGROUND_RECOVERY_EVENT.REQUEST_COALESCED:
      return replaceState(state, {
        coalescedRequest: normalizeRecoveryRequest(event.request),
        lastTrigger: event.request?.trigger ?? state.lastTrigger,
      });
    case FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED: {
      const generation = state.generation + 1;
      return transitionNode(
        state,
        FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
        {
          attempt: event.attempt,
          changes: {
            generation,
            lastTrigger: event.request?.trigger ?? state.lastTrigger,
            activeRequest: {
              activationRoute: event.request?.activationRoute ?? "",
              intent: event.request?.intent ??
                FOREGROUND_RECOVERY_INTENT.RECONCILE,
              trigger: event.request?.trigger ??
                FOREGROUND_RECOVERY_TRIGGER.APP_RECONNECTED,
            },
            pendingRequest: null,
            coalescedRequest: null,
          },
        },
      );
    }
    case FOREGROUND_RECOVERY_EVENT.STAGE_ENTERED: {
      if (
        event.generation !== state.generation ||
        !ATTEMPT_STAGE_NODES.has(event.nodeType)
      ) {
        return state;
      }
      return transitionNode(state, event.nodeType, {
        attempt: state.node.attempt,
      });
    }
    case FOREGROUND_RECOVERY_EVENT.ATTEMPT_SETTLED:
      if (event.generation !== state.generation) {
        return state;
      }
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.READY, {
        attempt: 0,
        changes: {
          activeRequest: null,
          coalescedRequest: null,
        },
      });
    case FOREGROUND_RECOVERY_EVENT.ATTEMPT_SUPERSEDED:
      if (event.generation !== state.generation) {
        return state;
      }
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.READY, {
        attempt: 0,
        changes: {
          activeRequest: null,
          pendingRequest: mergePendingRequest(
            state.pendingRequest,
            state.coalescedRequest,
          ),
          coalescedRequest: null,
        },
      });
    case FOREGROUND_RECOVERY_EVENT.BACKOFF_STARTED:
      if (event.generation !== state.generation) {
        return state;
      }
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.BACKING_OFF, {
        attempt: event.attempt,
        changes: {
          activeRequest: null,
          coalescedRequest: null,
        },
      });
    case FOREGROUND_RECOVERY_EVENT.RETRY_EXHAUSTED:
      if (event.generation !== state.generation) {
        return state;
      }
      return transitionNode(state, FOREGROUND_RECOVERY_NODE.EXHAUSTED, {
        attempt: event.attempt,
        changes: {
          activeRequest: null,
          coalescedRequest: null,
        },
      });
    default:
      return state;
  }
}

// Presentation projection. The public entrypoint supplies its presentation
// contract so the private machine does not declare or export public UI values.
export function selectForegroundRecoveryPresentation(state, presentation) {
  if (state.node.type === FOREGROUND_RECOVERY_NODE.OFFLINE) {
    return presentation.OFFLINE;
  }
  if (
    state.node.type === FOREGROUND_RECOVERY_NODE.BACKING_OFF ||
    (ATTEMPT_STAGE_NODES.has(state.node.type) && state.node.attempt > 0)
  ) {
    return presentation.RECONNECTING;
  }
  if (
    state.node.type === FOREGROUND_RECOVERY_NODE.EXHAUSTED ||
    requiredTargetHasTransport(state.targets, "unavailable")
  ) {
    return presentation.UNAVAILABLE;
  }
  if (requiredTargetHasTransport(state.targets, "reconnecting")) {
    return presentation.RECONNECTING;
  }
  return presentation.NONE;
}

// Pure state and request helpers

function createNode(type, attempt = 0) {
  return Object.freeze({
    attempt: Number.isInteger(attempt) && attempt >= 0 ? attempt : 0,
    type,
  });
}

function replaceState(state, changes) {
  return freezeState({ ...state, ...changes });
}

function transitionNode(
  state,
  nodeType,
  {
    attempt = state.node.attempt,
    changes = {},
  } = {},
) {
  if (!FOREGROUND_RECOVERY_TRANSITIONS[state.node.type]?.includes(nodeType)) {
    return state;
  }
  return replaceState(state, {
    ...changes,
    node: createNode(nodeType, attempt),
  });
}

function freezeState(state) {
  return Object.freeze({
    ...state,
    node: Object.freeze({ ...state.node }),
    observation: normalizeObservation(state.observation),
    targets: normalizeTargets(state.targets),
    activeRequest: state.activeRequest
      ? Object.freeze({ ...state.activeRequest })
      : null,
    pendingRequest: state.pendingRequest
      ? Object.freeze({ ...state.pendingRequest })
      : null,
    coalescedRequest: state.coalescedRequest
      ? Object.freeze({ ...state.coalescedRequest })
      : null,
  });
}

function normalizeObservation(observation = {}) {
  return Object.freeze({
    focused: observation.focused !== false,
    visibility: observation.visibility === "visible" ? "visible" : "hidden",
    network: Object.freeze({
      onlineHint: observation.network?.onlineHint !== false,
      connectionType: normalizeNullableString(
        observation.network?.connectionType,
      ),
      effectiveType: normalizeNullableString(
        observation.network?.effectiveType,
      ),
    }),
  });
}

function normalizeTargets(targets = {}) {
  return Object.freeze({
    list: normalizeTarget(targets.list),
    detail: normalizeTarget(targets.detail),
  });
}

function normalizeTarget(target = {}) {
  const transport = [
    "inactive",
    "idle",
    "connecting",
    "ready",
    "validating",
    "reconnecting",
    "unavailable",
  ].includes(target?.transport)
    ? target.transport
    : "inactive";
  return Object.freeze({
    active: Boolean(target?.active),
    content: target?.content === "present" ? "present" : "absent",
    transport,
  });
}

function normalizeActivationRoute(route) {
  return typeof route === "string" ? route : "";
}

export function normalizeRecoveryRequest(request = {}) {
  return Object.freeze({
    activationRoute: normalizeActivationRoute(request.activationRoute),
    intent: normalizeRecoveryIntent(request.intent),
    trigger: normalizeRecoveryTrigger(request.trigger),
  });
}

function normalizeRecoveryIntent(intent) {
  return Object.values(FOREGROUND_RECOVERY_INTENT).includes(intent)
    ? intent
    : FOREGROUND_RECOVERY_INTENT.RECONCILE;
}

function normalizeRecoveryTrigger(trigger) {
  return Object.values(FOREGROUND_RECOVERY_TRIGGER).includes(trigger)
    ? trigger
    : FOREGROUND_RECOVERY_TRIGGER.APP_RECONNECTED;
}

function normalizeNullableString(value) {
  return typeof value === "string" ? value : null;
}

function observationsEqual(left, right) {
  return (
    left.focused === right.focused &&
    left.visibility === right.visibility &&
    left.network.onlineHint === right.network.onlineHint &&
    left.network.connectionType === right.network.connectionType &&
    left.network.effectiveType === right.network.effectiveType
  );
}

function targetsEqual(left, right) {
  return ["list", "detail"].every((key) =>
    left[key].active === right[key].active &&
    left[key].content === right[key].content &&
    left[key].transport === right[key].transport
  );
}

export function mergePendingRequest(current, next) {
  if (!next) {
    return current ? normalizeRecoveryRequest(current) : null;
  }
  const normalizedNext = normalizeRecoveryRequest(next);
  if (current?.activationRoute && !normalizedNext.activationRoute) {
    return normalizeRecoveryRequest(current);
  }
  return normalizedNext;
}

function requestToResume(state) {
  if (state.pendingRequest) {
    return normalizeRecoveryRequest(state.pendingRequest);
  }
  if (state.activeRequest?.activationRoute) {
    return normalizeRecoveryRequest({
      activationRoute: state.activeRequest.activationRoute,
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: state.activeRequest.trigger,
    });
  }
  return null;
}

export function isDefinitelyOfflineObservation(observation) {
  return (
    observation.network.onlineHint === false ||
    observation.network.connectionType === "none"
  );
}

function requiredTargetHasTransport(targets, transport) {
  return [targets.list, targets.detail].some(
    (target) => target.active && target.transport === transport,
  );
}

export function isNetworkFailure(error) {
  return error instanceof TypeError || error?.status === 0;
}
