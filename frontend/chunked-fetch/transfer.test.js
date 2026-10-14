import assert from "node:assert/strict";
import test from "node:test";

import {
  CELL_BYTES,
  TRANSFER_EVENT,
  TRANSFER_NODE,
  Transfer,
} from "./transfer.js";

const URL_ASKED = "https://caffold.test/api/image?path=photo.png";

function bytes(length, seed = 0) {
  return Uint8Array.from({ length }, (_, index) => (index + seed) % 251);
}

function partAnswer(file, cell, { version = "v1", type = "image/png" } = {}) {
  const first = cell.index * CELL_BYTES;
  const last = Math.min(first + CELL_BYTES, file.length) - 1;
  return {
    kind: "part",
    first,
    size: file.length,
    version,
    type,
    bytes: file.slice(first, last + 1).buffer,
  };
}

async function contents(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

test("asks for the first cell at the address asked for, then the rest under its version", () => {
  const file = bytes(CELL_BYTES * 2 + 100);
  const transfer = new Transfer(URL_ASKED);

  const first = transfer.takeCell(0);
  assert.equal(first.url, URL_ASKED);
  assert.equal(first.range, `bytes=0-${CELL_BYTES - 1}`);
  assert.equal(transfer.takeCell(0), null, "only the first cell while opening");

  assert.equal(transfer.answer(first, partAnswer(file, first)), true);
  assert.equal(transfer.node, TRANSFER_NODE.RECEIVING);

  const second = transfer.takeCell(3);
  const third = transfer.takeCell(3);
  assert.equal(second.url, `${URL_ASKED}&version=v1&cell=1`);
  assert.equal(third.url, `${URL_ASKED}&version=v1&cell=2`, "each cell has an address of its own");
  assert.equal(second.range, `bytes=${CELL_BYTES}-${CELL_BYTES * 2 - 1}`);
  assert.equal(second.round, 3);
  assert.equal(third.range, `bytes=${CELL_BYTES * 2}-${CELL_BYTES * 2 + 99}`);
  assert.equal(transfer.takeCell(3), null, "each cell once");
});

test("puts the cells together in order, whatever order they arrive in", async () => {
  const file = bytes(CELL_BYTES * 2 + 100, 7);
  const transfer = new Transfer(URL_ASKED);
  const first = transfer.takeCell(0);
  transfer.answer(first, partAnswer(file, first));
  const second = transfer.takeCell(0);
  const third = transfer.takeCell(0);

  assert.equal(transfer.answer(third, partAnswer(file, third)), true);
  assert.equal(transfer.node, TRANSFER_NODE.RECEIVING);
  assert.equal(transfer.answer(second, partAnswer(file, second)), true);

  assert.equal(transfer.node, TRANSFER_NODE.FINISHED);
  const blob = await transfer.done;
  assert.equal(blob.type, "image/png");
  assert.deepEqual(await contents(blob), file);
});

test("finishes on a first cell that holds the whole file", async () => {
  const file = bytes(10);
  const transfer = new Transfer(URL_ASKED);
  const first = transfer.takeCell(0);

  transfer.answer(first, partAnswer(file, first));

  assert.equal(transfer.node, TRANSFER_NODE.FINISHED);
  assert.deepEqual(await contents(await transfer.done), file);
});

test("finishes on a whole file or an empty one", async () => {
  const whole = new Transfer(URL_ASKED);
  const wholeCell = whole.takeCell(0);
  whole.answer(wholeCell, { kind: "whole", type: "image/gif", bytes: bytes(5).buffer });
  assert.equal(whole.node, TRANSFER_NODE.FINISHED);
  const wholeBlob = await whole.done;
  assert.equal(wholeBlob.type, "image/gif");
  assert.deepEqual(await contents(wholeBlob), bytes(5));

  const empty = new Transfer(URL_ASKED);
  const emptyCell = empty.takeCell(0);
  empty.answer(emptyCell, { kind: "out-of-range", size: 0, type: "" });
  assert.equal(empty.node, TRANSFER_NODE.FINISHED);
  assert.equal((await empty.done).size, 0);
});

test("fails while opening on an error or an answer that cannot start the file", async () => {
  for (const answer of [
    { kind: "failed", status: 404 },
    { kind: "out-of-range", size: 10 },
    { kind: "changed" },
    { kind: "part", first: 0, size: 10, version: "", type: "", bytes: new ArrayBuffer(10) },
    { kind: "part", first: 5, size: 10, version: "v1", type: "", bytes: new ArrayBuffer(5) },
  ]) {
    const transfer = new Transfer(URL_ASKED);
    const cell = transfer.takeCell(0);

    transfer.answer(cell, answer);

    assert.equal(transfer.node, TRANSFER_NODE.FAILED, JSON.stringify(answer));
    await assert.rejects(transfer.done);
  }
});

test("fails while receiving on an error or a cell from another file", async () => {
  const file = bytes(CELL_BYTES * 3);
  for (const answer of [
    { kind: "failed", status: 500 },
    { kind: "whole", type: "", bytes: file.buffer },
    { ...partAnswer(file, { index: 1 }), size: CELL_BYTES * 4 },
    { ...partAnswer(file, { index: 2 }) },
  ]) {
    const transfer = new Transfer(URL_ASKED);
    const first = transfer.takeCell(0);
    transfer.answer(first, partAnswer(file, first));
    const second = transfer.takeCell(0);

    transfer.answer(second, answer);

    assert.equal(transfer.node, TRANSFER_NODE.FAILED, JSON.stringify(answer.kind));
    await assert.rejects(transfer.done, /failed/);
  }
});

test("starts again from the first cell when the file changes, twice at most", async () => {
  const before = bytes(CELL_BYTES * 3, 1);
  const after = bytes(CELL_BYTES * 2, 2);
  const transfer = new Transfer(URL_ASKED);
  const firstTry = transfer.takeCell(0);
  transfer.answer(firstTry, partAnswer(before, firstTry));
  const stale = transfer.takeCell(0);
  const inFlight = transfer.takeCell(0);

  assert.equal(transfer.answer(stale, { kind: "changed" }), true);
  assert.equal(transfer.node, TRANSFER_NODE.OPENING);
  assert.equal(transfer.generation, 1);
  assert.equal(inFlight.controller.signal.aborted, true, "cells of the old version stop");
  assert.equal(transfer.answer(inFlight, partAnswer(before, inFlight)), false);

  const again = transfer.takeCell(0);
  assert.equal(again.index, 0);
  assert.equal(again.url, URL_ASKED);
  transfer.answer(again, partAnswer(after, again, { version: "v2" }));
  const rest = transfer.takeCell(0);
  assert.equal(rest.url, `${URL_ASKED}&version=v2&cell=1`);
  transfer.answer(rest, partAnswer(after, rest, { version: "v2" }));
  assert.deepEqual(await contents(await transfer.done), after);

  const restless = new Transfer(URL_ASKED);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const opening = restless.takeCell(0);
    restless.answer(opening, partAnswer(before, opening));
    restless.answer(restless.takeCell(0), { kind: "changed" });
  }
  assert.equal(restless.node, TRANSFER_NODE.FAILED, "the third change gives up");
  await assert.rejects(restless.done);
});

