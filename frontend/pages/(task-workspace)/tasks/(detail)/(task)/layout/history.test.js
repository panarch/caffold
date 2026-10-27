import assert from "node:assert/strict";
import test from "node:test";
import { ConversationHistory } from "./history.js";

const position = (anchorMs) => ({ anchorMs, index: 0 });
function page(from, to, nextCursor = null, revision = 1) {
  return {
    task: { threadId: "t" }, eventRevision: revision,
    events: [from, to].map((time) => ({ id: `e-${time}`, position: position(time) })),
    eventsRange: { from: position(from), to: null },
    eventsPage: { nextCursor },
  };
}
function fixture() {
  const requests = [];
  const applied = [];
  let display;
  const model = new ConversationHistory({
    load: (threadId, cursor, { signal }) => new Promise((resolve, reject) => requests.push({ threadId, cursor, signal, resolve, reject })),
    apply: (detail, { cursor }) => { applied.push(detail); model.accept(detail, cursor); },
    change: (state) => { display = state; },
  });
  return { model, requests, applied, get display() { return display; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("inactive rejects requests; first page never eagerly walks all older history", async () => {
  const { model, requests } = fixture();
  await model.request({ retry: true });
  assert.equal(model.state, "inactive");
  model.activate("t");
  model.accept(page(20, 30, "older"));
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(requests.length, 0);
  assert.equal(model.cursor, "older");
});

test("open membership extents do not join missing pages; recovery and scrolling share a request", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 4));
  model.accept(page(30, 40, "middle", 2));
  await settle();
  assert.deepEqual(requests.map(({ cursor }) => cursor), ["middle"]);
  assert.equal(model.state, "loading");
  const pending = model.request();
  assert.equal(pending, model.request({ retry: true }));
  requests[0].resolve(page(1, 29, null, 3));
  await pending;
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, null);
  assert.equal(requests.length, 1);
});

test("actual overlap joins before queued recovery and preserves the oldest continuation", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 5, "oldest"));
  model.accept(page(8, 12, "gap", 3));
  model.accept(page(4, 10, "irrelevant", 2));
  await settle();
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, "oldest");
  assert.equal(requests.length, 0);
});

test("cursor chains cross adjacent nonoverlapping slices and stop at retained history", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 3));
  model.accept(page(30, 40, "a"));
  await settle();
  requests[0].resolve(page(20, 29, "b", 2));
  await settle();
  assert.deepEqual(requests.map(({ cursor }) => cursor), ["a", "b"]);
  requests[1].resolve(page(3, 19, "older", 3));
  await settle();
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, null);
});

test("unknown membership and loading snapshots cannot replace a known continuation", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(10, 20, "older"));
  assert.equal(model.accept({ ...page(1, 30), eventsRange: null }), false);
  assert.equal(model.accept({ ...page(1, 30), historyLoading: true }), false);
  await settle();
  assert.equal(model.cursor, "older");
  assert.equal(requests.length, 0);
});

for (const nextCursor of ["known-older", null]) {
  test(`an unscoped hint cannot replace a known ${nextCursor ? "continuation" : "end of history"}`, async () => {
    const { model, requests } = fixture();
    model.activate("t");
    model.accept(page(20, 30, nextCursor));
    model.accept({ ...page(20, 30, "unscoped-hint", 2), eventsRange: null });
    await settle();
    assert.equal(model.cursor, nextCursor);
    const pending = model.request();
    if (nextCursor) requests[0].resolve(page(1, 19, null, 3));
    await pending;
    assert.deepEqual(requests.map(({ cursor }) => cursor), nextCursor ? [nextCursor] : []);
    assert.equal(model.state, "ready");
    assert.equal(model.cursor, null);
  });
}

test("an error blocks automatic and scroll retries until an explicit retry succeeds", async () => {
  const f = fixture();
  f.model.activate("t");
  f.model.accept(page(10, 20, "older"));
  const pending = f.model.request();
  f.requests[0].reject(new Error("offline"));
  await pending;
  assert.equal(f.model.state, "blocked");
  assert.equal(f.display.error.message, "offline");
  await f.model.request();
  await f.model.request({ automatic: true });
  assert.equal(f.requests.length, 1);
  const retry = f.model.request({ retry: true });
  f.requests[1].resolve(page(1, 9, null, 2));
  await retry;
  assert.equal(f.model.state, "ready");
  assert.equal(f.display.error, null);
  await f.model.request({ retry: true });
  assert.equal(f.requests.length, 2);
});

