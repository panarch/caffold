// Control graph

export const PWA_UPDATE_HANDOFF_NODE = Object.freeze({
  // Browser listeners are detached. The in-memory handoff target is retained.
  DETACHED: "detached",

  // No explicit prepared-build activation is pending.
  IDLE: "idle",

  // The intended build is waiting, activating, or temporarily between slots.
  ACTIVATING: "activating",

  // The intended build is active, but it does not yet control this document.
  CLAIMING: "claiming",

  // The intended build controls the page, but this document still needs replacement.
  APPLYING: "applying",
});

// Control invariants:
// - only this reducer changes the node;
// - detached may retain the in-memory handoff target for a later connection;
// - idle has no pending target;
// - activating, claiming, and applying retain one intended target generation; and
// - applying stays retryable until a new document boots on the intended build.

export type PwaUpdateHandoffNode =
  (typeof PWA_UPDATE_HANDOFF_NODE)[keyof typeof PWA_UPDATE_HANDOFF_NODE];

// Complete control graph. No reducer branch may move outside this table.
export const PWA_UPDATE_HANDOFF_TRANSITIONS: Readonly<
  Record<PwaUpdateHandoffNode, readonly PwaUpdateHandoffNode[]>
> = Object.freeze({
  [PWA_UPDATE_HANDOFF_NODE.DETACHED]: Object.freeze([
    PWA_UPDATE_HANDOFF_NODE.DETACHED,
    PWA_UPDATE_HANDOFF_NODE.IDLE,
    PWA_UPDATE_HANDOFF_NODE.ACTIVATING,
    PWA_UPDATE_HANDOFF_NODE.CLAIMING,
    PWA_UPDATE_HANDOFF_NODE.APPLYING,
  ]),
  [PWA_UPDATE_HANDOFF_NODE.IDLE]: Object.freeze([
    PWA_UPDATE_HANDOFF_NODE.IDLE,
    PWA_UPDATE_HANDOFF_NODE.DETACHED,
    PWA_UPDATE_HANDOFF_NODE.ACTIVATING,
    PWA_UPDATE_HANDOFF_NODE.CLAIMING,
    PWA_UPDATE_HANDOFF_NODE.APPLYING,
  ]),
  [PWA_UPDATE_HANDOFF_NODE.ACTIVATING]: Object.freeze([
    PWA_UPDATE_HANDOFF_NODE.ACTIVATING,
    PWA_UPDATE_HANDOFF_NODE.DETACHED,
    PWA_UPDATE_HANDOFF_NODE.IDLE,
    PWA_UPDATE_HANDOFF_NODE.CLAIMING,
    PWA_UPDATE_HANDOFF_NODE.APPLYING,
  ]),
  [PWA_UPDATE_HANDOFF_NODE.CLAIMING]: Object.freeze([
    PWA_UPDATE_HANDOFF_NODE.CLAIMING,
    PWA_UPDATE_HANDOFF_NODE.DETACHED,
    PWA_UPDATE_HANDOFF_NODE.IDLE,
    PWA_UPDATE_HANDOFF_NODE.ACTIVATING,
    PWA_UPDATE_HANDOFF_NODE.APPLYING,
  ]),
  [PWA_UPDATE_HANDOFF_NODE.APPLYING]: Object.freeze([
    PWA_UPDATE_HANDOFF_NODE.APPLYING,
    PWA_UPDATE_HANDOFF_NODE.DETACHED,
    PWA_UPDATE_HANDOFF_NODE.IDLE,
    PWA_UPDATE_HANDOFF_NODE.ACTIVATING,
    PWA_UPDATE_HANDOFF_NODE.CLAIMING,
  ]),
});

// Normalized target observations. Registration slots stay outside the graph.
export const PWA_UPDATE_TARGET_PHASE = Object.freeze({
  MISSING: "missing",
  WAITING: "waiting",
  TRANSITIONING: "transitioning",
  ACTIVE: "active",
  CONTROLLED: "controlled",
  REDUNDANT: "redundant",
});

export type PwaUpdateTargetPhase =
  (typeof PWA_UPDATE_TARGET_PHASE)[keyof typeof PWA_UPDATE_TARGET_PHASE];

export const PWA_UPDATE_HANDOFF_EVENT = Object.freeze({
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ACTIVATION_REQUESTED: "activation-requested",
  PREPARED_REPLACED: "prepared-replaced",
  TARGET_PHASE_CHANGED: "target-phase-changed",
  RESUME_REQUESTED: "resume-requested",
  CONTROLLER_CONFIRMED: "controller-confirmed",
  TARGET_DISCARDED: "target-discarded",
});

export const PWA_UPDATE_HANDOFF_EFFECT = Object.freeze({
  ACTIVATE_TARGET: "activate-target",
  CLAIM_TARGET: "claim-target",
  RELOAD: "reload",
});

type Event = typeof PWA_UPDATE_HANDOFF_EVENT;

// The prepared build an event names, as the runtime observed it, and the
// phase its worker is in. Build ids are checked here.
interface ObservedTarget {
  buildId: string | null;
  phase: PwaUpdateTargetPhase;
}

