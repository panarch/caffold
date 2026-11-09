// The control graph of the Task list's reads of `GET /api/tasks`.
//
// An answer is the list as the server read it when the request began, and the
// server publishes every list change only after storing it. So a change that
// arrives while a read is in flight may be missing from that read's answer:
// the read is superseded, its answer is never shown, and the list reads again.
// At most one read is in flight, and only an answer that arrives while reading
// is shown. Every caller waiting on the list shares one answer, given when the
// graph comes to rest.

export const LIST_READ_NODE = Object.freeze({
  // No read is in flight.
  IDLE: "idle",
  // One read is in flight, and its answer can be shown.
  READING: "reading",
  // One read is in flight, and the list changed after it began.
  SUPERSEDED: "superseded",
});

export type ListReadNode = (typeof LIST_READ_NODE)[keyof typeof LIST_READ_NODE];

export const LIST_READ_EVENT = Object.freeze({
  // A caller needs the list; a read in flight serves it.
  READ: "read",
  // The list may have changed after any read in flight began, and the change
  // is not in hand.
  REFRESH: "refresh",
  // A live event changed the list in place.
  CHANGED: "changed",
  // The current read answered.
  ANSWERED: "answered",
  // The current read failed.
  FAILED: "failed",
  // The list left the document.
  DETACHED: "detached",
});

export type ListReadEvent =
  (typeof LIST_READ_EVENT)[keyof typeof LIST_READ_EVENT];

export const LIST_READ_EFFECT = Object.freeze({
  NONE: "none",
  // Start a read; callers from now on wait for the graph to come to rest.
  START: "start",
  // Show the answer and give it to every caller waiting.
  SHOW: "show",
  // Record the failure and give every caller waiting nothing.
  FAIL: "fail",
  // Drop what the read brought and start another; callers keep waiting.
  RESTART: "restart",
  // Forget the read in flight and give every caller waiting nothing.
  ABANDON: "abandon",
});

export type ListReadEffect =
  (typeof LIST_READ_EFFECT)[keyof typeof LIST_READ_EFFECT];

export interface ListReadTransition {
  node: ListReadNode;
  effect: ListReadEffect;
}

const NODE = LIST_READ_NODE;
const EVENT = LIST_READ_EVENT;
const EFFECT = LIST_READ_EFFECT;

const edge = (node: ListReadNode, effect: ListReadEffect = EFFECT.NONE) =>
  Object.freeze({ node, effect });

// The complete edge table. Any other pair is rejected and leaves the node
// unchanged.
export const LIST_READ_EDGES: Readonly<
  Record<
    ListReadNode,
    Readonly<Partial<Record<ListReadEvent, ListReadTransition>>>
  >
> = Object.freeze({
  [NODE.IDLE]: Object.freeze({
    [EVENT.READ]: edge(NODE.READING, EFFECT.START),
    [EVENT.REFRESH]: edge(NODE.READING, EFFECT.START),
    [EVENT.CHANGED]: edge(NODE.IDLE),
    [EVENT.DETACHED]: edge(NODE.IDLE),
  }),
  [NODE.READING]: Object.freeze({
    [EVENT.READ]: edge(NODE.READING),
    [EVENT.REFRESH]: edge(NODE.SUPERSEDED),
    [EVENT.CHANGED]: edge(NODE.SUPERSEDED),
    [EVENT.ANSWERED]: edge(NODE.IDLE, EFFECT.SHOW),
    [EVENT.FAILED]: edge(NODE.IDLE, EFFECT.FAIL),
    [EVENT.DETACHED]: edge(NODE.IDLE, EFFECT.ABANDON),
  }),
  [NODE.SUPERSEDED]: Object.freeze({
    [EVENT.READ]: edge(NODE.SUPERSEDED),
    [EVENT.REFRESH]: edge(NODE.SUPERSEDED),
    [EVENT.CHANGED]: edge(NODE.SUPERSEDED),
    [EVENT.ANSWERED]: edge(NODE.READING, EFFECT.RESTART),
    [EVENT.FAILED]: edge(NODE.READING, EFFECT.RESTART),
    [EVENT.DETACHED]: edge(NODE.IDLE, EFFECT.ABANDON),
  }),
});

// The next node and the effect the owner runs, or null when the table rejects
// the event.
export function transitionListRead(
  node: ListReadNode,
  event: ListReadEvent,
): ListReadTransition | null {
  return LIST_READ_EDGES[node]?.[event] ?? null;
}