for (const invalid of [
  ["repeated cursor", page(1, 9, "older", 2)],
  ["unscoped response", { ...page(1, 9), eventsRange: null }],
  ["different task", { ...page(1, 9), task: { threadId: "other" } }],
  ["no progress", page(10, 20, "older", 1)],
]) {
  test(`${invalid[0]} stops recovery without applying an invalid page`, async () => {
    const { model, requests, applied } = fixture();
    model.activate("t");
    model.accept(page(10, 20, "older"));
    const pending = model.request();
    requests[0].resolve(invalid[1]);
    await pending;
    await settle();
    assert.equal(model.state, "blocked");
    assert.equal(requests.length, 1);
    assert.equal(applied.length, 0);
  });
}

for (const transition of ["deactivate", "reset", "switch"]) {
  for (const failed of [false, true]) {
    test(`${transition} ignores an old ${failed ? "failure" : "completion"}`, async () => {
      const { model, requests, applied } = fixture();
      model.activate("t");
      model.accept(page(10, 20, "older"));
      const pending = model.request();
      if (transition === "deactivate") model.deactivate();
      else model.activate(transition === "switch" ? "other" : "t");
      assert.equal(requests[0].signal.aborted, true);
      if (failed) requests[0].reject(new Error("old error"));
      else requests[0].resolve(page(1, 9));
      await pending;
      assert.equal(model.state, transition === "deactivate" ? "inactive" : "ready");
      assert.equal(applied.length, 0);
      assert.equal(model.error, null);
    });
  }
}

test("a multi-page cursor cycle stops after its first repetition", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 3));
  model.accept(page(30, 40, "a"));
  await settle();
  requests[0].resolve(page(20, 29, "b", 2));
  await settle();
  requests[1].resolve(page(10, 19, "a", 3));
  await settle();
  assert.equal(model.state, "blocked");
  assert.deepEqual(requests.map(({ cursor }) => cursor), ["a", "b"]);
});

test("a new baseline discards pages whose rows the canonical snapshot deleted", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(40, 41, "old-cursor", 40));
  model.activate("t");
  const replacement = page(1, 2, null, 1);
  model.accept(replacement, null, replacement.events);
  await settle();
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, null);
  assert.equal(requests.length, 0);
});

test("an unscoped loading answer preserves a manual cursor without claiming coverage", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept({ ...page(1, 2, "manual"), historyLoading: true, eventsRange: null });
  await settle();
  assert.equal(model.pages.length, 1);
  assert.deepEqual(model.pages[0].from, model.pages[0].to, "only one position is known");
  assert.equal(model.cursor, "manual");
  assert.equal(requests.length, 0);
  const pending = model.request();
  requests[0].resolve(page(1, 2));
  await pending;
  assert.equal(model.state, "ready");
  assert.equal(model.cursor, null);
});

test("the first manual continuation connects a disjoint unscoped entry to the next older page", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept({ ...page(20, 30, "first-older"), eventsRange: null });
  await settle();
  assert.equal(requests.length, 0, "entry does not eagerly read older history");
  const first = model.request();
  requests[0].resolve(page(10, 19, "next-older", 2));
  await first;
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(model.error, null);
  assert.equal(model.cursor, "next-older");
  assert.equal(requests.length, 1, "a cursor continuation closes the entry gap");
  const second = model.request();
  requests[1].resolve(page(1, 9, null, 3));
  await second;
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(model.cursor, null);
  assert.deepEqual(requests.map(({ cursor }) => cursor), ["first-older", "next-older"]);
});

test("a later unscoped hint connects its own entry position without skipping an earlier retained gap", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept({ ...page(1, 3), eventsRange: null });
  model.accept({ ...page(30, 40, "first-older", 2), eventsRange: null });
  const first = model.request();
  requests[0].resolve(page(20, 29, "gap", 3));
  await first;
  await settle();
  assert.deepEqual(requests.map(({ cursor }) => cursor), ["first-older", "gap"],
    "the newer hint cannot claim to have loaded the gap back to the earlier entry");
  requests[1].resolve(page(1, 19, null, 4));
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, null);
});

