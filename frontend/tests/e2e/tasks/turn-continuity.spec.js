import { expect, test } from "@playwright/test";

import {
  installTurnGapFixture,
  syncPacket,
  turnGapFixture,
  turnPackets,
} from "../support/turn-gap-fixture.js";
import { emitTaskDetailBootstrap } from "../support/task-fixtures.js";

// Regressions exercise real Detail delivery and rendering through fixed wire pages.
test("a reconnect containing all three short turns restores continuity", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture();
  const client = await installTurnGapFixture(page, fixture);
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  await client.disconnect();
  await emitTaskDetailBootstrap(page, fixture.complete);
  await expectAllTurns(page);
  expect(client.reads, "a complete bootstrap needs no extra Detail/history GET").toEqual([]);
});

test("a Detail channel error resubscribes and restores turns on the same physical connection", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture();
  const client = await installTurnGapFixture(page, fixture);
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  const previous = await client.failDetailChannel();
  await expect.poll(() => page.evaluate((threadId) =>
    window.__caffoldTaskSse.source(threadId)?.generation ?? 0,
  fixture.threadId)).toBeGreaterThan(previous.generation);
  await emitTaskDetailBootstrap(page, fixture.complete);
  await expectAllTurns(page);
  const current = await page.evaluate((threadId) => {
    const source = window.__caffoldTaskSse.source(threadId);
    return {
      connectionId: source.physical.connectionId,
      physicalSources: window.__caffoldMockLiveEventSources.length,
      taskListGeneration: source.physical.virtuals.get("task-list")?.generation,
      physicalReadyState: source.physical.readyState,
    };
  }, fixture.threadId);
  expect(current).toEqual({
    connectionId: previous.connectionId,
    physicalSources: previous.physicalSources,
    taskListGeneration: previous.taskListGeneration,
    physicalReadyState: 1,
  });
  // This is the browser HTTP budget; Rust independently checks the actual
  // Codex RPC budget, since a Detail GET need not call thread/turns/list.
  expect(client.reads, "the replacement bootstrap already contains the missing turn").toEqual([]);
});

for (const initial of ["authoritative", "unscoped"]) {
  test(`a bounded reconnect fills the gap after an ${initial} first response without scrolling`, { tag: "@desktop" }, async ({ page }) => {
    const fixture = turnGapFixture({ longThirdTurn: true });
    const client = await installTurnGapFixture(page, fixture);
    await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
    await emitTaskDetailBootstrap(page, initial === "unscoped"
      ? { ...fixture.first, eventsRange: null, historyLoading: true }
      : fixture.first);
    await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
    // This client received nothing while other devices completed turns 2 and 3.
    // Reconnect really enters the stream bootstrap path; do not call the merge
    // function or manually fetch the missing page on the client's behalf.
    await client.disconnect();
    await emitTaskDetailBootstrap(page, fixture.latest);
    await expect(page.getByText("Answer for turn 3", { exact: true })).toBeVisible();
    await expectAllTurns(page);
    expect(client.reads, "follow the missing continuation once, then stop at retained history")
      .toEqual([fixture.latest.eventsPage.nextCursor]);
  });

}

test("two clients converge when a bounded snapshot overtakes queued turn events", { tag: "@desktop" }, async ({ page, browser, baseURL }) => {
  const fixture = turnGapFixture({ longThirdTurn: true });
  const otherContext = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const otherPage = await otherContext.newPage();
    const firstClient = await installTurnGapFixture(page, fixture);
    const secondClient = await installTurnGapFixture(otherPage, fixture);
    await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
    await emitTaskDetailBootstrap(page, fixture.first);
    await otherPage.goto(`/tasks/${fixture.threadId}?cwd=src`);
    await emitTaskDetailBootstrap(otherPage, fixture.first);
    const turn2 = turnPackets(fixture.turns[1], 20);
    const latest = syncPacket(fixture.latest);
    // The server merges separate snapshot and event receivers. These are the
    // same messages in the two possible orders, not reordered SSE bytes.
    await secondClient.emit([...turn2, latest]);
    await expectAllTurns(otherPage);
    await firstClient.emit([latest, ...turn2]);
    await expectAllTurns(page);
  } finally {
    await otherContext.close();
  }
});

