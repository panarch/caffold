import assert from "node:assert/strict";
import test from "node:test";

import { LanguageServersLifecycle } from "./language-servers.js";

const PATH = "repo";

function repository(state, { enabled = state !== "off", path = PATH } = {}) {
  return {
    path,
    enabled,
    servers: [
      {
        repositoryPath: path,
        language: "rust",
        languageName: "Rust",
        serverName: "rust-analyzer",
        state,
      },
    ],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// A lifecycle whose requests wait for the test to answer them, and whose
// timer runs only when the test fires it.
function harness() {
  const reads = [];
  const updates = [];
  const timers = new Map();
  let nextTimer = 0;
  let announced = 0;
  const lifecycle = new LanguageServersLifecycle({
    load: (path) => {
      const request = deferred();
      reads.push({ path, lookAgain: false, ...request });
      return request.promise;
    },
    check: (path) => {
      const request = deferred();
      reads.push({ path, lookAgain: true, ...request });
      return request.promise;
    },
    update: (path, enabled) => {
      const request = deferred();
      updates.push({ path, enabled, ...request });
      return request.promise;
    },
    announceChange: () => {
      announced += 1;
    },
    schedule: (callback) => {
      nextTimer += 1;
      timers.set(nextTimer, callback);
      return nextTimer;
    },
    cancel: (timer) => timers.delete(timer),
  });
  return {
    lifecycle,
    reads,
    updates,
    timers,
    announced: () => announced,
    fireTimer() {
      const [[id, callback]] = timers;
      timers.delete(id);
      callback();
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("reads when shown, and keeps the answer while hidden to read again when shown", async () => {
  const { lifecycle, reads, timers } = harness();
  assert.equal(lifecycle.phase, "closed");

  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");
  assert.deepEqual(reads.map(({ path }) => path), [PATH]);
  reads[0].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.fresh, true);
  assert.equal(lifecycle.snapshot.repository.servers[0].state, "ready");
  assert.equal(timers.size, 0);

  lifecycle.show(PATH);
  assert.equal(reads.length, 1, "the same repository is not read again");

  lifecycle.hide();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(lifecycle.snapshot.repository.servers[0].state, "ready");
  assert.equal(lifecycle.snapshot.fresh, true);

  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");
  assert.equal(reads.length, 2);
  assert.equal(
    lifecycle.snapshot.repository.servers[0].state,
    "ready",
    "the section stands while it is read again",
  );
  reads[1].resolve(repository("sleeping"));
  await settle();
  assert.equal(lifecycle.snapshot.repository.servers[0].state, "sleeping");

  lifecycle.hide();
  lifecycle.show("other");
  assert.equal(lifecycle.snapshot.repository, null, "another repository starts empty");
});

test("each opening looks again for failed servers, and reads while one gets ready only read", async () => {
  const { lifecycle, reads, fireTimer } = harness();
  lifecycle.preload(PATH);
  reads[0].resolve(repository("failed"));
  await settle();

  lifecycle.show(PATH);
  reads[1].resolve(repository("starting"));
  await settle();
  fireTimer();
  reads[2].resolve(repository("ready"));
  await settle();
  lifecycle.hide();
  lifecycle.show(PATH);

  assert.deepEqual(
    reads.map(({ lookAgain }) => lookAgain),
    [false, true, false, true],
    "the preload and the read while getting ready only read",
  );
});

test("reads again about once a second while a server gets ready, until hidden", async () => {
  const { lifecycle, reads, timers, fireTimer } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("starting"));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(timers.size, 1);

  fireTimer();
  assert.equal(lifecycle.phase, "reading");
  reads[1].resolve(repository("starting"));
  await settle();
  assert.equal(lifecycle.phase, "waiting");

  fireTimer();
  reads[2].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(timers.size, 0);

  lifecycle.show("other");
  reads[3].resolve(repository("starting", { path: "other" }));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  lifecycle.hide();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(timers.size, 0, "closing cancels the next read");
});

test("turns the repository on, waits while it gets ready, and announces the change", async () => {
  const { lifecycle, reads, updates, timers, announced } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("off"));
  await settle();

  lifecycle.turn(true);
  assert.equal(lifecycle.phase, "turning");
  assert.equal(lifecycle.snapshot.turning, "on");
  assert.deepEqual(
    updates.map(({ path, enabled }) => [path, enabled]),
    [[PATH, true]],
  );
  updates[0].resolve(repository("starting"));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.snapshot.turning, null);
  assert.equal(lifecycle.snapshot.repository.enabled, true);
  assert.equal(timers.size, 1);
  assert.equal(announced(), 1);
});

test("turns the repository off and settles without reading again", async () => {
  const { lifecycle, reads, updates, timers, announced } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("ready"));
  await settle();

  lifecycle.turn(false);
  assert.equal(lifecycle.snapshot.turning, "off");
  updates[0].resolve(repository("off"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.repository.enabled, false);
  assert.equal(timers.size, 0);
  assert.equal(reads.length, 1);
  assert.equal(announced(), 1);
});

test("keeps the last answer with the reason when turning fails, and announces nothing", async () => {
  const { lifecycle, reads, updates, announced } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("off"));
  await settle();

  lifecycle.turn(true);
  updates[0].reject(new Error("Requests must come from this page."));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.turning, null);
  assert.equal(lifecycle.snapshot.repository.enabled, false);
  assert.equal(lifecycle.snapshot.error.message, "Requests must come from this page.");
  assert.equal(announced(), 0);
});

