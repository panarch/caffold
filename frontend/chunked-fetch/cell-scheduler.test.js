import assert from "node:assert/strict";
import test from "node:test";

import { CellScheduler } from "./cell-scheduler.js";
import { CELL_BYTES } from "./transfer.js";

const ORIGIN = "https://caffold.test";

function bytes(length, seed = 0) {
  return Uint8Array.from({ length }, (_, index) => (index + seed) % 251);
}

// A server that answers ranges of its files the way the viewer routes do, and
// records every request. A file's version can be swapped to stand for a change
// on disk.
function fakeServer(files) {
  const requests = [];
  const fetch = async (url, init) => {
    const address = new URL(url);
    const path = address.searchParams.get("path");
    const asked = address.searchParams.get("version");
    const range = init.headers.Range;
    requests.push({ path, version: asked, range, signal: init.signal });
    const file = files[path];
    if (asked !== null && asked !== file.version) {
      return new Response(null, { status: 412 });
    }
    const named = file.version ? { ETag: `"${file.version}"` } : {};
    if (file.whole) {
      return new Response(file.bytes, {
        headers: { "Content-Type": file.type, ...named },
      });
    }
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (Number(first) >= file.bytes.length) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${file.bytes.length}`, ...named },
      });
    }
    const end = Math.min(Number(last), file.bytes.length - 1);
    return new Response(file.bytes.slice(Number(first), end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${first}-${end}/${file.bytes.length}`,
        "Content-Type": file.type,
        ETag: `"${file.version}"`,
      },
    });
  };
  return { fetch, requests };
}

// Every cell waits a full second for its first byte, so the limit grows
// slowly and stays at one cell for the first few.
function slowClock() {
  let time = 0;
  return () => {
    time += 1_000;
    return time;
  };
}

function address(path) {
  return `${ORIGIN}/api/image?${new URLSearchParams({ path })}`;
}

async function contents(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test("fetches a file in 64 KB cells cut at the same places and puts it together", async () => {
  const file = bytes(CELL_BYTES * 3 + 8_192, 3);
  const server = fakeServer({ "a.png": { bytes: file, version: "v1", type: "image/png" } });
  const scheduler = new CellScheduler({ fetch: server.fetch, now: slowClock() });

  const { file: blob, version } = await scheduler.fetchFile(address("a.png"));

  assert.equal(blob.type, "image/png");
  assert.deepEqual(await contents(blob), file);
  assert.equal(version, "v1");
  assert.deepEqual(
    server.requests.map(({ version, range }) => [version, range]),
    [
      [null, `bytes=0-${CELL_BYTES - 1}`],
      ["v1", `bytes=${CELL_BYTES}-${CELL_BYTES * 2 - 1}`],
      ["v1", `bytes=${CELL_BYTES * 2}-${CELL_BYTES * 3 - 1}`],
      ["v1", `bytes=${CELL_BYTES * 3}-${CELL_BYTES * 3 + 8_191}`],
    ],
  );
});

test("takes a file sent whole, and an empty one, with the version each names", async () => {
  const server = fakeServer({
    "whole.png": { bytes: bytes(300), version: "w1", type: "image/png", whole: true },
    "unnamed.png": { bytes: bytes(3), type: "image/png", whole: true },
    "empty.png": { bytes: new Uint8Array(0), version: "v1", type: "image/png" },
  });
  const scheduler = new CellScheduler({ fetch: server.fetch, now: slowClock() });

  const whole = await scheduler.fetchFile(address("whole.png"));
  const unnamed = await scheduler.fetchFile(address("unnamed.png"));
  const empty = await scheduler.fetchFile(address("empty.png"));

  assert.deepEqual(await contents(whole.file), bytes(300));
  assert.equal(whole.file.type, "image/png");
  assert.equal(whole.version, "w1");
  assert.equal(unnamed.version, null);
  assert.equal(empty.file.size, 0);
  assert.equal(empty.version, "v1");
});

test("fetches the file asked for most recently first, then goes back to the earlier one", async () => {
  const server = fakeServer({
    "early.png": { bytes: bytes(CELL_BYTES * 3, 1), version: "e1", type: "image/png" },
    "late.png": { bytes: bytes(CELL_BYTES * 2, 2), version: "l1", type: "image/png" },
  });
  const scheduler = new CellScheduler({ fetch: server.fetch, now: slowClock() });

  const early = scheduler.fetchFile(address("early.png"));
  const late = scheduler.fetchFile(address("late.png"));
  await Promise.all([early, late]);

  assert.deepEqual(
    server.requests.map(({ path, range }) => `${path} ${range.split("-")[0]}`),
    [
      "early.png bytes=0",
      "late.png bytes=0",
      `late.png bytes=${CELL_BYTES}`,
      `early.png bytes=${CELL_BYTES}`,
      `early.png bytes=${CELL_BYTES * 2}`,
    ],
  );
  assert.deepEqual(await contents((await early).file), bytes(CELL_BYTES * 3, 1));
  assert.deepEqual(await contents((await late).file), bytes(CELL_BYTES * 2, 2));
});

test("shares one fetch of the same address and stops it only when every caller lets go", async () => {
  const file = bytes(CELL_BYTES * 2);
  const server = fakeServer({ "a.png": { bytes: file, version: "v1", type: "image/png" } });
  const scheduler = new CellScheduler({ fetch: server.fetch, now: slowClock() });
  const first = new AbortController();

  const leaving = scheduler.fetchFile(address("a.png"), { signal: first.signal });
  const staying = scheduler.fetchFile(address("a.png"));
  first.abort();

  await assert.rejects(leaving, { name: "AbortError" });
  assert.deepEqual(await contents((await staying).file), file);
  assert.equal(server.requests.length, 2, "one fetch of two cells");

  const bothLeave = new CellScheduler({ fetch: server.fetch, now: slowClock() });
  const one = new AbortController();
  const two = new AbortController();
  server.requests.length = 0;
  const firstCaller = bothLeave.fetchFile(address("a.png"), { signal: one.signal });
  const secondCaller = bothLeave.fetchFile(address("a.png"), { signal: two.signal });
  one.abort();
  two.abort();

  await assert.rejects(firstCaller, { name: "AbortError" });
  await assert.rejects(secondCaller, { name: "AbortError" });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].signal.aborted, true, "the cell in flight stops");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.requests.length, 1, "no later cell is asked for");
});