test("a new live turn cannot discard the missing turn in a delayed recovery snapshot", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture();
  const client = await installTurnGapFixture(page, fixture);
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  // A readable cached bootstrap still has only turn 1. The canonical recovery
  // answer was captured before turn 3, but arrives after its newer events.
  await client.disconnect();
  await emitTaskDetailBootstrap(page, fixture.first);
  await client.emit([
    ...turnPackets(fixture.turns[2], 31),
    syncPacket(fixture.throughSecond, "session-bootstrap"),
  ]);
  await expect(page.getByText("Answer for turn 3", { exact: true })).toBeVisible();
  await expectAllTurns(page);
});

test("an in-flight history page survives a newer task revision", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture({ longThirdTurn: true });
  const client = await installTurnGapFixture(page, fixture);
  let releaseHistory;
  const historyGate = new Promise((resolve) => {
    releaseHistory = resolve;
  });
  let historyStarted;
  const historyRequest = new Promise((resolve) => {
    historyStarted = resolve;
  });
  client.setHistoryResponse(async () => {
    historyStarted();
    await historyGate;
    return fixture.history;
  });
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  await client.emit([syncPacket(fixture.latest)]);
  try {
    // Drive the actual history request; hold its HTTP response until a later
    // status snapshot has advanced the Task revision. The page is still valid.
    await page.locator(".task-conversation-scroll").evaluate((scroller) => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await historyRequest;
    await client.emit([
      syncPacket({ ...fixture.latest, revision: 31, eventRevision: 202 }),
    ]);
    releaseHistory();
    await expectAllTurns(page);
  } finally {
    releaseHistory();
  }
});

for (const earlierEntry of [false, true]) {
  test(earlierEntry
    ? "a later unscoped entry hint still fills the gap to earlier retained messages"
    : "an unscoped entry loads its first page and immediately scrolls to the next without reloading",
  { tag: "@all-viewports" }, async ({ page }, testInfo) => {
    const fixture = turnGapFixture();
    fixture.historyPages = {
      [fixture.latest.eventsPage.nextCursor]: {
        ...fixture.history,
        events: fixture.turns[1],
        eventsRange: { from: fixture.turns[1][0].position, to: fixture.turns[1].at(-1).position },
        eventsPage: { nextCursor: "turn-1-page" },
      },
      "turn-1-page": {
        ...fixture.first,
        eventRevision: 202,
        eventsRange: { from: fixture.turns[0][0].position, to: fixture.turns[0].at(-1).position },
      },
    };
    const client = await installTurnGapFixture(page, fixture);
    await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
    // A retained entry can offer a native-page continuation while its mixed
    // live/history records do not yet authorize a membership extent.
    if (earlierEntry) {
      await emitTaskDetailBootstrap(page, { ...fixture.first, eventsRange: null });
      await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
      await client.emit([syncPacket({ ...fixture.latest, eventsRange: null })]);
    } else {
      await emitTaskDetailBootstrap(page, { ...fixture.latest, eventsRange: null });
    }
    await expect(page.getByText("Answer for turn 3", { exact: true })).toBeVisible();
    expect(client.reads).toEqual([]);
    const secondResponse = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.get("cursor") === "turn-1-page");
    await page.getByRole("button", { name: "Load older messages", exact: true }).click();
    await expect(page.getByText("Answer for turn 2", { exact: true })).toBeVisible();
    await expect(page.locator(".task-history-error")).toHaveCount(0);
    await page.locator(".task-conversation-scroll").evaluate((scroller) => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await secondResponse;
    await expectAllTurns(page);
    await expect(page.locator(".task-history-error")).toHaveCount(0);
    expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor, "turn-1-page"]);
    await page.screenshot({ path: testInfo.outputPath("entry-history-continuation.png") });
  });
}

