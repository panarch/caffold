import type { TaskAbsence } from "#app/api.js";
import {
  TASK_TRANSPORT_STATE,
  type TaskTransportState,
} from "../runtime-state.js";

// The control graph of one Task stream: the logical subscription a Task List or
// Task Detail owner keeps on the workspace gateway, from choosing a context
// through recovery.
//
// Every node an owner can be left waiting in ends on its own. Subscribing ends
// through the gateway's open check, preparing through the owner's readiness
// limit, reconciling through the request time limit, waiting-for-gateway
// through the gateway's retry budget, and backing-off through its timer. An
// unavailable stream that spent its own retry budget tries again after each
// automatic retry delay while visible. Ready, suspended, inactive, and a
// stream the gateway gave up on wait for the owner or the gateway, and gone
// waits for the owner.

export const TASK_STREAM_NODE = Object.freeze({
  // No context is chosen.
  INACTIVE: "inactive",
  // The context is kept while the document is hidden or recovery waits for
  // the network, without a subscription. Recovery subscribes again on return.
  SUSPENDED: "suspended",
  // The current subscription waits for its channel to open.
  SUBSCRIBING: "subscribing",
  // The channel is open and the owner prepares its first snapshot.
  PREPARING: "preparing",
  // The channel is open and canonical state is being read again.
  RECONCILING: "reconciling",
  // The channel delivers events.
  READY: "ready",
  // The physical connection is in trouble. The gateway owns its replacement,
  // and the subscription stays with it.
  WAITING_FOR_GATEWAY: "waiting-for-gateway",
  // The subscription was released and a bounded delay runs before the next.
  BACKING_OFF: "backing-off",
  // The retry budget or the gateway's own budget is spent.
  UNAVAILABLE: "unavailable",
  // The context's subject is archived or no longer exists. Nothing is retried
  // until the owner chooses a context again.
  GONE: "gone",
});

export const TASK_STREAM_EVENT = Object.freeze({
  // The owner chooses a context, or asks again for the one it has.
  ACTIVATE: "activate",
  // The owner replaces the subscription of its current context.
  RETRY: "retry",
  // Foreground recovery replaces the subscription while validating and reads
  // canonical state alongside it.
  RECOVER: "recover",
  SUSPEND: "suspend",
  DEACTIVATE: "deactivate",
  // The gateway's reports about the current subscription.
  CHANNEL_OPENED: "channel-opened",
  CHANNEL_FAILED: "channel-failed",
  GATEWAY_TROUBLE: "gateway-trouble",
  GATEWAY_EXHAUSTED: "gateway-exhausted",
  // The owner's preparation of an opened channel settled.
  PREPARED: "prepared",
  PREPARE_FAILED: "prepare-failed",
  // The current reconciliation request settled.
  RECONCILED: "reconciled",
  RECONCILE_FAILED: "reconcile-failed",
  // A backoff or automatic retry delay ended.
  RETRY_DUE: "retry-due",
  // The subject is archived or no longer exists, as the gateway's refusal of
  // the channel or the owner's other requests about it say.
  SUBJECT_GONE: "subject-gone",
});

export type TaskStreamNode =
  (typeof TASK_STREAM_NODE)[keyof typeof TASK_STREAM_NODE];

type EventType = (typeof TASK_STREAM_EVENT)[keyof typeof TASK_STREAM_EVENT];

type BareEventType = Exclude<
  EventType,
  | typeof TASK_STREAM_EVENT.ACTIVATE
  | typeof TASK_STREAM_EVENT.RECOVER
  | typeof TASK_STREAM_EVENT.RETRY
  | typeof TASK_STREAM_EVENT.SUBJECT_GONE
>;

