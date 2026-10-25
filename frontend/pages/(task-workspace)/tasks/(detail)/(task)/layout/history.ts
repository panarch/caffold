import type { TaskDetail, TaskEvent, TaskEventPosition } from "#app/api.js";
import { eventIdentityKey, taskEventPosition } from "#tasks/task-events.js";
import { comparePositions, projectionRevision } from "./conversation.ts";

type HistoryState = "inactive" | "ready" | "loading" | "blocked";
type HistoryEvent = "activate" | "deactivate" | "request" | "resolve" | "block";

// One loaded stretch of a Task's history. `nextCursor` continues it to older
// items: a cursor, null at the beginning, or undefined when unknown.
interface HistoryPage {
  from: TaskEventPosition;
  to: TaskEventPosition;
  nextCursor: string | null | undefined;
  revision: number;
}

// A cursor an unscoped response offered, with the one position it continues
// when that response carried any.
interface OfferedContinuation {
  from: TaskEventPosition | undefined;
  to: TaskEventPosition | undefined;
  nextCursor: string;
  revision: number;
}

// What the conversation shows about older history.
export interface HistoryPresentation {
  loading: boolean;
  error: Error | null;
  nextCursor: string | null;
}

// One request owner for explicit pagination and holes between retained pages.
// A page's open membership extent is never evidence of loaded history.
const TRANSITIONS: Record<
  HistoryState,
  Partial<Record<HistoryEvent, HistoryState>>
> = {
  inactive: { activate: "ready", deactivate: "inactive" },
  ready: {
    activate: "ready",
    deactivate: "inactive",
    request: "loading",
    resolve: "ready",
    block: "blocked",
  },
  loading: {
    activate: "ready",
    deactivate: "inactive",
    resolve: "ready",
    block: "blocked",
  },
  blocked: {
    activate: "ready",
    deactivate: "inactive",
    request: "loading",
    resolve: "ready",
    block: "blocked",
  },
};

export class ConversationHistory {
  state: HistoryState = "inactive";
  error: Error | null = null;
  private readonly load: (
    threadId: string,
    cursor: string,
    options: { signal: AbortSignal },
  ) => Promise<TaskDetail>;
  private readonly apply: (
    detail: TaskDetail,
    context: { threadId: string; cursor: string },
  ) => unknown;
  private readonly change: (presentation: HistoryPresentation) => void;
  private readonly pagesByThread = new Map<string, HistoryPage[]>();
  private readonly offeredContinuations = new Map<
    string,
    OfferedContinuation
  >();
  private lifetime = 0;
  private threadId = "";
  private visited = new Set<string | null | undefined>();
  private activeRead: { cursor: string; controller: AbortController } | null =
    null;
  private pending: Promise<void> | null = null;

  constructor({
    load,
    apply,
    change,
  }: {
    load: ConversationHistory["load"];
    apply: ConversationHistory["apply"];
    change: ConversationHistory["change"];
  }) {
    this.load = load;
    this.apply = apply;
    this.change = change;
  }

  activate(threadId: string) {
    this.cancelPending();
    this.threadId = threadId;
    this.transition("activate");
    this.error = null;
    this.visited = new Set();
    this.pagesByThread.set(
      threadId,
      this.pages.map((page) => ({ ...page, revision: -1 })),
    );
    this.publish();
  }

  deactivate() {
    this.cancelPending();
    this.transition("deactivate");
    this.error = null;
    this.publish();
  }