test("refuses to turn before an answer, while a server gets ready, or while turning", async () => {
  const { lifecycle, reads, updates, fireTimer } = harness();
  lifecycle.turn(true);
  assert.equal(updates.length, 0, "closed");

  lifecycle.show(PATH);
  lifecycle.turn(true);
  assert.equal(updates.length, 0, "reading with no answer yet");

  reads[0].resolve(repository("starting"));
  await settle();
  lifecycle.turn(false);
  assert.equal(updates.length, 0, "waiting");

  lifecycle.hide();
  lifecycle.show(PATH);
  lifecycle.turn(false);
  assert.equal(updates.length, 0, "reading again an answer with a server getting ready");

  reads[1].resolve(repository("ready"));
  await settle();
  lifecycle.turn(false);
  lifecycle.turn(false);
  assert.equal(updates.length, 1, "turning");
});

test("a switch pressed while the answer is read again replaces the read", async () => {
  const { lifecycle, reads, updates, announced } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("ready"));
  await settle();
  lifecycle.hide();
  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");

  lifecycle.turn(false);
  assert.equal(lifecycle.phase, "turning");
  assert.deepEqual(
    updates.map(({ path, enabled }) => [path, enabled]),
    [[PATH, false]],
  );
  reads[1].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "turning", "the replaced read is dropped");
  updates[0].resolve(repository("off"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.repository.enabled, false);
  assert.equal(announced(), 1);
});

test("a failed read keeps the last answer only as stale, and keeps reading while a server got ready", async () => {
  const { lifecycle, reads, updates, timers, fireTimer } = harness();
  lifecycle.show(PATH);
  reads[0].resolve(repository("starting"));
  await settle();

  fireTimer();
  reads[1].reject(new Error("The server did not answer."));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(lifecycle.snapshot.fresh, false);
  assert.equal(lifecycle.snapshot.error.message, "The server did not answer.");
  assert.equal(timers.size, 1);
  lifecycle.turn(false);
  assert.equal(updates.length, 0, "a stale answer offers no switch");

  fireTimer();
  reads[2].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.snapshot.fresh, true);
  assert.equal(lifecycle.snapshot.error, null);
});