// One event as an owner, the gateway, or a timer raises it, with what each
// kind carries.
export type TaskStreamEvent =
  | {
      type: typeof TASK_STREAM_EVENT.ACTIVATE;
      contextKey: string;
      sameContext: boolean;
      forced: boolean;
      validating: boolean;
    }
  | {
      type: typeof TASK_STREAM_EVENT.RECOVER;
      contextKey: string;
      sameContext: boolean;
      forced?: boolean;
      validating?: boolean;
    }
  | { type: typeof TASK_STREAM_EVENT.RETRY; reconcile: boolean }
  | { type: typeof TASK_STREAM_EVENT.SUBJECT_GONE; absence: TaskAbsence }
  | { [Type in BareEventType]: { type: Type } }[BareEventType];

// What a transition knows about the stream beside its node.
export interface TaskStreamFacts {
  visible: boolean;
  prepares: boolean;
  reconcilePending: boolean;
  retryBudgetLeft: boolean;
}

const NODE = TASK_STREAM_NODE;
const EVENT = TASK_STREAM_EVENT;

// The complete edge table: each node's accepted events and the nodes each may
// lead to. Any other pair is rejected and leaves the node unchanged.
export const TASK_STREAM_EDGES: Readonly<
  Record<
    TaskStreamNode,
    Readonly<Partial<Record<EventType, readonly TaskStreamNode[]>>>
  >
> = Object.freeze({
  [NODE.INACTIVE]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
  }),
  [NODE.SUSPENDED]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.SUBSCRIBING]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.CHANNEL_OPENED]: [NODE.PREPARING, NODE.RECONCILING, NODE.READY],
    [EVENT.RECONCILED]: [NODE.SUBSCRIBING],
    [EVENT.RECONCILE_FAILED]: [NODE.SUBSCRIBING],
    [EVENT.CHANNEL_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.GATEWAY_TROUBLE]: [NODE.WAITING_FOR_GATEWAY],
    [EVENT.GATEWAY_EXHAUSTED]: [NODE.UNAVAILABLE],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.PREPARING]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.PREPARED]: [NODE.RECONCILING, NODE.READY],
    [EVENT.RECONCILED]: [NODE.PREPARING],
    [EVENT.RECONCILE_FAILED]: [NODE.PREPARING],
    [EVENT.PREPARE_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.CHANNEL_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.GATEWAY_TROUBLE]: [NODE.WAITING_FOR_GATEWAY],
    [EVENT.GATEWAY_EXHAUSTED]: [NODE.UNAVAILABLE],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.RECONCILING]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.RECONCILED]: [NODE.READY],
    [EVENT.RECONCILE_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.CHANNEL_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.GATEWAY_TROUBLE]: [NODE.WAITING_FOR_GATEWAY],
    [EVENT.GATEWAY_EXHAUSTED]: [NODE.UNAVAILABLE],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.READY]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.CHANNEL_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.GATEWAY_TROUBLE]: [NODE.WAITING_FOR_GATEWAY],
    [EVENT.GATEWAY_EXHAUSTED]: [NODE.UNAVAILABLE],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.WAITING_FOR_GATEWAY]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.CHANNEL_OPENED]: [NODE.PREPARING, NODE.RECONCILING],
    [EVENT.CHANNEL_FAILED]: [NODE.BACKING_OFF, NODE.UNAVAILABLE],
    [EVENT.GATEWAY_EXHAUSTED]: [NODE.UNAVAILABLE],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.BACKING_OFF]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.RETRY_DUE]: [NODE.SUBSCRIBING],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  [NODE.UNAVAILABLE]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RECOVER]: [NODE.SUBSCRIBING],
    [EVENT.RETRY_DUE]: [NODE.SUBSCRIBING],
    [EVENT.CHANNEL_OPENED]: [NODE.PREPARING, NODE.RECONCILING],
    [EVENT.SUSPEND]: [NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
  // Foreground recovery and hiding leave a gone subject alone.
  [NODE.GONE]: Object.freeze({
    [EVENT.ACTIVATE]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.RETRY]: [NODE.SUBSCRIBING, NODE.SUSPENDED],
    [EVENT.SUBJECT_GONE]: [NODE.GONE],
    [EVENT.DEACTIVATE]: [NODE.INACTIVE],
  }),
});

