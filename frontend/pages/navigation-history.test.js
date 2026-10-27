import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = {
  location: { origin: "http://caffold.test" },
};

const { parseRoute, routeUrl } = await import("../navigation-routes.js");
const { NAVIGATION_HISTORY_ACTION, NavigationHistory } = await import(
  "./navigation-history.js"
);

// Walks a person's route requests through the history and reports what the
// browser was asked to do at each step.
function walk(urls, { start = "/" } = {}) {
  const history = new NavigationHistory();
  let current = parseRoute(start);
  for (const entry of history.resolveEntry(null, current, true)) {
    history.commit(entry);
  }

  const steps = [];
  for (const url of urls) {
    const route = parseRoute(url);
    const entries = history.resolve(current, route);
    const decision = entries.at(-1);
    steps.push({
      url,
      action: decision.action,
      steps: decision.steps,
      descentRun: decision.descentRun,
      written: entries.map((entry) => routeUrl(entry.route)),
    });
    if (decision.action === NAVIGATION_HISTORY_ACTION.TRAVERSE) {
      continue;
    }
    for (const entry of entries) {
      history.commit(entry);
    }
    current = route;
  }

  return { history, steps, current };
}

const { PUSH, REPLACE, TRAVERSE, NONE } = NAVIGATION_HISTORY_ACTION;

test("adds an entry only for routes that reach under the current one", () => {
  const { steps } = walk([
    "/tasks/thread",
    "/tasks/thread/github/issues",
    "/tasks/thread/github/issues/42",
  ]);

  assert.deepEqual(steps.map((step) => step.action), [PUSH, REPLACE, PUSH]);
  assert.deepEqual(steps.map((step) => step.descentRun), [1, 1, 2]);
});

test("replaces the current entry when only the subject or field changes", () => {
  const { steps } = walk([
    "/tasks/thread/github/issues",
    "/tasks/thread/github/issues?page=2",
    "/tasks/thread/github/issues/42?page=2",
    "/tasks/thread/github/issues/43?page=2",
  ]);

  assert.deepEqual(
    steps.map((step) => step.action),
    [PUSH, REPLACE, PUSH, REPLACE],
  );
  assert.deepEqual(steps.map((step) => step.descentRun), [1, 1, 2, 2]);
});

test("keeps Task Conversation, Review, Git, and GitHub at one entry", () => {
  const { steps } = walk([
    "/tasks/thread",
    "/tasks/thread/review",
    "/tasks/thread/git/log",
    "/tasks/thread/github/pulls",
  ]);

  assert.deepEqual(
    steps.map((step) => step.action),
    [PUSH, REPLACE, REPLACE, REPLACE],
  );
  assert.deepEqual(steps.map((step) => step.descentRun), [1, 1, 1, 1]);
});

test("rewinds the entries a descent created instead of adding another", () => {
  const { history, current } = walk([
    "/tasks/thread",
    "/tasks/thread/review",
    "/tasks/thread/review?file=src%2Flib.rs",
  ]);

  const [toReview] = history.resolve(current, parseRoute("/tasks/thread/review"));
  assert.equal(toReview.action, TRAVERSE);
  assert.equal(toReview.steps, 1);

  const [toTasks] = history.resolve(current, parseRoute("/"));
  assert.equal(toTasks.action, TRAVERSE);
  assert.equal(toTasks.steps, 2);
});

test("replaces instead of rewinding past entries nothing wrote", () => {
  const history = new NavigationHistory();
  const deepLink = parseRoute("/tasks/thread/review?file=src%2Flib.rs");
  // Only the route itself, as if the entries under it were never written.
  history.commit({ route: deepLink, action: REPLACE, steps: 0, descentRun: 0 });

  const [decision] = history.resolve(deepLink, parseRoute("/tasks/thread/review"));
  assert.equal(decision.action, REPLACE);
  assert.equal(decision.descentRun, 0);
});

