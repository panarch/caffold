import assert from "node:assert/strict";
import test from "node:test";

import { InFlightLimit } from "./in-flight-limit.ts";

function observeRounds(limit, waitMs, rounds) {
  for (let count = 0; count < rounds; count += 1) {
    limit.observe({ round: limit.round, waitMs });
  }
}

test("starts with one cell in flight", () => {
  const limit = new InFlightLimit();

  assert.equal(limit.allowedCells(), 1);
  assert.equal(limit.round, 0);
  assert.equal(limit.usualWaitMs, Infinity);
});

test("grows once a round while cells wait no longer than usual", () => {
  const near = new InFlightLimit();
  observeRounds(near, 20, 1);
  assert.equal(near.allowedCells(), 2, "a short round trip doubles at most");

  const far = new InFlightLimit();
  far.observe({ round: 0, waitMs: 350 });
  assert.equal(far.allowedCells(), 1, "1.71 cells is still one whole cell");
  far.observe({ round: 1, waitMs: 350 });
  assert.equal(far.allowedCells(), 2, "the fraction adds up");

  observeRounds(near, 20, 20);
  assert.equal(near.allowedCells(), 128, "never more than 128 cells");
});

test("shrinks while cells wait in line, at most by half a round", () => {
  const limit = new InFlightLimit();
  observeRounds(limit, 100, 3);
  assert.equal(limit.allowedCells(), 8);

  limit.observe({ round: limit.round, waitMs: 2_000 });
  assert.equal(limit.allowedCells(), 4);

  observeRounds(limit, 2_000, 10);
  assert.equal(limit.allowedCells(), 1, "never fewer than one cell");
});

test("only a cell asked for since the last change changes the count", () => {
  const limit = new InFlightLimit();
  limit.observe({ round: 0, waitMs: 100 });
  const cells = limit.cells;

  limit.observe({ round: 0, waitMs: 5_000 });
  assert.equal(limit.cells, cells, "an earlier round's cell");
  assert.equal(limit.round, 1);

  limit.observe({ round: 0, waitMs: 40 });
  assert.equal(limit.usualWaitMs, 40, "it still teaches the usual wait");
  assert.equal(limit.cells, cells);
});

test("a cell from the browser's cache changes nothing", () => {
  const limit = new InFlightLimit();
  limit.observe({ round: 0, waitMs: 350 });
  const before = { cells: limit.cells, round: limit.round, usual: limit.usualWaitMs };

  limit.observe({ round: limit.round, waitMs: 1, fromCache: true });

  assert.deepEqual(
    { cells: limit.cells, round: limit.round, usual: limit.usualWaitMs },
    before,
  );
});

test("resets to the start", () => {
  const limit = new InFlightLimit();
  observeRounds(limit, 50, 5);

  limit.reset();

  assert.equal(limit.allowedCells(), 1);
  assert.equal(limit.round, 0);
  assert.equal(limit.usualWaitMs, Infinity);
});
