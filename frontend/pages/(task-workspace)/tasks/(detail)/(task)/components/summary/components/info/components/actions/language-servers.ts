import {
  checkLanguageServerRepository,
  getLanguageServerRepository,
  type LanguageServerRepository,
  updateLanguageServerRepository,
} from "#app/api.js";
import { announceLanguageServersChange } from "#app/pages/(task-workspace)/language-servers.js";

// What the Language servers section shows: the repository's switch and
// servers as the server last answered, whether that answer is the latest
// one, which way the switch is being turned while that request runs, and why
// the last request failed.
export interface LanguageServersSnapshot {
  repository: LanguageServerRepository | null;
  fresh: boolean;
  turning: "on" | "off" | null;
  error: Error | null;
}

// While a server gets ready, the repository is read again this often.
const READ_AGAIN_MS = 1000;

// closed: the popover is closed, and nothing is read.
// preloading: the popover is closed, and the repository is read once so the
//   section and its button are there as soon as it opens.
// reading: the repository is being read, and as the popover opens its failed
//   servers are looked for again first; a switch pressed meanwhile replaces
//   the read.
// idle: the last answer stands, and no server is getting ready.
// waiting: a server is getting ready, so the repository is read again soon.
// turning: the repository's switch is being changed.
const PHASES = Object.freeze({
  CLOSED: "closed",
  PRELOADING: "preloading",
  READING: "reading",
  IDLE: "idle",
  WAITING: "waiting",
  TURNING: "turning",
} as const);
type Phase = (typeof PHASES)[keyof typeof PHASES];
const PHASE_EDGES = new Map<Phase, Set<Phase>>([
  [PHASES.CLOSED, new Set([PHASES.PRELOADING, PHASES.READING])],
  [PHASES.PRELOADING, new Set([PHASES.CLOSED, PHASES.READING])],
  [
    PHASES.READING,
    new Set([PHASES.IDLE, PHASES.WAITING, PHASES.TURNING, PHASES.CLOSED]),
  ],
  [PHASES.IDLE, new Set([PHASES.READING, PHASES.TURNING, PHASES.CLOSED])],
  [PHASES.WAITING, new Set([PHASES.READING, PHASES.CLOSED])],
  [
    PHASES.TURNING,
    new Set([PHASES.IDLE, PHASES.WAITING, PHASES.READING, PHASES.CLOSED]),
  ],
]);

/**
 * Reads a repository's language servers for Task details and turns
 * them on or off. The server owns the switch and the servers' states; the
 * section shows only what it answered.
 *
 * The repository is read once before the popover first opens, and the last
 * answer stays while it is closed and is read again as it opens, so the
 * section is there from the start, where a keyboard session opening the
 * popover can reach it. The read as it opens first has the server look again
 * for any failed server, which the person may have installed meanwhile, and
 * answers once that is known; the reads while a server gets ready only read.
 * Pressing the switch sends the way it is labeled, so an answer read again
 * meanwhile changes nothing it does.
 */
export class LanguageServersLifecycle {
  private readonly requests: {
    load: (path: string) => Promise<unknown>;
    check: (path: string) => Promise<unknown>;
    update: (path: string, enabled: boolean) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: LanguageServersSnapshot) => void;
  private readonly announceChange: () => void;
  private readonly schedule: (callback: () => void, delay: number) => number;
  private readonly cancel: (timer: number) => void;
  phase: Phase = PHASES.CLOSED;
  private operation = 0;
  private timer: number | null = null;
  private path = "";
  private repository: LanguageServerRepository | null = null;
  private fresh = false;
  private turning: LanguageServersSnapshot["turning"] = null;
  private error: Error | null = null;
  snapshot: LanguageServersSnapshot;

  constructor({
    load = getLanguageServerRepository,
    check = checkLanguageServerRepository,
    update = updateLanguageServerRepository,
    onChange = () => {},
    announceChange = announceLanguageServersChange,
    schedule = window.setTimeout.bind(window),
    cancel = window.clearTimeout.bind(window),
  }: {
    load?: (path: string) => Promise<unknown>;
    check?: (path: string) => Promise<unknown>;
    update?: (path: string, enabled: boolean) => Promise<unknown>;
    onChange?: (snapshot: LanguageServersSnapshot) => void;
    announceChange?: () => void;
    schedule?: (callback: () => void, delay: number) => number;
    cancel?: (timer: number) => void;
  } = {}) {
    this.requests = { load, check, update };
    this.onChange = onChange;
    this.announceChange = announceChange;
    this.schedule = schedule;
    this.cancel = cancel;
    this.snapshot = this.currentSnapshot();
  }

