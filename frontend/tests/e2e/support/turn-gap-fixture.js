import { installBrowserDefaults } from "./browser-defaults.js";
import { installTaskApiFixture, taskDetailFixture } from "./task-api-fixture.js";
import { activeTaskProjection } from "./task-fixtures.js";

const THREAD_ID = "thread-1";
const START_MS = 1_767_400_000_000;

// Fixed wire answers, not a second implementation of the cache. The long
// third turn has 104 records: a 100-record tail plus its two prompt/start
// boundaries is a valid bounded Task Detail answer. Its continuation supplies
// the omitted head and both earlier turns. All item identities are stable.
export function turnGapFixture({ longThirdTurn = false } = {}) {
  const turns = [
    turnEvents(1),
    turnEvents(2),
    turnEvents(3, longThirdTurn ? 100 : 0),
  ];
  const task = {
    ...taskDetailFixture().task,
    title: "Turn continuity fixture",
    latestTurnStatus: "completed",
  };
  const answer = (
    events,
    revision,
    eventRevision,
    { nextCursor = null, to = null, from = events[0]?.position ?? null } = {},
  ) => ({
    ...taskDetailFixture(),
    task,
    revision,
    eventRevision,
    events,
    eventsRange: { from, to },
    eventsPage: { nextCursor },
  });
  const first = answer(turns[0], 10, 10);
  const throughSecond = answer(turns.slice(0, 2).flat(), 20, 30);
  const complete = answer(turns.flat(), 30, 210);
  const boundary = turns[2][4];
  const cursor = JSON.stringify({
    turns: null,
    before: boundary?.position,
    turnId: "turn-3",
    itemId: boundary?.id,
  });
  const latest = longThirdTurn
    ? answer([...turns[2].slice(0, 2), ...turns[2].slice(4)], 30, 200, {
        from: boundary.position,
        nextCursor: cursor,
      })
    : answer(turns[2], 30, 200, { nextCursor: "turn-2-page" });
  const historicalEvents = longThirdTurn
    ? [...turns[0], ...turns[1], ...turns[2].slice(0, 4)]
    : turns.slice(0, 2).flat();
  const history = answer(historicalEvents, 30, 201, {
    to: historicalEvents.at(-1).position,
  });
  return {
    threadId: THREAD_ID,
    turns,
    task,
    first,
    throughSecond,
    complete,
    latest,
    history,
    canonical: longThirdTurn ? latest : complete,
  };
}

export function syncPacket(detail, reason = "app-server-notification") {
  return {
    type: "task-sync",
    payload: { threadId: THREAD_ID, revision: detail.revision, detail, reason },
  };
}

export function turnPackets(events, firstRevision) {
  return events.map((event, index) => ({
    type: "task-event",
    payload: {
      threadId: THREAD_ID,
      revision: firstRevision + index,
      eventRevision: firstRevision + index,
      event,
    },
  }));
}

export async function installTurnGapFixture(page, fixture) {
  await installBrowserDefaults(page);
  await installTaskApiFixture(page);
  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: activeTaskProjection([fixture.task]) }),
  );
  const reads = [];
  const historyPages = fixture.historyPages ?? {
    [fixture.latest.eventsPage.nextCursor]: fixture.history,
  };
  let historyResponse = async (cursor) => historyPages[cursor];
  await page.route(/\/api\/tasks\/thread-1(?:\?|$)/, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    reads.push(cursor);
    if (cursor && !Object.hasOwn(historyPages, cursor)) {
      await route.fulfill({
        status: 400,
        json: { error: "Unknown fixture history cursor" },
      });
      return;
    }
    // A repair may request canonical latest state or follow the continuation.
    // Keep either source available without prescribing the eventual fix.
    const detail = cursor ? await historyResponse(cursor) : fixture.canonical;
    await route.fulfill({ json: detail });
  });
  return {
    reads,
    setHistoryResponse(responder) {
      historyResponse = responder;
    },
    async emit(packets) {
      await page.evaluate(({ threadId, packets }) => {
        const source = window.__caffoldTaskSse.source(threadId);
        if (!source) {
          throw new Error("Fixture Task Detail subscription is missing");
        }
        for (const { type, payload } of packets) {
          source.emit(type, payload);
        }
      }, { threadId: fixture.threadId, packets });
    },
    async disconnect() {
      await page.evaluate((threadId) => {
        window.__caffoldTaskSse.source(threadId).emitError();
      }, fixture.threadId);
    },
    async failDetailChannel() {
      const previous = await page.evaluate((threadId) => {
        const source = window.__caffoldTaskSse.source(threadId);
        const previous = {
          generation: source.generation,
          connectionId: source.physical.connectionId,
          physicalSources: window.__caffoldMockLiveEventSources.length,
          taskListGeneration: source.physical.virtuals.get("task-list")?.generation,
        };
        // Keep the physical SSE alive. The production gateway must emit this
        // envelope when its internal Detail stream ends (covered in Rust).
        source.emitChannelError();
        return previous;
      }, fixture.threadId);
      return previous;
    },
  };
}

function turnEvents(number, workItems = 0) {
  const turnId = `turn-${number}`;
  const anchorMs = START_MS + number * 10_000;
  const record = (type, index, payload) => ({
    id: `${THREAD_ID}:${turnId}:${index}`,
    threadId: THREAD_ID,
    type,
    summary: type,
    position: { anchorMs, index },
    payload: { turnId, ...payload },
  });
  return [
    record("turn_started", 0, { status: "inProgress" }),
    record("user_message", 1, {
      itemId: `${turnId}-prompt`,
      text: `Question for turn ${number}`,
    }),
    ...Array.from({ length: workItems }, (_, index) =>
      record("command_execution", index + 2, {
        itemId: `${turnId}-command-${index}`,
        command: `echo fixture-${index}`,
        output: `fixture-${index}`,
        status: "completed",
        exitCode: 0,
      }),
    ),
    record("assistant_message", workItems + 2, {
      itemId: `${turnId}-answer`,
      phase: "final",
      text: `Answer for turn ${number}`,
    }),
    {
      ...record("turn_completed", workItems + 3, { status: "completed" }),
      position: { anchorMs: anchorMs + 5_000, index: 0 },
    },
  ];
}