test("forgets the entries below a replacement that sits somewhere else", () => {
  const { history, current } = walk([
    "/tasks/thread/github/issues",
    "/tasks/thread/github/issues/42",
  ]);
  assert.equal(history.descentRun, 2);

  const [decision] = history.resolve(current, parseRoute("/tasks/other"));
  assert.equal(decision.action, REPLACE);
  assert.equal(decision.descentRun, 0);
});

test("leaves a tab at the depth it was left and returns to it", () => {
  const { history, current } = walk([
    "/tasks/thread",
    "/tasks/thread/review",
    "/tasks/thread/review?file=src%2Flib.rs",
  ]);

  const notes = parseRoute("/notes/note-1");
  const toNotes = history.resolve(current, notes);
  assert.deepEqual(toNotes.map((entry) => routeUrl(entry.route)), [
    "/notes",
    "/notes/note-1",
  ]);
  assert.deepEqual(toNotes.map((entry) => entry.descentRun), [0, 1]);
  for (const entry of toNotes) {
    history.commit(entry);
  }

  assert.equal(
    routeUrl(history.routeForTab("tasks")),
    "/tasks/thread/review?file=src%2Flib.rs",
  );
  assert.equal(routeUrl(history.routeForTab("notes")), "/notes/note-1");
});

test("opens an unvisited tab at the route its owner supplies", () => {
  const { history } = walk([]);

  const fallback = parseRoute("/settings/codex");
  assert.equal(routeUrl(history.routeForTab("settings", fallback)), "/settings/codex");
  assert.equal(history.routeForTab("settings"), null);
});

test("repeats the current route without touching the history", () => {
  const { history, current } = walk(["/tasks/thread"]);

  const [decision] = history.resolve(current, parseRoute("/tasks/thread"));
  assert.equal(decision.action, NONE);
  assert.equal(decision.descentRun, history.descentRun);
});

test("never leaves an entry behind a correction", () => {
  const { history, current } = walk(["/tasks/thread", "/tasks/thread/review"]);

  const [correction] = history.resolveCorrection(current, parseRoute("/"));
  assert.equal(correction.action, REPLACE);
});

test("opens a notification's Task over the screens it sits under", () => {
  // The screens under the Task go in, whatever the notification interrupted,
  // so Back reaches the Task list rather than what was on screen.
  const fromSettings = walk(["/settings/appearance"]);
  const task = parseRoute("/tasks/thread");
  const overSettings = fromSettings.history.resolveEntry(
    fromSettings.current,
    task,
    false,
  );
  assert.deepEqual(overSettings.map((entry) => routeUrl(entry.route)), [
    "/",
    "/tasks/thread",
  ]);
  assert.deepEqual(overSettings.map((entry) => entry.action), [PUSH, PUSH]);
  assert.deepEqual(overSettings.map((entry) => entry.descentRun), [0, 1]);

  // The Task list is already the entry being left, so it is not written twice.
  const fromHome = walk([]);
  const overHome = fromHome.history.resolveEntry(fromHome.current, task, false);
  assert.deepEqual(overHome.map((entry) => routeUrl(entry.route)), [
    "/tasks/thread",
  ]);
  assert.deepEqual(overHome.map((entry) => entry.action), [PUSH]);
  assert.deepEqual(overHome.map((entry) => entry.descentRun), [1]);
});

test("restores every tab from the entry the browser reached", () => {
  const { history } = walk([
    "/tasks/thread",
    "/tasks/thread/review",
    "/notes/note-1",
  ]);
  const snapshot = history.snapshot();

  const reached = new NavigationHistory();
  reached.restore(snapshot);

  assert.equal(routeUrl(reached.routeForTab("tasks")), "/tasks/thread/review");
  assert.equal(routeUrl(reached.routeForTab("notes")), "/notes/note-1");
  assert.equal(reached.routeForTab("settings"), null);
  assert.equal(reached.descentRun, snapshot.descentRun);
});