  accept(
    detail: TaskDetail,
    cursor: string | null = null,
    retainedEvents: TaskEvent[] | null = null,
  ) {
    if (this.state === "inactive") return false;
    const previousCursor = this.cursor;
    const before = JSON.stringify(this.pages);
    if (retainedEvents) {
      const positions = sortedPositions(retainedEvents);
      this.pagesByThread.set(
        this.threadId,
        this.pages.flatMap((page) => {
          const kept = positions.filter(
            (position) =>
              comparePositions(position, page.from) >= 0 &&
              comparePositions(position, page.to) <= 0,
          );
          return kept.length
            ? [{ ...page, from: kept[0], to: kept[kept.length - 1] }]
            : [];
        }),
      );
    }
    const page = loadedPage(detail, retainedEvents);
    if (!page) {
      // An unscoped response proves each supplied position, not a loaded
      // interval. Keep one point to reconnect later authoritative pages to
      // already readable history, without eagerly walking that history.
      const first: TaskEventPosition | undefined = sortedPositions(
        detail.events ?? [],
      )[0];
      if (!detail.eventsRange && !this.pages.length && first) {
        this.pagesByThread.set(this.threadId, [
          { from: first, to: first, revision: -1, nextCursor: undefined },
        ]);
      }
      if (detail.eventsPage?.nextCursor) {
        this.offeredContinuations.set(this.threadId, {
          from: first,
          to: first,
          revision: -1,
          nextCursor: detail.eventsPage.nextCursor,
        });
      } else if (detail.eventsRange && !detail.historyLoading) {
        this.offeredContinuations.delete(this.threadId);
      }
      this.resolveCoveredRequest(previousCursor, cursor);
      this.publish();
      this.reconcileSoon();
      return false;
    }
    const continuation = this.continuation;
    if (
      cursor &&
      continuation?.nextCursor === cursor &&
      continuation.from &&
      continuation.to
    ) {
      // A manual hint belongs to the entry that supplied it, which may be
      // newer than the first retained point. Never bridge that earlier gap
      // merely because both entries were unscoped.
      if (comparePositions(continuation.from, page.from) < 0)
        page.from = continuation.from;
      if (comparePositions(continuation.to, page.to) > 0)
        page.to = continuation.to;
    }
    const joined: HistoryPage[] = [];
    for (const previous of this.pages) {
      if (
        overlaps(previous, page) ||
        (cursor && previous.nextCursor === cursor)
      ) {
        // The older edge owns continuation. A fresh latest window cannot
        // overwrite the continuation of history already loaded before it.
        const order = comparePositions(previous.from, page.from);
        if (
          previous.nextCursor !== undefined &&
          (order < 0 || (order === 0 && previous.revision > page.revision))
        ) {
          page.nextCursor = previous.nextCursor;
          page.revision = previous.revision;
        }
        if (order < 0) page.from = previous.from;
        if (comparePositions(previous.to, page.to) > 0) page.to = previous.to;
      } else {
        joined.push(previous);
      }
    }
    joined.push(page);
    joined.sort((left, right) => comparePositions(left.from, right.from));
    this.offeredContinuations.delete(this.threadId);
    this.pagesByThread.set(this.threadId, joined);
    this.resolveCoveredRequest(previousCursor, cursor);
    this.publish();
    this.reconcileSoon();
    return before !== JSON.stringify(joined);
  }

  get pages() {
    return this.pagesByThread.get(this.threadId) ?? [];
  }

  get cursor() {
    return this.continuation?.nextCursor ?? null;
  }

  get continuation() {
    // Fill the most recent hole before moving farther back into old history.
    const pages = this.pages;
    const page = pages.length > 1 ? pages[pages.length - 1] : pages[0];
    if (page?.nextCursor !== undefined) return page;
    // An unscoped entry proves only one position, but its offered cursor
    // still names the response that continues that position. Use this same
    // owner for selection, cancellation, and joining a successful response.
    return pages.every((candidate) => candidate.nextCursor === undefined)
      ? (this.offeredContinuations.get(this.threadId) ?? null)
      : null;
  }

  request({ retry = false, automatic = false } = {}): Promise<void> {
    if (this.state === "inactive") return Promise.resolve();
    if (this.state === "loading") return this.pending ?? Promise.resolve();
    if (this.state === "blocked" && !retry) return Promise.resolve();
    if (automatic && this.pages.length < 2) return Promise.resolve();
    const cursor = this.cursor;
    this.error = null;
    if (!cursor) {
      this.transition(this.pages.length > 1 ? "block" : "resolve");
      if (this.state === "blocked")
        this.error = new Error(
          "Some earlier messages could not be connected. Reopen the Task to refresh its history.",
        );
      this.publish();
      return Promise.resolve();
    }
    if (retry) this.visited.clear();
    this.visited.add(cursor);
    const lifetime = this.lifetime;
    const threadId = this.threadId;
    const controller = new AbortController();
    this.activeRead = { cursor, controller };
    this.transition("request");
    const pending = this.read(threadId, cursor, lifetime, controller.signal);
    this.pending = pending;
    this.publish();
    return pending;
  }