test("a first read that fails shows no repository", async () => {
  const { lifecycle, reads, timers } = harness();
  lifecycle.show(PATH);
  reads[0].reject(new Error("offline"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.repository, null);
  assert.equal(lifecycle.snapshot.error.message, "offline");
  assert.equal(timers.size, 0);
});

test("drops answers that arrive after the popover closed or the repository changed", async () => {
  const { lifecycle, reads, updates, announced } = harness();
  lifecycle.show(PATH);
  lifecycle.hide();
  reads[0].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(lifecycle.snapshot.repository, null);

  lifecycle.show(PATH);
  lifecycle.show("other");
  assert.deepEqual(reads.map(({ path }) => path), [PATH, PATH, "other"]);
  reads[1].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "reading");
  reads[2].resolve(repository("off", { path: "other" }));
  await settle();
  assert.equal(lifecycle.snapshot.repository.path, "other");

  lifecycle.turn(true);
  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading", "a new repository leaves the switch");
  updates[0].resolve(repository("starting", { path: "other" }));
  await settle();
  assert.equal(announced(), 1, "the server changed all the same");
  assert.equal(lifecycle.phase, "reading");
  reads[3].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.snapshot.repository.path, PATH);

  lifecycle.turn(false);
  lifecycle.hide();
  updates[1].resolve(repository("off"));
  await settle();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(
    lifecycle.snapshot.repository.enabled,
    true,
    "an answer to a closed popover stays out; the next opening reads it",
  );
  assert.equal(announced(), 2);
});

test("refuses an answer that is not a repository", async () => {
  const { lifecycle, reads } = harness();
  lifecycle.show(PATH);
  reads[0].resolve({ path: PATH, enabled: true });
  await settle();
  assert.equal(
    lifecycle.snapshot.error.message,
    "Caffold returned an invalid language server answer.",
  );
});

test("reads the repository once while closed, so the section is ready when shown", async () => {
  const { lifecycle, reads, timers } = harness();

  lifecycle.preload(PATH);
  assert.equal(lifecycle.phase, "preloading");
  assert.deepEqual(reads.map(({ path }) => path), [PATH]);
  reads[0].resolve(repository("starting"));
  await settle();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(lifecycle.snapshot.fresh, true);
  assert.equal(lifecycle.snapshot.repository.servers[0].state, "starting");
  assert.equal(timers.size, 0, "nothing is read again while closed");

  lifecycle.preload(PATH);
  assert.equal(reads.length, 1, "an answer already there is not read again");

  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");
  assert.equal(lifecycle.snapshot.fresh, true, "the button is usable as it opens");
  assert.equal(reads.length, 2);
});

test("opening while the closed read runs reads again, and closing drops that read", async () => {
  const { lifecycle, reads } = harness();

  lifecycle.preload(PATH);
  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");
  assert.equal(reads.length, 2);
  reads[0].resolve(repository("off"));
  reads[1].resolve(repository("ready"));
  await settle();
  assert.equal(lifecycle.phase, "idle");
  assert.equal(lifecycle.snapshot.repository.servers[0].state, "ready");

  lifecycle.hide();
  lifecycle.preload("other");
  assert.equal(lifecycle.phase, "preloading");
  assert.equal(lifecycle.snapshot.repository, null, "another repository starts empty");
  lifecycle.hide();
  assert.equal(lifecycle.phase, "preloading", "closing the popover leaves it");
  lifecycle.preload("other");
  assert.equal(reads.length, 3, "the read already under way is kept");
  lifecycle.preload("third");
  assert.equal(reads.length, 4, "another repository replaces it");
  lifecycle.stop();
  assert.equal(lifecycle.phase, "closed");
  reads[2].resolve(repository("ready", { path: "other" }));
  reads[3].resolve(repository("ready", { path: "third" }));
  await settle();
  assert.equal(lifecycle.snapshot.repository, null, "a dropped read changes nothing");
});

test("stopping drops a shown read and its timer", async () => {
  const { lifecycle, reads, timers } = harness();

  lifecycle.show(PATH);
  reads[0].resolve(repository("starting"));
  await settle();
  assert.equal(lifecycle.phase, "waiting");
  assert.equal(timers.size, 1);
  lifecycle.stop();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(timers.size, 0);
});

test("a closed read that fails shows nothing, and opening reads again", async () => {
  const { lifecycle, reads } = harness();

  lifecycle.preload(PATH);
  reads[0].reject(new Error("offline"));
  await settle();
  assert.equal(lifecycle.phase, "closed");
  assert.equal(lifecycle.snapshot.repository, null);
  assert.equal(lifecycle.snapshot.error, null);

  lifecycle.preload(PATH);
  assert.equal(reads.length, 2, "an unanswered repository is read again");
  lifecycle.hide();
  lifecycle.show(PATH);
  assert.equal(lifecycle.phase, "reading");
});