test("reloading recovers a client that missed the middle turn", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture();
  const client = await installTurnGapFixture(page, fixture);
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  await client.emit([
    ...turnPackets(fixture.turns[2], 31),
    syncPacket(fixture.throughSecond, "session-bootstrap"),
  ]);
  // The recovery control is useful independently of whether the preceding
  // gap was already repaired by the normal delivery path.
  await page.reload();
  await emitTaskDetailBootstrap(page, fixture.complete);
  await expectAllTurns(page);
});

test("automatic gap repair preserves selection, scroll anchor, and the composer draft", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const fixture = turnGapFixture({ longThirdTurn: true });
  const client = await installTurnGapFixture(page, fixture);
  const historyGate = Promise.withResolvers();
  const started = Promise.withResolvers();
  client.setHistoryResponse(async () => {
    started.resolve();
    await historyGate.promise;
    return fixture.history;
  });
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  const composer = page.locator('.task-follow-up-form textarea[name="prompt"]');
  await composer.fill("Draft survives automatic repair");
  await client.emit([syncPacket(fixture.latest)]);
  await started.promise;
  try {
    await page.locator("caffold-task-work-details > details > summary").click();
    const anchor = page.getByText("Question for turn 3", { exact: true });
    await composer.focus();
    // Put a retained row at a real, non-clamped scroll offset before prepending.
    await anchor.evaluate((element) => {
      const scroller = element.closest(".task-conversation-scroll");
      scroller.scrollTop += element.closest(".task-event").getBoundingClientRect().top -
        scroller.getBoundingClientRect().top - 20;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await anchor.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const before = await anchor.boundingBox();
    const selected = await page.evaluate(() => window.getSelection().toString());
    await expect(composer).toBeFocused();
    // A user reaching the top while automatic recovery is pending must share it.
    await page.locator(".task-conversation-scroll").evaluate((element) => {
      element.dispatchEvent(new Event("scroll"));
    });
    const response = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.has("cursor"));
    historyGate.resolve();
    await response;
    await expectAllTurns(page);
    await expect(composer).toHaveValue("Draft survives automatic repair");
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected);
    expect(Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThanOrEqual(2);
    expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor]);
    await page.screenshot({ path: testInfo.outputPath("automatic-turn-repair.png") });
  } finally {
    historyGate.resolve();
  }
});

test("a page with a new cursor but no new history stops and retries the original cursor", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture({ longThirdTurn: true });
  const client = await installTurnGapFixture(page, fixture);
  client.setHistoryResponse(async () => ({
    ...fixture.latest, eventRevision: 203, eventsPage: { nextCursor: "unrelated-next-cursor" },
  }));
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, fixture.first);
  await client.emit([syncPacket(fixture.latest)]);
  const error = page.locator(".task-history-error");
  await expect(error).toContainText("History made no progress");
  await page.locator(".task-conversation-scroll").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByText("Answer for turn 3", { exact: true })).toBeVisible();
  expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor]);
  const response = page.waitForResponse((response) => new URL(response.url()).searchParams.has("cursor"));
  await page.getByRole("button", { name: "Retry loading older messages", exact: true }).click();
  await response;
  await expect(error).toContainText("History made no progress");
  expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor, fixture.latest.eventsPage.nextCursor]);
});

async function expectAllTurns(page) {
  // Assert rendered questions and answers, including order and multiplicity.
  await expect(page.locator('[data-event-type="user_message"]')).toHaveText([
    "Question for turn 1",
    "Question for turn 2",
    "Question for turn 3",
  ]);
  await expect(page.getByText(/^Answer for turn [123]$/)).toHaveText([
    "Answer for turn 1",
    "Answer for turn 2",
    "Answer for turn 3",
  ]);
}

