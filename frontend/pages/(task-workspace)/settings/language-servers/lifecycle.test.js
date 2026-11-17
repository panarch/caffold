import assert from "node:assert/strict";
import test from "node:test";

import {
  LanguageSettingsLifecycle,
  RunningServersLifecycle,
} from "./lifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setting(id, enabled) {
  return {
    id,
    name: id === "rust" ? "Rust" : "TypeScript/JavaScript",
    enabled,
    serverName: id === "rust" ? "rust-analyzer" : "typescript-language-server",
  };
}

function languagesHarness() {
  const loads = [];
  const updates = [];
  let announced = 0;
  const lifecycle = new LanguageSettingsLifecycle({
    load: () => {
      const request = deferred();
      loads.push(request);
      return request.promise;
    },
    update: (languages) => {
      const request = deferred();
      updates.push({ languages, ...request });
      return request.promise;
    },
    announceChange: () => {
      announced += 1;
    },
  });
  return { lifecycle, loads, updates, announced: () => announced };
}

test("reads the languages when shown and turns one on with the others it keeps", async () => {
  const { lifecycle, loads, updates, announced } = languagesHarness();
  assert.equal(lifecycle.phase, "inactive");
  lifecycle.activate();
  assert.equal(lifecycle.phase, "loading");
  assert.equal(lifecycle.snapshot.busy, true);
  loads[0].resolve({
    languages: [setting("rust", false), setting("typescript", true)],
  });
  await settle();
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.snapshot.ready, true);

  const saved = lifecycle.setEnabled("rust", true);
  assert.equal(lifecycle.phase, "saving");
  assert.deepEqual(lifecycle.snapshot.saving, { language: "rust", enabled: true });
  assert.deepEqual(updates[0].languages, ["rust", "typescript"]);
  assert.equal(await lifecycle.setEnabled("typescript", false), false, "one at a time");
  updates[0].resolve({
    languages: [setting("rust", true), setting("typescript", true)],
  });
  assert.equal(await saved, true);
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.snapshot.saving, null);
  assert.equal(lifecycle.snapshot.languages[0].enabled, true);
  assert.equal(announced(), 1);

  lifecycle.setEnabled("typescript", false);
  assert.deepEqual(updates[1].languages, ["rust"]);
});

test("a refused change keeps the languages; an unanswered one reads them again", async () => {
  const { lifecycle, loads, updates, announced } = languagesHarness();
  lifecycle.activate();
  loads[0].resolve({ languages: [setting("rust", false)] });
  await settle();

  const refused = lifecycle.setEnabled("rust", true);
  updates[0].reject(Object.assign(new Error("Requests must come from this page."), { status: 403 }));
  assert.equal(await refused, false);
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.snapshot.message, "Requests must come from this page.");
  assert.equal(lifecycle.snapshot.languages[0].enabled, false);

  const lost = lifecycle.setEnabled("rust", true);
  updates[1].reject(new Error("Failed to fetch"));
  assert.equal(await lost, false);
  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(lifecycle.snapshot.retry, true);
  assert.equal(announced(), 0);

  lifecycle.retry();
  assert.equal(lifecycle.phase, "loading");
  assert.equal(lifecycle.snapshot.message, "");
  loads[1].resolve({ languages: [setting("rust", true)] });
  await settle();
  assert.equal(lifecycle.phase, "ready");
  assert.equal(lifecycle.snapshot.languages[0].enabled, true);
});

test("a failed read offers Retry, and leaving drops every late answer", async () => {
  const { lifecycle, loads, updates, announced } = languagesHarness();
  lifecycle.activate();
  loads[0].reject(new Error("The server did not answer."));
  await settle();
  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(lifecycle.snapshot.languages, null);
  assert.equal(lifecycle.snapshot.message, "The server did not answer.");

  lifecycle.deactivate();
  assert.equal(lifecycle.phase, "inactive");
  lifecycle.retry();
  assert.equal(loads.length, 1, "nothing retries while hidden");

  lifecycle.activate();
  lifecycle.deactivate();
  loads[1].resolve({ languages: [setting("rust", true)] });
  await settle();
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(lifecycle.snapshot.languages, null);

  lifecycle.activate();
  loads[2].resolve({ languages: [setting("rust", false)] });
  await settle();
  const saved = lifecycle.setEnabled("rust", true);
  lifecycle.deactivate();
  updates[0].resolve({ languages: [setting("rust", true)] });
  assert.equal(await saved, false);
  assert.equal(lifecycle.snapshot.saving, null);
  assert.equal(lifecycle.snapshot.languages[0].enabled, false);
  assert.equal(announced(), 1, "the server changed all the same");
});

test("refuses settings that are not a list of languages", async () => {
  const { lifecycle, loads } = languagesHarness();
  lifecycle.activate();
  loads[0].resolve({ languages: [{ id: "rust" }] });
  await settle();
  assert.equal(lifecycle.snapshot.message, "Caffold returned invalid language server settings.");
});

function running(paths) {
  return {
    servers: paths.map((path) => ({
      repositoryPath: path,
      language: "rust",
      languageName: "Rust",
      serverName: "rust-analyzer",
      installCommand: "install",
      state: "ready",
      memoryBytes: 1024 ** 3,
    })),
    totalMemoryBytes: paths.length * 1024 ** 3,
  };
}