test("cancels while opening or receiving and stops the cells in flight", async () => {
  const file = bytes(CELL_BYTES * 3);

  const opening = new Transfer(URL_ASKED);
  const openingCell = opening.takeCell(0);
  assert.equal(opening.cancel(), true);
  assert.equal(opening.node, TRANSFER_NODE.CANCELED);
  assert.equal(openingCell.controller.signal.aborted, true);
  await assert.rejects(opening.done, { name: "AbortError" });

  const receiving = new Transfer(URL_ASKED);
  const first = receiving.takeCell(0);
  receiving.answer(first, partAnswer(file, first));
  const second = receiving.takeCell(0);
  assert.equal(receiving.cancel(), true);
  assert.equal(receiving.node, TRANSFER_NODE.CANCELED);
  assert.equal(second.controller.signal.aborted, true);
  assert.equal(receiving.takeCell(0), null);
  await assert.rejects(receiving.done, { name: "AbortError" });
});

test("ignores answers and events once the file has ended", async () => {
  const file = bytes(10);
  const transfer = new Transfer(URL_ASKED);
  const cell = transfer.takeCell(0);
  transfer.answer(cell, partAnswer(file, cell));

  assert.equal(transfer.answer(cell, { kind: "failed", status: 500 }), false);
  assert.equal(transfer.cancel(), false);
  assert.equal(transfer.dispatch(TRANSFER_EVENT.PART), false);
  assert.equal(transfer.node, TRANSFER_NODE.FINISHED);
  assert.deepEqual(await contents(await transfer.done), file);
});

test("rejects an event the current node does not accept", () => {
  const transfer = new Transfer(URL_ASKED);

  assert.equal(transfer.dispatch(TRANSFER_EVENT.PART), false);
  assert.equal(transfer.dispatch(TRANSFER_EVENT.CHANGED), false);
  assert.equal(transfer.node, TRANSFER_NODE.OPENING);
});

test("tells a cell the browser kept from one that crossed the link", () => {
  const file = bytes(CELL_BYTES * 3);
  const transfer = new Transfer(URL_ASKED);
  const first = transfer.takeCell(0);

  assert.equal(transfer.recordWait(first, 300), false, "the first cell always crosses");
  transfer.answer(first, partAnswer(file, first));
  const second = transfer.takeCell(0);
  const third = transfer.takeCell(0);

  assert.equal(transfer.recordWait(second, 3), true);
  assert.equal(transfer.recordWait(third, 320), false);
  assert.equal(
    transfer.recordWait({ ...second, generation: -1 }, 3),
    false,
    "a cell of an earlier attempt",
  );
});
