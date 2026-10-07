// The upload folders of sends the agent never received, until Caffold has
// answered a request to discard each one.
//
// A discard that cannot reach Caffold, often because the server stopped in the
// middle of the upload, waits and goes again the next time Caffold answers any
// request. Any answer settles a folder: a refusal would only be repeated.
// Answers to other requests arrive on their own schedule, so a folder already
// being sent is not sent a second time.

export const UPLOAD_DISCARD_NODE = Object.freeze({
  SENDING: "sending",
  WAITING: "waiting",
  SETTLED: "settled",
});

export const UPLOAD_DISCARD_EVENT = Object.freeze({
  ANSWERED: "answered",
  UNREACHABLE: "unreachable",
  REACHABLE: "reachable",
});

const { SENDING, WAITING, SETTLED } = UPLOAD_DISCARD_NODE;
const EVENT = UPLOAD_DISCARD_EVENT;

// Every allowed edge. An event missing from a node's row is refused there.
const EDGES = Object.freeze({
  [SENDING]: {
    [EVENT.ANSWERED]: SETTLED,
    [EVENT.UNREACHABLE]: WAITING,
  },
  [WAITING]: {
    [EVENT.REACHABLE]: SENDING,
  },
  [SETTLED]: {},
});

/** The node an event leads to from `node`, or null where it is refused. */
export function nextUploadDiscardNode(node, event) {
  return EDGES[node]?.[event] ?? null;
}

export class UploadDiscards {
  /** `discard(threadId, folder)` asks Caffold to remove one send's folder. */
  constructor({ discard }) {
    this.request = discard;
    this.folders = new Map();
  }

  discard(threadId, folder) {
    const key = `${threadId}\n${folder}`;
    if (this.folders.has(key)) {
      return;
    }
    const entry = { key, threadId, folder, node: SENDING };
    this.folders.set(key, entry);
    void this.send(entry);
  }

  /** Caffold has answered a request: every waiting folder goes again. */
  reachable() {
    for (const entry of [...this.folders.values()]) {
      if (this.apply(entry, EVENT.REACHABLE)) {
        void this.send(entry);
      }
    }
  }

  async send(entry) {
    let event = EVENT.ANSWERED;
    try {
      await this.request(entry.threadId, entry.folder);
    } catch (error) {
      event = Number(error?.status) > 0 ? EVENT.ANSWERED : EVENT.UNREACHABLE;
    }
    this.apply(entry, event);
  }

  apply(entry, event) {
    const next = nextUploadDiscardNode(entry.node, event);
    if (!next) {
      return false;
    }
    entry.node = next;
    if (next === SETTLED) {
      this.folders.delete(entry.key);
    }
    return true;
  }
}
