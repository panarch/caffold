export class InFlightLimit {
  // How many cells of the large files being fetched may be requested and not
  // yet arrived. Enough cells keep the link busy; more wait in line ahead of
  // every other request on the same connection, the live updates included.
  // The count follows how long a cell waits for its first byte: within the
  // usual round trip and a quarter of a second the link has room, and longer
  // means cells are waiting in line.
  cells!: number;
  usualWaitMs!: number;
  round!: number;

  constructor() {
    this.reset();
  }

  // Back to the start, as the link may have changed since the last fetch.
  reset() {
    this.cells = START_CELLS;
    this.usualWaitMs = Infinity;
    this.round = 0;
  }

  // The count is kept with its fraction so that a slow growth still adds up;
  // only whole cells are requested.
  allowedCells() {
    return Math.max(MIN_CELLS, Math.floor(this.cells));
  }

  // A cell requested during `round` waited `waitMs` for its first byte. A cell
  // the browser's cache answered says nothing about the link. The count
  // changes once a round, because only a cell requested since the last change
  // shows what that change did.
  observe({
    round,
    waitMs,
    fromCache = false,
  }: {
    round: number;
    waitMs: number;
    fromCache?: boolean;
  }) {
    if (fromCache) {
      return;
    }
    this.usualWaitMs = Math.min(this.usualWaitMs, waitMs);
    if (round !== this.round) {
      return;
    }
    const factor = clamp(
      (this.usualWaitMs + ALLOWED_WAIT_IN_LINE_MS) / Math.max(waitMs, 1),
      0.5,
      2,
    );
    this.cells = clamp(this.cells * factor, MIN_CELLS, MAX_CELLS);
    this.round += 1;
  }
}

const START_CELLS = 1;
const MIN_CELLS = 1;
const MAX_CELLS = 128;
const ALLOWED_WAIT_IN_LINE_MS = 250;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
