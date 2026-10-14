export const CELL_BYTES = 64 * 1024;

// One file fetched in cells of CELL_BYTES, cut at the same places every time:
// a browser reuses a kept cell only when it is asked for exactly the same bytes
// again. The first cell comes from the address the viewer asked for, which the
// browser checks with the server every time; it names the file's version and
// size. Every later cell comes from that address with the version and the
// cell's number added. That address never changes, so the browser keeps the
// cell, and as each cell has an address of its own, cells asked for at the
// same time are all kept: over HTTP/2 Chrome keeps only one of several
// requests for one address in flight together. A file that changes while it
// is fetched is fetched again from its first cell.
const MAX_RESTARTS = 2;

export const TRANSFER_NODE = Object.freeze({
  // The first cell is asked for and its answer awaited.
  OPENING: "opening",
  // The version and size are known and the later cells are arriving.
  RECEIVING: "receiving",
  FINISHED: "finished",
  FAILED: "failed",
  CANCELED: "canceled",
});

export const TRANSFER_EVENT = Object.freeze({
  // The first cell arrived and more follow.
  FIRST_PART: "first-part",
  // A later cell arrived and more follow.
  PART: "part",
  // The cell that completes the file arrived; for a file of one cell, the first.
  LAST_PART: "last-part",
  // The server sent the whole file instead of a part.
  WHOLE: "whole",
  // The file is empty.
  EMPTY: "empty",
  // The version the later cells name is gone: the file changed.
  CHANGED: "changed",
  FAILED: "failed",
  // Every caller let go.
  CANCEL: "cancel",
});

// The complete set of allowed moves; any other event leaves the node alone.
export const TRANSFER_EDGES = Object.freeze({
  [TRANSFER_NODE.OPENING]: Object.freeze({
    [TRANSFER_EVENT.FIRST_PART]: TRANSFER_NODE.RECEIVING,
    [TRANSFER_EVENT.LAST_PART]: TRANSFER_NODE.FINISHED,
    [TRANSFER_EVENT.WHOLE]: TRANSFER_NODE.FINISHED,
    [TRANSFER_EVENT.EMPTY]: TRANSFER_NODE.FINISHED,
    [TRANSFER_EVENT.FAILED]: TRANSFER_NODE.FAILED,
    [TRANSFER_EVENT.CANCEL]: TRANSFER_NODE.CANCELED,
  }),
  [TRANSFER_NODE.RECEIVING]: Object.freeze({
    [TRANSFER_EVENT.PART]: TRANSFER_NODE.RECEIVING,
    [TRANSFER_EVENT.LAST_PART]: TRANSFER_NODE.FINISHED,
    [TRANSFER_EVENT.CHANGED]: TRANSFER_NODE.OPENING,
    [TRANSFER_EVENT.FAILED]: TRANSFER_NODE.FAILED,
    [TRANSFER_EVENT.CANCEL]: TRANSFER_NODE.CANCELED,
  }),
});