  private async read(
    threadId: string,
    cursor: string,
    lifetime: number,
    signal: AbortSignal,
  ) {
    try {
      const detail = await this.load(threadId, cursor, { signal });
      if (lifetime !== this.lifetime) return;
      const page = loadedPage(detail);
      if (
        !page ||
        detail.task?.threadId !== threadId ||
        this.visited.has(page.nextCursor)
      ) {
        throw new Error(
          "History did not provide a valid continuation. Retry to load earlier messages.",
        );
      }
      if (
        this.pages.some(
          (previous) =>
            comparePositions(previous.from, page.from) <= 0 &&
            comparePositions(previous.to, page.to) >= 0,
        )
      ) {
        throw new Error(
          "History made no progress. Retry to load earlier messages.",
        );
      }
      const extents = () =>
        JSON.stringify(this.pages.map(({ from, to }) => ({ from, to })));
      const before = extents();
      this.apply(detail, { threadId, cursor });
      if (before === extents() || this.cursor === cursor) {
        throw new Error(
          "History made no progress. Retry to load earlier messages.",
        );
      }
      this.transition("resolve");
    } catch (error) {
      if (lifetime !== this.lifetime) return;
      // External snapshots retire obsolete requests at acceptance. A failure
      // from this still-current request must remain actionable.
      this.transition("block");
      this.error = error as Error;
    }
    this.pending = null;
    this.activeRead = null;
    this.publish();
    this.reconcileSoon();
  }

  private resolveCoveredRequest(
    previousCursor: string | null,
    responseCursor: string | null,
  ) {
    if (
      !responseCursor &&
      this.state === "loading" &&
      this.activeRead &&
      !this.ownsCursor(this.activeRead.cursor)
    ) {
      // Initial hydration can arrive through SSE before the first history
      // HTTP response. It settles the UI now; that obsolete response must
      // never clear or fail a later request.
      this.cancelPending();
      this.transition("resolve");
    }
    if (
      this.state === "blocked" &&
      (this.cursor !== previousCursor ||
        (!this.cursor && this.pages.length < 2))
    ) {
      this.transition("resolve");
      this.error = null;
    }
  }

  private cancelPending() {
    this.lifetime += 1;
    this.activeRead?.controller.abort();
    this.activeRead = null;
    this.pending = null;
  }

  private transition(event: HistoryEvent) {
    const next = TRANSITIONS[this.state]?.[event];
    if (!next)
      throw new Error(`Invalid history transition: ${this.state} / ${event}`);
    this.state = next;
  }

  private ownsCursor(cursor: string) {
    return (
      this.pages.some((page) => page.nextCursor === cursor) ||
      this.continuation?.nextCursor === cursor
    );
  }

  private reconcileSoon() {
    const lifetime = this.lifetime;
    queueMicrotask(() => {
      if (lifetime === this.lifetime) void this.request({ automatic: true });
    });
  }

  private publish() {
    this.change({
      loading: this.state === "loading",
      error: this.error,
      nextCursor: this.cursor,
    });
  }
}

// The confirmed items' positions, oldest first.
function sortedPositions(events: TaskEvent[]) {
  return events
    .filter((event) => !event.payload?.optimistic)
    .map(taskEventPosition)
    .filter((position): position is TaskEventPosition => Boolean(position))
    .sort(comparePositions);
}

function loadedPage(
  detail: TaskDetail,
  retainedEvents: TaskEvent[] | null = null,
): HistoryPage | null {
  const range = detail?.eventsRange;
  const revision = projectionRevision(detail?.eventRevision);
  if (!range || revision === null || detail.historyLoading) return null;
  const retained =
    retainedEvents && new Set(retainedEvents.map(eventIdentityKey));
  const positions = (detail.events ?? [])
    .filter(
      (event) =>
        !event.payload?.optimistic &&
        (!retained || retained.has(eventIdentityKey(event))),
    )
    .map(taskEventPosition)
    .filter(
      (position): position is TaskEventPosition =>
        Boolean(position) &&
        (!range.from ||
          comparePositions(position as TaskEventPosition, range.from) >= 0) &&
        (!range.to ||
          comparePositions(position as TaskEventPosition, range.to) <= 0),
    );
  if (!positions.length) return null;
  positions.sort(comparePositions);
  return {
    from: positions[0],
    to: positions[positions.length - 1],
    nextCursor: detail.eventsPage?.nextCursor ?? null,
    revision,
  };
}

function overlaps(left: HistoryPage, right: HistoryPage) {
  return (
    comparePositions(left.from, right.to) <= 0 &&
    comparePositions(right.from, left.to) <= 0
  );
}