test("rejects a signal that was already aborted without asking for anything", async () => {
  const server = fakeServer({ "a.png": { bytes: bytes(10), version: "v1", type: "image/png" } });
  const scheduler = new CellScheduler({ fetch: server.fetch, now: slowClock() });

  await assert.rejects(
    scheduler.fetchFile(address("a.png"), { signal: AbortSignal.abort() }),
    { name: "AbortError" },
  );
  assert.equal(server.requests.length, 0);
});

test("fetches a file again from its first cell when it changes on the way", async () => {
  const before = bytes(CELL_BYTES * 2, 1);
  const after = bytes(CELL_BYTES * 2 + 5, 9);
  const files = { "a.png": { bytes: before, version: "v1", type: "image/png" } };
  const server = fakeServer(files);
  const fetch = async (url, init) => {
    const response = await server.fetch(url, init);
    if (server.requests.length === 1) {
      files["a.png"] = { bytes: after, version: "v2", type: "image/png" };
    }
    return response;
  };
  const scheduler = new CellScheduler({ fetch, now: slowClock() });

  const changed = await scheduler.fetchFile(address("a.png"));

  assert.deepEqual(await contents(changed.file), after);
  assert.equal(changed.version, "v2");
  assert.deepEqual(
    server.requests.map(({ version, range }) => `${version} ${range.split("-")[0]}`),
    ["null bytes=0", `v1 bytes=${CELL_BYTES}`, "null bytes=0", `v2 bytes=${CELL_BYTES}`, `v2 bytes=${CELL_BYTES * 2}`],
  );
});

test("does not count a cell the browser kept as news about the link, and starts over when idle", async () => {
  const server = fakeServer({ "a.png": { bytes: bytes(CELL_BYTES * 3), version: "v1", type: "image/png" } });
  // The first cell crosses the link in 300 ms; the rest come back at once.
  const waits = [300, 2, 2];
  let time = 0;
  let calls = 0;
  const now = () => {
    const step = calls % 2 === 1 ? waits[(calls - 1) / 2] : 0;
    calls += 1;
    time += step;
    return time;
  };
  const scheduler = new CellScheduler({ fetch: server.fetch, now });
  const observed = [];
  const observe = scheduler.limit.observe.bind(scheduler.limit);
  scheduler.limit.observe = (observation) => {
    observed.push(observation);
    observe(observation);
  };

  await scheduler.fetchFile(address("a.png"));

  assert.deepEqual(
    observed.map(({ waitMs, fromCache }) => [waitMs, fromCache]),
    [[300, false], [2, true], [2, true]],
  );
  assert.equal(scheduler.limit.allowedCells(), 1);
  assert.equal(scheduler.limit.usualWaitMs, Infinity, "nothing in flight resets the limit");
});