test("opening an idle Task clears first-load progress when resumed history arrives first", { tag: "@desktop" }, async ({ page }) => {
  const fixture = turnGapFixture({ longThirdTurn: true });
  fixture.task.threadStatus = { type: "idle" };
  fixture.task.activeTurn = null;
  const client = await installTurnGapFixture(page, fixture);
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  client.setHistoryResponse(async () => {
    started.resolve();
    await response.promise;
    return fixture.history;
  });
  try {
    await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
    await emitTaskDetailBootstrap(page, fixture.latest);
    await page.getByRole("button", { name: "Load older messages", exact: true }).click();
    await started.promise;
    await expect(page.getByText("Loading older messages...", { exact: true })).toBeVisible();
    // This is the canonical initial resume of an idle Task, not a later live turn.
    const cancelled = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).searchParams.get("cursor") === fixture.latest.eventsPage.nextCursor,
    });
    await client.emit([syncPacket(fixture.complete, "session-bootstrap")]);
    await expectAllTurns(page);
    await expect(page.getByText("Loading older messages...", { exact: true })).toHaveCount(0);
    await cancelled;
    expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor]);
  } finally {
    response.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("idle entry shows an incomplete initial history even when no continuation was supplied", { tag: "@all-viewports" }, async ({ page }, testInfo) => {
  const fixture = turnGapFixture();
  const client = await installTurnGapFixture(page, fixture);
  await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
  await emitTaskDetailBootstrap(page, { ...fixture.first, eventsRange: null });
  await expect(page.getByText("Answer for turn 1", { exact: true })).toBeVisible();
  await client.emit([syncPacket({ ...fixture.latest, eventsPage: { nextCursor: null } }, "session-bootstrap")]);
  const error = page.getByRole("alert").filter({ hasText: "Some earlier messages could not be connected" });
  await expect(error).toBeVisible();
  await error.scrollIntoViewIfNeeded();
  await expect(error).toBeInViewport();
  await expect(page.getByRole("button", { name: "Retry loading older messages", exact: true })).toHaveCount(0);
  expect(await error.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(client.reads, "an unavailable continuation must not trigger a speculative provider read").toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("idle-entry-history-error.png") });
});

test("backgrounding during idle entry retires its first history request before reentry", { tag: "@desktop" }, async ({ page }) => {
  await page.addInitScript(() => {
    window.__entryVisibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__entryVisibility });
  });
  const fixture = turnGapFixture({ longThirdTurn: true });
  const client = await installTurnGapFixture(page, fixture);
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  client.setHistoryResponse(async () => {
    started.resolve();
    await response.promise;
    return fixture.history;
  });
  try {
    await page.goto(`/tasks/${fixture.threadId}?cwd=src`);
    await emitTaskDetailBootstrap(page, fixture.latest);
    await expect.poll(() => page.locator("caffold-app-shell").evaluate((shell) => {
      const runtime = shell.foregroundRecoveryLifecycle.runtime.runtime;
      return runtime.inFlight === null && runtime.retryTimer === null;
    })).toBe(true);
    const composer = page.locator('.task-follow-up-form textarea[name="prompt"]');
    await composer.fill("Keep the idle entry draft");
    await page.getByRole("button", { name: "Load older messages", exact: true }).click();
    await started.promise;
    const cancelled = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).searchParams.get("cursor") === fixture.latest.eventsPage.nextCursor,
      timeout: 7500,
    });
    await page.evaluate(() => {
      window.__entryVisibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await cancelled;
    await page.evaluate(() => {
      window.__entryVisibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await emitTaskDetailBootstrap(page, fixture.complete);
    response.resolve();
    await expectAllTurns(page);
    await expect(composer).toHaveValue("Keep the idle entry draft");
    await expect(page.getByText("Loading older messages...", { exact: true })).toHaveCount(0);
    await expect(page.locator(".task-history-error")).toHaveCount(0);
    expect(client.reads).toEqual([fixture.latest.eventsPage.nextCursor]);
  } finally {
    response.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});