function runningHarness() {
  const loads = [];
  const stops = [];
  const timers = new Map();
  let nextTimer = 0;
  let announced = 0;
  const lifecycle = new RunningServersLifecycle({
    load: () => {
      const request = deferred();
      loads.push(request);
      return request.promise;
    },
    stop: (path) => {
      const request = deferred();
      stops.push({ path, ...request });
      return request.promise;
    },
    announceChange: () => {
      announced += 1;
    },
    schedule: (callback, delay) => {
      nextTimer += 1;
      timers.set(nextTimer, { callback, delay });
      return nextTimer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  return {
    lifecycle,
    loads,
    stops,
    timers,
    announced: () => announced,
    fireTimer() {
      const [[id, { callback }]] = timers;
      timers.delete(id);
      callback();
    },
  };
}

test("reads the running servers every few seconds while shown, and stops when hidden", async () => {
  const { lifecycle, loads, timers, fireTimer } = runningHarness();
  assert.equal(lifecycle.phase, "inactive");
  lifecycle.activate();
  assert.equal(lifecycle.phase, "reading");
  loads[0].resolve(running(["repo"]));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.snapshot.running.servers.length, 1);
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [3000]);

  fireTimer();
  assert.equal(lifecycle.phase, "reading");
  loads[1].resolve(running([]));
  await settle();
  assert.equal(lifecycle.snapshot.running.servers.length, 0);

  lifecycle.deactivate();
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(timers.size, 0);
  lifecycle.refresh();
  assert.equal(loads.length, 2, "nothing reads while hidden");
});

test("reads at once after a language changed, past a read in flight", async () => {
  const { lifecycle, loads, timers } = runningHarness();
  lifecycle.activate();
  lifecycle.refresh();
  assert.equal(loads.length, 2);
  loads[0].resolve(running(["old"]));
  await settle();
  assert.equal(lifecycle.snapshot.running, null, "the older read is dropped");
  loads[1].resolve(running(["repo"]));
  await settle();
  assert.equal(lifecycle.snapshot.running.servers[0].repositoryPath, "repo");

  lifecycle.refresh();
  assert.equal(lifecycle.phase, "reading");
  assert.equal(timers.size, 0, "the scheduled read is replaced");
});

test("turns a repository off, announces it, and reads the servers again", async () => {
  const { lifecycle, loads, stops, timers, announced } = runningHarness();
  lifecycle.activate();
  loads[0].resolve(running(["repo", "other"]));
  await settle();

  lifecycle.turnOff("repo");
  assert.equal(lifecycle.phase, "stopping");
  assert.equal(lifecycle.snapshot.stopping, "repo");
  assert.equal(timers.size, 0);
  lifecycle.turnOff("other");
  lifecycle.refresh();
  assert.deepEqual(stops.map(({ path }) => path), ["repo"], "one at a time");
  assert.equal(loads.length, 1);

  stops[0].resolve({ path: "repo", enabled: false, servers: [] });
  await settle();
  assert.equal(announced(), 1);
  assert.equal(lifecycle.phase, "reading");
  assert.equal(lifecycle.snapshot.stopping, null);
  loads[1].resolve(running(["other"]));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
});

test("keeps a failed turn off in view while reads go on, until the next turn off", async () => {
  const { lifecycle, loads, stops, fireTimer, announced } = runningHarness();
  lifecycle.activate();
  loads[0].resolve(running(["repo"]));
  await settle();

  lifecycle.turnOff("repo");
  stops[0].reject(new Error("Requests must come from this page."));
  await settle();
  assert.equal(announced(), 0);
  loads[1].resolve(running(["repo"]));
  await settle();
  fireTimer();
  loads[2].resolve(running(["repo"]));
  await settle();
  assert.equal(lifecycle.snapshot.message, "Requests must come from this page.");

  lifecycle.turnOff("repo");
  assert.equal(lifecycle.snapshot.message, "");
});

test("a failed read shows nothing in place of the servers until a read succeeds", async () => {
  const { lifecycle, loads, timers, fireTimer } = runningHarness();
  lifecycle.activate();
  loads[0].resolve(running(["repo"]));
  await settle();
  fireTimer();
  loads[1].reject(new Error("The server did not answer."));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.snapshot.running, null);
  assert.equal(lifecycle.snapshot.message, "The server did not answer.");
  assert.equal(timers.size, 1);

  fireTimer();
  loads[2].resolve(running(["repo"]));
  await settle();
  assert.equal(lifecycle.snapshot.message, "");
  assert.equal(lifecycle.snapshot.running.servers.length, 1);
});

test("a turn off that answers after the page was left is still announced, and nothing more", async () => {
  const { lifecycle, loads, stops, announced } = runningHarness();
  lifecycle.activate();
  lifecycle.turnOff("repo");
  assert.equal(lifecycle.phase, "stopping", "a read in flight gives way");
  lifecycle.deactivate();
  stops[0].resolve({ path: "repo", enabled: false, servers: [] });
  loads[0].resolve(running(["repo"]));
  await settle();
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(announced(), 1);
  assert.equal(loads.length, 1);
  assert.equal(lifecycle.snapshot.running, null);
});