export class Transfer {
  constructor(url) {
    this.url = url;
    this.node = TRANSFER_NODE.OPENING;
    // Answers to cells asked for before a restart belong to an earlier
    // generation and are dropped.
    this.generation = 0;
    this.restarts = 0;
    this.callers = 0;
    this.controllers = new Set();
    this.forgetFile();
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  get ended() {
    return !TRANSFER_EDGES[this.node];
  }

  // The next cell to ask for, or null when none may be asked for now: while
  // opening only the first cell, while receiving each later cell once.
  takeCell(round) {
    const index = this.nextCell;
    if (
      (this.node === TRANSFER_NODE.OPENING && index > 0) ||
      (this.node === TRANSFER_NODE.RECEIVING && index >= this.cellCount()) ||
      this.ended
    ) {
      return null;
    }
    this.nextCell += 1;
    const first = index * CELL_BYTES;
    const last = index === 0
      ? CELL_BYTES - 1
      : Math.min(first + CELL_BYTES, this.size) - 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    return {
      transfer: this,
      index,
      generation: this.generation,
      round,
      url: index === 0 ? this.url : cellUrl(this.url, this.version, index),
      range: `bytes=${first}-${last}`,
      controller,
    };
  }

  // Notes how long a cell waited for its first byte and tells whether it came
  // out of the browser's cache rather than over the link. The first cell
  // always goes to the server, and nothing that does arrives sooner than a
  // round trip, so a later cell that took less than half the first one's wait
  // was kept by the browser.
  recordWait(cell, waitMs) {
    if (cell.generation !== this.generation) {
      return false;
    }
    if (cell.index === 0) {
      this.firstWaitMs = waitMs;
      return false;
    }
    return this.firstWaitMs !== null && waitMs < this.firstWaitMs / 2;
  }

  // A cell's answer, already read into one of: part, whole, out-of-range,
  // changed, failed.
  answer(cell, answer) {
    this.controllers.delete(cell.controller);
    if (this.ended || cell.generation !== this.generation) {
      return false;
    }
    return this.dispatch(this.reduce(cell, answer), cell, answer);
  }

  cancel() {
    return this.dispatch(TRANSFER_EVENT.CANCEL);
  }

  dispatch(event, cell = null, answer = null) {
    const next = TRANSFER_EDGES[this.node]?.[event];
    if (!next) {
      return false;
    }
    this.node = next;
    this.apply(event, cell, answer);
    return true;
  }

  // What an answer means for this file in its current state.
  reduce(cell, answer) {
    const opening = cell.index === 0;
    if (answer.kind === "part") {
      const expectedFirst = cell.index * CELL_BYTES;
      const fits =
        answer.first === expectedFirst &&
        (opening ? Boolean(answer.version) : answer.size === this.size);
      if (!fits) {
        return TRANSFER_EVENT.FAILED;
      }
      const cells = Math.ceil(answer.size / CELL_BYTES);
      return this.receivedCells + 1 === cells
        ? TRANSFER_EVENT.LAST_PART
        : opening
          ? TRANSFER_EVENT.FIRST_PART
          : TRANSFER_EVENT.PART;
    }
    if (opening && answer.kind === "whole") {
      return TRANSFER_EVENT.WHOLE;
    }
    if (opening && answer.kind === "out-of-range" && answer.size === 0) {
      return TRANSFER_EVENT.EMPTY;
    }
    if (!opening && answer.kind === "changed") {
      return this.restarts < MAX_RESTARTS
        ? TRANSFER_EVENT.CHANGED
        : TRANSFER_EVENT.FAILED;
    }
    return TRANSFER_EVENT.FAILED;
  }

  apply(event, cell, answer) {
    switch (event) {
      case TRANSFER_EVENT.FIRST_PART:
      case TRANSFER_EVENT.PART:
        this.keep(cell, answer);
        return;
      case TRANSFER_EVENT.LAST_PART:
        this.keep(cell, answer);
        this.resolve({
          file: new Blob(this.parts, { type: this.type }),
          version: this.version,
        });
        return;
      case TRANSFER_EVENT.WHOLE:
        this.resolve({
          file: new Blob([answer.bytes], { type: answer.type }),
          version: answer.version || null,
        });
        return;
      case TRANSFER_EVENT.EMPTY:
        this.resolve({
          file: new Blob([], { type: answer.type }),
          version: answer.version || null,
        });
        return;
      case TRANSFER_EVENT.CHANGED:
        this.abortCells();
        this.generation += 1;
        this.restarts += 1;
        this.forgetFile();
        return;
      case TRANSFER_EVENT.FAILED:
        this.abortCells();
        this.reject(failure(answer));
        return;
      case TRANSFER_EVENT.CANCEL:
        this.abortCells();
        this.reject(abortError());
        return;
    }
  }

  keep(cell, answer) {
    if (cell.index === 0) {
      this.version = answer.version;
      this.size = answer.size;
      this.type = answer.type;
    }
    this.parts[cell.index] = answer.bytes;
    this.receivedCells += 1;
  }

  forgetFile() {
    this.version = "";
    this.size = 0;
    this.type = "";
    this.parts = [];
    this.receivedCells = 0;
    this.nextCell = 0;
    this.firstWaitMs = null;
  }

  cellCount() {
    return Math.ceil(this.size / CELL_BYTES);
  }

  abortCells() {
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

export function abortError() {
  return new DOMException("The fetch was canceled.", "AbortError");
}

function cellUrl(url, version, index) {
  const address = new URL(url, globalThis.location?.href);
  address.searchParams.set("version", version);
  address.searchParams.set("cell", `${index}`);
  return address.href;
}

function failure(answer) {
  if (answer?.error) {
    return answer.error;
  }
  return new Error(
    answer?.status
      ? `File request failed with ${answer.status}.`
      : "File request failed.",
  );
}