interface PreparedTarget extends ObservedTarget {
  generation: number;
}

export type PwaUpdateHandoffEvent =
  | { type: Event["CONNECTED"]; phase?: PwaUpdateTargetPhase }
  | { type: Event["DISCONNECTED"] }
  | ({ type: Event["ACTIVATION_REQUESTED"] } & PreparedTarget)
  | ({ type: Event["PREPARED_REPLACED"] } & PreparedTarget)
  | ({ type: Event["TARGET_PHASE_CHANGED"] } & ObservedTarget)
  | ({ type: Event["RESUME_REQUESTED"] } & ObservedTarget)
  | {
      type: Event["CONTROLLER_CONFIRMED"];
      buildId: string | null;
      retry?: boolean;
    }
  | { type: Event["TARGET_DISCARDED"]; buildId: string | null };

type EventOf<Type extends PwaUpdateHandoffEvent["type"]> = Extract<
  PwaUpdateHandoffEvent,
  { type: Type }
>;

export interface PwaUpdateHandoffState {
  node: PwaUpdateHandoffNode;
  targetBuildId: string | null;
  targetGeneration: number;
  targetPhase: PwaUpdateTargetPhase;
}

export interface PwaUpdateHandoffEffect {
  type: (typeof PWA_UPDATE_HANDOFF_EFFECT)[keyof typeof PWA_UPDATE_HANDOFF_EFFECT];
  buildId: string | null;
}

interface HandoffResult {
  effects: readonly PwaUpdateHandoffEffect[];
  state: PwaUpdateHandoffState;
}

export function createPwaUpdateHandoffState(): PwaUpdateHandoffState {
  return freezeState({
    node: PWA_UPDATE_HANDOFF_NODE.DETACHED,
    targetBuildId: null,
    targetGeneration: 0,
    targetPhase: PWA_UPDATE_TARGET_PHASE.MISSING,
  });
}