// Returns the next node, or null when the table rejects the event. The facts
// choose among the nodes an edge allows; they never add one.
//
// facts.visible: the document is visible.
// facts.prepares: the owner prepares an opened channel.
// facts.reconcilePending: canonical state still has to be read once the
// channel is open.
// facts.retryBudgetLeft: another backoff delay remains.
export function transitionTaskStream(
  node: TaskStreamNode,
  event: TaskStreamEvent,
  facts: TaskStreamFacts,
): TaskStreamNode | null {
  const allowed = TASK_STREAM_EDGES[node]?.[event?.type];
  if (!allowed) {
    return null;
  }
  const next = chooseNext(node, event, facts);
  return next !== null && allowed.includes(next) ? next : null;
}

// The transport state a Task stream presents to its owner and the shell.
export function presentTaskStream(
  node: TaskStreamNode,
  {
    validating,
    needsReconcile,
  }: { validating: boolean; needsReconcile: boolean },
): TaskTransportState {
  switch (node) {
    case NODE.INACTIVE:
    case NODE.SUSPENDED:
    case NODE.GONE:
      return TASK_TRANSPORT_STATE.IDLE;
    case NODE.READY:
      return TASK_TRANSPORT_STATE.READY;
    case NODE.UNAVAILABLE:
      return TASK_TRANSPORT_STATE.UNAVAILABLE;
    case NODE.WAITING_FOR_GATEWAY:
    case NODE.BACKING_OFF:
      return TASK_TRANSPORT_STATE.RECONNECTING;
    default:
      if (validating) {
        return TASK_TRANSPORT_STATE.VALIDATING;
      }
      return needsReconcile
        ? TASK_TRANSPORT_STATE.RECONNECTING
        : TASK_TRANSPORT_STATE.CONNECTING;
  }
}

function chooseNext(
  node: TaskStreamNode,
  event: TaskStreamEvent,
  facts: TaskStreamFacts,
): TaskStreamNode | null {
  switch (event.type) {
    case EVENT.ACTIVATE:
      // Asking again for the same context replaces nothing unless forced; only
      // an unavailable stream takes that as a new attempt.
      if (event.sameContext && !event.forced) {
        return node === NODE.UNAVAILABLE && facts.visible
          ? NODE.SUBSCRIBING
          : null;
      }
      return facts.visible ? NODE.SUBSCRIBING : NODE.SUSPENDED;
    case EVENT.RETRY:
      return facts.visible ? NODE.SUBSCRIBING : NODE.SUSPENDED;
    case EVENT.RECOVER:
    case EVENT.RETRY_DUE:
      return NODE.SUBSCRIBING;
    case EVENT.SUSPEND:
      return NODE.SUSPENDED;
    case EVENT.DEACTIVATE:
      return NODE.INACTIVE;
    case EVENT.CHANNEL_OPENED:
      return facts.prepares ? NODE.PREPARING : afterPreparation(facts);
    case EVENT.PREPARED:
      return afterPreparation(facts);
    // A reconciliation that settles before the channel is ready is the one
    // recovery started alongside the subscription; it only updates data.
    case EVENT.RECONCILED:
      return node === NODE.RECONCILING ? NODE.READY : node;
    case EVENT.RECONCILE_FAILED:
      return node === NODE.RECONCILING ? afterFailure(facts) : node;
    case EVENT.CHANNEL_FAILED:
    case EVENT.PREPARE_FAILED:
      return afterFailure(facts);
    case EVENT.GATEWAY_TROUBLE:
      return NODE.WAITING_FOR_GATEWAY;
    case EVENT.GATEWAY_EXHAUSTED:
      return NODE.UNAVAILABLE;
    case EVENT.SUBJECT_GONE:
      return NODE.GONE;
    default:
      return null;
  }
}

function afterPreparation(facts: TaskStreamFacts) {
  return facts.reconcilePending ? NODE.RECONCILING : NODE.READY;
}

function afterFailure(facts: TaskStreamFacts) {
  return facts.retryBudgetLeft ? NODE.BACKING_OFF : NODE.UNAVAILABLE;
}
