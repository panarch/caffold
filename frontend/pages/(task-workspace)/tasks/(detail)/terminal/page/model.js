// The terminal screen's control model: one activation of the screen for one
// Task or Section, from the first connection attempt until the screen goes
// away. The backend decides whether a terminal exists and who is attached;
// this model only follows what the backend's socket reports.

export const TERMINAL_NODE = Object.freeze({
  INACTIVE: "inactive",
  CONNECTING: "connecting",
  LIVE: "live",
  ELSEWHERE: "elsewhere",
  EMPTY: "empty",
  SUSPENDED: "suspended",
  DISCONNECTED: "disconnected",
});

export const TERMINAL_EVENT = Object.freeze({
  // The screen was asked for: `take` when the person asked for it here,
  // `resume` when it came back on its own.
  ACTIVATE: "activate",
  DEACTIVATE: "deactivate",
  HIDDEN: "hidden",
  VISIBLE: "visible",
  RECOVER: "recover",
  // What the backend answered, each carrying the generation it answers.
  ATTACHED: "attached",
  ELSEWHERE: "elsewhere",
  ABSENT: "absent",
  START_FAILED: "start-failed",
  ENDED: "ended",
  TAKEN: "taken",
  SOCKET_FAILED: "socket-failed",
});

export const TERMINAL_EFFECT = Object.freeze({
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  FOCUS: "focus",
  RELEASE_FOCUS: "release-focus",
  // The terminal this screen was using ended; the screen goes back to where
  // the subject was before it.
  LEAVE: "leave",
});

export const TERMINAL_MODE = Object.freeze({
  TAKE: "take",
  RESUME: "resume",
});

const BACKEND_EVENTS = new Set([
  TERMINAL_EVENT.ATTACHED,
  TERMINAL_EVENT.ELSEWHERE,
  TERMINAL_EVENT.ABSENT,
  TERMINAL_EVENT.START_FAILED,
  TERMINAL_EVENT.ENDED,
  TERMINAL_EVENT.TAKEN,
  TERMINAL_EVENT.SOCKET_FAILED,
]);

const LEAVING = new Set([
  TERMINAL_NODE.CONNECTING,
  TERMINAL_NODE.LIVE,
  TERMINAL_NODE.ELSEWHERE,
  TERMINAL_NODE.EMPTY,
  TERMINAL_NODE.DISCONNECTED,
]);

export function initialTerminalState() {
  return Object.freeze({
    node: TERMINAL_NODE.INACTIVE,
    mode: null,
    generation: 0,
    error: "",
  });
}

/**
 * Applies one event. Returns the next state and the effects to run, or null
 * when the current node does not accept the event.
 */
export function terminalTransition(state, event) {
  if (
    BACKEND_EVENTS.has(event?.type) &&
    event.generation !== state.generation
  ) {
    return null;
  }
  const edge = acceptedEdge(state, event);
  if (!edge) {
    return null;
  }
  const connects = edge.effects.includes(TERMINAL_EFFECT.CONNECT);
  const disconnects = edge.effects.includes(TERMINAL_EFFECT.DISCONNECT);
  return Object.freeze({
    state: Object.freeze({
      node: edge.node,
      mode: edge.node === TERMINAL_NODE.CONNECTING ? edge.mode : null,
      // A connection or its end invalidates every answer to the one before.
      generation: connects || disconnects
        ? state.generation + 1
        : state.generation,
      error: edge.error ?? "",
    }),
    effects: Object.freeze([...edge.effects]),
  });
}

function acceptedEdge(state, event) {
  const { node } = state;
  const { CONNECT, DISCONNECT, FOCUS, RELEASE_FOCUS, LEAVE } = TERMINAL_EFFECT;
  switch (event?.type) {
    case TERMINAL_EVENT.ACTIVATE: {
      const mode = event.mode === TERMINAL_MODE.TAKE
        ? TERMINAL_MODE.TAKE
        : TERMINAL_MODE.RESUME;
      if (node === TERMINAL_NODE.INACTIVE) {
        return connecting(mode, [CONNECT]);
      }
      // Asking for the terminal here takes it from another screen, or opens
      // one where none runs.
      if (
        mode === TERMINAL_MODE.TAKE &&
        [TERMINAL_NODE.ELSEWHERE, TERMINAL_NODE.EMPTY].includes(node)
      ) {
        return connecting(mode, [CONNECT]);
      }
      return null;
    }
    case TERMINAL_EVENT.DEACTIVATE:
      return node === TERMINAL_NODE.INACTIVE
        ? null
        : { node: TERMINAL_NODE.INACTIVE, effects: [DISCONNECT] };
    case TERMINAL_EVENT.HIDDEN:
      return LEAVING.has(node)
        ? { node: TERMINAL_NODE.SUSPENDED, effects: [DISCONNECT] }
        : null;
    case TERMINAL_EVENT.VISIBLE:
      return node === TERMINAL_NODE.SUSPENDED
        ? connecting(TERMINAL_MODE.RESUME, [CONNECT])
        : null;
    case TERMINAL_EVENT.RECOVER:
      return node === TERMINAL_NODE.DISCONNECTED
        ? connecting(TERMINAL_MODE.RESUME, [CONNECT])
        : null;
    case TERMINAL_EVENT.ATTACHED:
      return node === TERMINAL_NODE.CONNECTING
        ? {
            node: TERMINAL_NODE.LIVE,
            effects: state.mode === TERMINAL_MODE.TAKE ? [FOCUS] : [],
          }
        : null;
    case TERMINAL_EVENT.ELSEWHERE:
      return node === TERMINAL_NODE.CONNECTING
        ? { node: TERMINAL_NODE.ELSEWHERE, effects: [DISCONNECT] }
        : null;
    case TERMINAL_EVENT.ABSENT:
      return node === TERMINAL_NODE.CONNECTING
        ? { node: TERMINAL_NODE.EMPTY, effects: [DISCONNECT] }
        : null;
    case TERMINAL_EVENT.START_FAILED:
      return node === TERMINAL_NODE.CONNECTING
        ? {
            node: TERMINAL_NODE.EMPTY,
            effects: [DISCONNECT],
            error: `${event.message ?? ""}`,
          }
        : null;
    case TERMINAL_EVENT.ENDED:
      return node === TERMINAL_NODE.LIVE
        ? { node: TERMINAL_NODE.EMPTY, effects: [DISCONNECT, RELEASE_FOCUS, LEAVE] }
        : null;
    case TERMINAL_EVENT.TAKEN:
      return node === TERMINAL_NODE.LIVE
        ? { node: TERMINAL_NODE.ELSEWHERE, effects: [DISCONNECT, RELEASE_FOCUS] }
        : null;
    case TERMINAL_EVENT.SOCKET_FAILED:
      return [TERMINAL_NODE.CONNECTING, TERMINAL_NODE.LIVE].includes(node)
        ? { node: TERMINAL_NODE.DISCONNECTED, effects: [DISCONNECT] }
        : null;
    default:
      return null;
  }
}

function connecting(mode, effects) {
  return { node: TERMINAL_NODE.CONNECTING, mode, effects };
}