export function transitionPwaUpdateHandoff(
  state: PwaUpdateHandoffState,
  event: PwaUpdateHandoffEvent,
): HandoffResult {
  if (!state || !event) {
    return result(state, []);
  }

  switch (event.type) {
    case PWA_UPDATE_HANDOFF_EVENT.CONNECTED:
      return connect(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.DISCONNECTED:
      return move(state, PWA_UPDATE_HANDOFF_NODE.DETACHED);
    case PWA_UPDATE_HANDOFF_EVENT.ACTIVATION_REQUESTED:
      return requestActivation(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.PREPARED_REPLACED:
      return replacePreparedTarget(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.TARGET_PHASE_CHANGED:
      return observeTargetPhase(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.RESUME_REQUESTED:
      return resumeHandoff(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED:
      return confirmController(state, event);
    case PWA_UPDATE_HANDOFF_EVENT.TARGET_DISCARDED:
      return discardTarget(state, event);
    default:
      return result(state, []);
  }
}

function connect(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["CONNECTED"]>,
) {
  if (state.node !== PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    return result(state, []);
  }
  if (!state.targetBuildId) {
    return move(state, PWA_UPDATE_HANDOFF_NODE.IDLE);
  }
  const connected = freezeState({
    ...state,
    node: PWA_UPDATE_HANDOFF_NODE.IDLE,
  });
  return applyTargetPhase(connected, event.phase ?? state.targetPhase, true);
}

function requestActivation(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["ACTIVATION_REQUESTED"]>,
) {
  if (
    state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED ||
    !validBuildId(event.buildId)
  ) {
    return result(state, []);
  }
  const next = freezeState({
    ...state,
    targetBuildId: event.buildId,
    targetGeneration: validGeneration(event.generation),
    targetPhase: normalizePhase(event.phase),
  });
  return applyTargetPhase(next, next.targetPhase, true);
}

function replacePreparedTarget(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["PREPARED_REPLACED"]>,
) {
  if (
    !state.targetBuildId ||
    !validBuildId(event.buildId) ||
    !Number.isInteger(event.generation) ||
    event.generation <= state.targetGeneration
  ) {
    return result(state, []);
  }
  const next = freezeState({
    ...state,
    targetBuildId: event.buildId,
    targetGeneration: event.generation,
    targetPhase: normalizePhase(event.phase),
  });
  if (state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    return result(next, []);
  }
  return applyTargetPhase(next, next.targetPhase, true);
}

function observeTargetPhase(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["TARGET_PHASE_CHANGED"]>,
) {
  if (!matchesTarget(state, event.buildId)) {
    return result(state, []);
  }
  const phase = normalizePhase(event.phase);
  if (state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED) {
    return result(freezeState({ ...state, targetPhase: phase }), []);
  }
  const phaseChanged = phase !== state.targetPhase;
  const next = phaseChanged
    ? freezeState({ ...state, targetPhase: phase })
    : state;
  return applyTargetPhase(next, phase, phaseChanged);
}

function resumeHandoff(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["RESUME_REQUESTED"]>,
) {
  if (
    state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED ||
    !matchesTarget(state, event.buildId)
  ) {
    return result(state, []);
  }
  const phase = normalizePhase(event.phase);
  const next =
    phase === state.targetPhase
      ? state
      : freezeState({ ...state, targetPhase: phase });
  return applyTargetPhase(
    next,
    phase,
    state.node !== PWA_UPDATE_HANDOFF_NODE.APPLYING,
  );
}

function confirmController(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["CONTROLLER_CONFIRMED"]>,
) {
  if (
    state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED ||
    !matchesTarget(state, event.buildId)
  ) {
    return result(state, []);
  }
  const next = freezeState({
    ...state,
    node: PWA_UPDATE_HANDOFF_NODE.APPLYING,
    targetPhase: PWA_UPDATE_TARGET_PHASE.CONTROLLED,
  });
  const shouldReload =
    state.node !== PWA_UPDATE_HANDOFF_NODE.APPLYING || event.retry === true;
  const effects: PwaUpdateHandoffEffect[] = shouldReload
    ? [
        {
          type: PWA_UPDATE_HANDOFF_EFFECT.RELOAD,
          buildId: state.targetBuildId,
        },
      ]
    : [];
  return checkedResult(state, next, effects);
}

function discardTarget(
  state: PwaUpdateHandoffState,
  event: EventOf<Event["TARGET_DISCARDED"]>,
) {
  if (!matchesTarget(state, event.buildId)) {
    return result(state, []);
  }
  const node =
    state.node === PWA_UPDATE_HANDOFF_NODE.DETACHED
      ? PWA_UPDATE_HANDOFF_NODE.DETACHED
      : PWA_UPDATE_HANDOFF_NODE.IDLE;
  const next = freezeState({
    ...state,
    node,
    targetBuildId: null,
    targetGeneration: 0,
    targetPhase: PWA_UPDATE_TARGET_PHASE.MISSING,
  });
  return checkedResult(state, next, []);
}

function applyTargetPhase(
  state: PwaUpdateHandoffState,
  phase: PwaUpdateTargetPhase,
  startEffect: boolean,
) {
  if (phase === PWA_UPDATE_TARGET_PHASE.CONTROLLED) {
    return confirmController(state, {
      buildId: state.targetBuildId,
      retry: startEffect,
      type: PWA_UPDATE_HANDOFF_EVENT.CONTROLLER_CONFIRMED,
    });
  }
  if (phase === PWA_UPDATE_TARGET_PHASE.REDUNDANT) {
    return discardTarget(state, {
      buildId: state.targetBuildId,
      type: PWA_UPDATE_HANDOFF_EVENT.TARGET_DISCARDED,
    });
  }

  const node =
    phase === PWA_UPDATE_TARGET_PHASE.ACTIVE
      ? PWA_UPDATE_HANDOFF_NODE.CLAIMING
      : PWA_UPDATE_HANDOFF_NODE.ACTIVATING;
  const next = freezeState({ ...state, node, targetPhase: phase });
  const effects: PwaUpdateHandoffEffect[] = [];
  if (startEffect && phase === PWA_UPDATE_TARGET_PHASE.WAITING) {
    effects.push({
      type: PWA_UPDATE_HANDOFF_EFFECT.ACTIVATE_TARGET,
      buildId: state.targetBuildId,
    });
  }
  if (startEffect && phase === PWA_UPDATE_TARGET_PHASE.ACTIVE) {
    effects.push({
      type: PWA_UPDATE_HANDOFF_EFFECT.CLAIM_TARGET,
      buildId: state.targetBuildId,
    });
  }
  return checkedResult(state, next, effects);
}

function move(state: PwaUpdateHandoffState, node: PwaUpdateHandoffNode) {
  if (state.node === node) {
    return result(state, []);
  }
  return checkedResult(state, freezeState({ ...state, node }), []);
}

function checkedResult(
  previous: PwaUpdateHandoffState,
  next: PwaUpdateHandoffState,
  effects: PwaUpdateHandoffEffect[],
) {
  if (!PWA_UPDATE_HANDOFF_TRANSITIONS[previous.node]?.includes(next.node)) {
    return result(previous, []);
  }
  return result(next, effects);
}

function result(
  state: PwaUpdateHandoffState,
  effects: PwaUpdateHandoffEffect[],
): HandoffResult {
  return Object.freeze({
    effects: Object.freeze(effects.map((effect) => Object.freeze(effect))),
    state,
  });
}

function matchesTarget(state: PwaUpdateHandoffState, buildId: unknown) {
  return validBuildId(buildId) && buildId === state.targetBuildId;
}

function normalizePhase(phase: unknown): PwaUpdateTargetPhase {
  return (Object.values(PWA_UPDATE_TARGET_PHASE) as unknown[]).includes(phase)
    ? (phase as PwaUpdateTargetPhase)
    : PWA_UPDATE_TARGET_PHASE.MISSING;
}

function validBuildId(buildId: unknown): buildId is string {
  return typeof buildId === "string" && Boolean(buildId);
}

function validGeneration(generation: number) {
  return Number.isInteger(generation) && generation >= 0 ? generation : 0;
}

function freezeState(state: PwaUpdateHandoffState) {
  return Object.freeze(state);
}