  /**
   * Reads the repository holding `path` once while the popover is closed,
   * unless its answer is already there.
   */
  preload(path: string) {
    const same = path === this.path;
    if (
      this.phase === PHASES.PRELOADING
        ? same
        : this.phase !== PHASES.CLOSED || (same && this.fresh)
    ) {
      return;
    }
    if (path !== this.path) {
      this.repository = null;
      this.fresh = false;
    }
    this.path = path;
    this.error = null;
    void this.readClosed();
  }

  /**
   * Reads the repository holding `path`, looking again for its failed
   * servers, unless it is already shown.
   */
  show(path: string) {
    if (
      this.phase !== PHASES.CLOSED &&
      this.phase !== PHASES.PRELOADING &&
      path === this.path
    ) {
      return;
    }
    if (path !== this.path) {
      this.repository = null;
      this.fresh = false;
    }
    this.path = path;
    this.error = null;
    void this.read({ lookAgain: true });
  }

  // The popover closed; a read made while it was closed goes on.
  hide() {
    if (this.phase === PHASES.CLOSED || this.phase === PHASES.PRELOADING) {
      return;
    }
    this.stop();
  }

  // Drops every read, as when the Task has no repository or the section
  // leaves the page.
  stop() {
    if (this.phase === PHASES.CLOSED) return;
    this.operation += 1;
    this.clearTimer();
    this.turning = null;
    this.error = null;
    this.transition(PHASES.CLOSED);
    this.publish();
  }

  async turn(enabled: boolean) {
    const repository = this.repository;
    if (
      (this.phase !== PHASES.IDLE && this.phase !== PHASES.READING) ||
      !this.fresh ||
      !repository ||
      this.gettingReady()
    ) {
      return;
    }
    const operation = ++this.operation;
    this.turning = enabled ? "on" : "off";
    this.error = null;
    this.transition(PHASES.TURNING);
    this.publish();
    try {
      const answer = normalizeRepository(
        await this.requests.update(repository.path, enabled),
      );
      // The server changed even when the popover has closed since.
      this.announceChange();
      if (operation !== this.operation) return;
      this.repository = answer;
      this.fresh = true;
    } catch (error) {
      if (operation !== this.operation) return;
      this.error = asError(error);
    }
    this.turning = null;
    this.settle();
  }

  private async read({ lookAgain = false } = {}) {
    const operation = ++this.operation;
    this.clearTimer();
    this.transition(PHASES.READING);
    this.publish();
    const request = lookAgain ? this.requests.check : this.requests.load;
    try {
      const answer = normalizeRepository(await request(this.path));
      if (operation !== this.operation) return;
      this.repository = answer;
      this.fresh = true;
      this.error = null;
    } catch (error) {
      if (operation !== this.operation) return;
      this.fresh = false;
      this.error = asError(error);
    }
    this.settle();
  }

  // A read while the popover is closed only gets the answer ready; a failure
  // shows nothing, since opening reads again.
  private async readClosed() {
    const operation = ++this.operation;
    this.transition(PHASES.PRELOADING);
    this.publish();
    let answer: LanguageServerRepository | null = null;
    try {
      answer = normalizeRepository(await this.requests.load(this.path));
    } catch {
      answer = null;
    }
    if (operation !== this.operation) return;
    if (answer) {
      this.repository = answer;
      this.fresh = true;
    }
    this.transition(PHASES.CLOSED);
    this.publish();
  }

  // A server still getting ready, even in an answer that could not be read
  // again, keeps the repository being read.
  private settle() {
    if (!this.gettingReady()) {
      this.transition(PHASES.IDLE);
      this.publish();
      return;
    }
    this.transition(PHASES.WAITING);
    this.publish();
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.read();
    }, READ_AGAIN_MS);
  }

  private gettingReady() {
    const repository = this.repository;
    return Boolean(
      repository?.enabled &&
        repository.servers.some((server) => server.state === "starting"),
    );
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid language servers lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): LanguageServersSnapshot {
    return {
      repository: this.repository,
      fresh: this.fresh,
      turning: this.turning,
      error: this.error,
    };
  }

  private publish() {
    this.snapshot = this.currentSnapshot();
    this.onChange(this.snapshot);
  }
}

function normalizeRepository(payload: unknown): LanguageServerRepository {
  const value = payload as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.path !== "string" ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.servers)
  ) {
    throw new Error("Caffold returned an invalid language server answer.");
  }
  return value as unknown as LanguageServerRepository;
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(`${error}`);
}