test("writes the screens under a route the browser reached from outside", () => {
  const history = new NavigationHistory();
  const cases = [
    ["/", ["/"]],
    ["/notes", ["/notes"]],
    ["/settings", ["/settings"]],
    ["/notes/note-1", ["/notes", "/notes/note-1"]],
    ["/settings/appearance", ["/settings", "/settings/appearance"]],
    ["/tasks/thread", ["/", "/tasks/thread"]],
    [
      "/tasks/thread/github/pulls/12/files?file=src%2Flib.rs",
      [
        "/",
        "/tasks/thread/github/pulls",
        "/tasks/thread/github/pulls/12",
        "/tasks/thread/github/pulls/12/files",
        "/tasks/thread/github/pulls/12/files?file=src%2Flib.rs",
      ],
    ],
  ];

  for (const [url, expected] of cases) {
    const entries = history.resolveEntry(null, parseRoute(url), true);
    assert.deepEqual(entries.map((entry) => routeUrl(entry.route)), expected, url);
    // The entry the browser already holds is reused; the rest are added under
    // the route, each knowing how many of them it can rewind through.
    assert.deepEqual(
      entries.map((entry) => entry.action),
      expected.map((_, index) => (index === 0 ? REPLACE : PUSH)),
      url,
    );
    assert.deepEqual(
      entries.map((entry) => entry.descentRun),
      expected.map((_, index) => index),
      url,
    );
  }
});

test("leaves a route the browser reached from outside rewinding through its own entries", () => {
  const history = new NavigationHistory();
  const route = parseRoute("/tasks/thread/review?file=src%2Flib.rs");
  for (const entry of history.resolveEntry(null, route, true)) {
    history.commit(entry);
  }
  assert.equal(history.descentRun, 2);

  const [toReview] = history.resolve(route, parseRoute("/tasks/thread/review"));
  assert.equal(toReview.action, TRAVERSE);
  assert.equal(toReview.steps, 1);
});

test("keeps a link inside one tab on the screen it was followed from", () => {
  const { history, current } = walk(["/tasks/thread"]);
  assert.equal(history.descentRun, 1);

  // A Review file opened from the conversation stays on top of it, so Back
  // returns to what was being read rather than walking the file's parents.
  const reviewFile = parseRoute(
    "/tasks/thread/review?nav=files&view=source&file=planner.rs",
  );
  const sideways = history.resolveFollowedLink(current, reviewFile);
  assert.deepEqual(sideways.map((entry) => routeUrl(entry.route)), [
    "/tasks/thread/review?nav=files&view=source&file=planner.rs",
  ]);
  assert.deepEqual(sideways.map((entry) => entry.action), [REPLACE]);
  assert.deepEqual(sideways.map((entry) => entry.descentRun), [0]);

  // A link that reaches under the current screen keeps the run going.
  history.commit(sideways[0]);
  const deeper = history.resolveFollowedLink(
    parseRoute("/tasks/thread/review?nav=files&view=source"),
    reviewFile,
  );
  assert.deepEqual(deeper.map((entry) => entry.descentRun), [1]);
});

test("opens a link into another tab over the screens it sits under", () => {
  const { history, current } = walk(["/settings/appearance"]);

  // The browser already holds the Task, so the chain grows from that entry.
  const crossing = history.resolveFollowedLink(current, parseRoute("/tasks/thread"));
  assert.deepEqual(crossing.map((entry) => routeUrl(entry.route)), [
    "/",
    "/tasks/thread",
  ]);
  assert.deepEqual(crossing.map((entry) => entry.action), [REPLACE, PUSH]);
  assert.deepEqual(crossing.map((entry) => entry.descentRun), [0, 1]);

  // Tasks home is already the screen being left, so it is not written twice.
  const fromHome = walk([]);
  const onward = fromHome.history.resolveFollowedLink(
    fromHome.current,
    parseRoute("/notes/note-1"),
  );
  assert.deepEqual(onward.map((entry) => routeUrl(entry.route)), [
    "/notes",
    "/notes/note-1",
  ]);
  assert.deepEqual(onward.map((entry) => entry.action), [REPLACE, PUSH]);
});
