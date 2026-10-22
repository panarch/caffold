// How far a Working Tree or Branch read has come: whether it holds data,
// whether that data was read before the page or Review last came back, and
// whether a first read or a reread is running or has failed. The data itself,
// the last error, and request generations stay with the changes component.

const EMPTY = "empty";
const LOADING = "loading";
const FAILED = "failed";
const CURRENT = "current";
const OUTDATED = "outdated";
const REREADING = "rereading";
const REREAD_FAILED = "rereadFailed";

// The complete transition table; an event a node does not list is rejected.
// A completion can only arrive for a read started after the last return or
// reset, because both invalidate earlier requests.
const EDGES = Object.freeze({
  [EMPTY]: { start: LOADING, return: EMPTY, reset: EMPTY },
  [LOADING]: {
    start: LOADING,
    succeed: CURRENT,
    fail: FAILED,
    return: EMPTY,
    reset: EMPTY,
  },
  [FAILED]: { start: LOADING, return: FAILED, reset: EMPTY },
  [CURRENT]: {
    start: CURRENT,
    succeed: CURRENT,
    fail: CURRENT,
    return: OUTDATED,
    reset: EMPTY,
  },
  [OUTDATED]: { start: REREADING, return: OUTDATED, reset: EMPTY },
  [REREADING]: {
    start: REREADING,
    succeed: CURRENT,
    fail: REREAD_FAILED,
    return: OUTDATED,
    reset: EMPTY,
  },
  [REREAD_FAILED]: { start: REREADING, return: REREAD_FAILED, reset: EMPTY },
});

export class ChangesReading {
  #node = EMPTY;

  get state() {
    return STATES[this.#node];
  }

  start() {
    return this.#apply("start");
  }

  succeed() {
    return this.#apply("succeed");
  }

  fail() {
    return this.#apply("fail");
  }

  markReturned() {
    return this.#apply("return");
  }

  reset() {
    return this.#apply("reset");
  }

  #apply(event) {
    const previous = this.state;
    const next = EDGES[this.#node][event];
    if (!next) {
      return { accepted: false, previous };
    }
    this.#node = next;
    return { accepted: true, previous };
  }
}

const STATES = Object.freeze({
  [EMPTY]: state({}),
  [LOADING]: state({ reading: true }),
  [FAILED]: state({ failed: true }),
  [CURRENT]: state({ hasData: true }),
  [OUTDATED]: state({ hasData: true, fromBeforeReturn: true }),
  [REREADING]: state({ hasData: true, fromBeforeReturn: true, reading: true }),
  [REREAD_FAILED]: state({ hasData: true, fromBeforeReturn: true, failed: true }),
});

function state({
  hasData = false,
  fromBeforeReturn = false,
  reading = false,
  failed = false,
}) {
  return Object.freeze({ hasData, fromBeforeReturn, reading, failed });
}