for (const failed of [false, true]) {
  test(`a canonical page that fills a pending hole makes its later ${failed ? "error" : "result"} unnecessary`, async () => {
    const { model, requests, applied } = fixture();
    model.activate("t");
    model.accept(page(1, 3));
    model.accept(page(10, 20, "gap", 2));
    await settle();
    model.accept(page(1, 20, null, 3));
    if (failed) requests[0].reject(new Error("old failure"));
    else requests[0].resolve(page(1, 9, "gap"));
    await settle();
    assert.equal(model.state, "ready");
    assert.equal(model.error, null);
    assert.equal(applied.length, 0);
    assert.equal(requests.length, 1);
  });
}

test("a gap without a continuation stays visible as an error without speculative reads", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 3));
  model.accept(page(10, 20));
  await settle();
  assert.equal(model.state, "blocked");
  assert.match(model.error.message, /could not be connected/);
  assert.equal(requests.length, 0);
});

test("a new revision and cursor without new page coverage cannot prolong traversal", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(1, 3));
  model.accept(page(10, 20, "a", 1));
  await settle();
  requests[0].resolve(page(10, 20, "b", 2));
  await settle();
  assert.equal(model.state, "blocked");
  assert.match(model.error.message, /no progress/);
  assert.equal(model.cursor, "a", "an invalid page cannot advance the retry cursor");
  assert.equal(requests.length, 1);
});

test("inactive snapshots are ignored and canonical coverage resolves only the obsolete history error", async () => {
  const { model, requests } = fixture();
  assert.equal(model.accept(page(1, 3, "ignored")), false);
  assert.equal(model.pages.length, 0);
  model.activate("t");
  model.accept(page(10, 20, "a", 1));
  const pending = model.request();
  requests[0].reject(new Error("offline"));
  await pending;
  model.accept(page(10, 20, "a", 2));
  assert.equal(model.state, "blocked");
  model.accept(page(1, 20, null, 3));
  await settle();
  assert.equal(model.state, "ready");
  assert.equal(model.error, null);
  assert.equal(requests.length, 1);
});

test("an unscoped first response anchors later gap recovery without declaring its span complete", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept({ ...page(1, 3), eventsRange: null, historyLoading: true });
  await settle();
  assert.equal(requests.length, 0);
  model.accept(page(10, 20, "gap", 2));
  await settle();
  assert.equal(requests[0].cursor, "gap");
  requests[0].resolve(page(1, 9, null, 3));
  await settle();
  assert.equal(model.pages.length, 1);
  assert.equal(model.cursor, null);
  assert.equal(requests.length, 1);
});

test("a repeated boundary on an initial bounded page does not trigger eager history reads", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  const detail = page(10, 20, "older");
  detail.events.unshift({ id: "boundary", position: position(1) });
  model.accept(detail);
  await settle();
  assert.equal(model.pages.length, 1);
  assert.equal(model.pages[0].from.anchorMs, 10);
  assert.equal(requests.length, 0);
});

test("idle entry hydration settles a covered first history request before its HTTP response", async () => {
  const { model, requests } = fixture();
  model.activate("t");
  model.accept(page(20, 30, "cached-cursor", 10));
  const pending = model.request();
  assert.equal(requests.length, 1);
  // Opening an idle Task sends cached state before its resumed canonical page.
  // That page can satisfy Load more while the separate HTTP answer is pending.
  model.accept(page(1, 30, null, 11));
  assert.equal(model.state, "ready", "the initial hydration already supplied the requested history");
  assert.equal(model.cursor, null);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(page(1, 19, null, 10));
  await pending;
  assert.equal(model.state, "ready");
});

for (const failed of [false, true]) {
  test(`an obsolete first ${failed ? "error" : "response"} cannot finish the next entry history request`, async () => {
    const { model, requests } = fixture();
    model.activate("t");
    model.accept(page(20, 30, "cached", 10));
    const first = model.request();
    model.accept(page(10, 30, "older", 11));
    assert.equal(model.state, "ready");
    assert.equal(requests[0].signal.aborted, true);
    const second = model.request();
    assert.equal(requests[1].signal.aborted, false);
    if (failed) requests[0].reject(new Error("obsolete failure"));
    else requests[0].resolve(page(10, 19, "older", 10));
    await first;
    assert.equal(model.state, "loading");
    assert.equal(model.pending, second);
    assert.equal(model.error, null);
    requests[1].resolve(page(1, 9, null, 12));
    await second;
    assert.equal(model.state, "ready");
    assert.equal(model.cursor, null);
  });
}
