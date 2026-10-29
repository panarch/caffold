import assert from "node:assert/strict";
import test from "node:test";
import { initialRecoveryState, reduceRecovery } from "./control.js";

const directory = {
  sectionId: "one",
  path: "old",
  directory: { status: "missing", message: null },
  browsePath: "",
  reconnectUnavailableReason: null
};

function editing() {
  const checking = reduceRecovery(initialRecoveryState(), { type: "activate" });
  return reduceRecovery(checking, {
    type: "checked",
    generation: checking.generation,
    directory
  });
}

test("only an explicitly chosen candidate can submit, and a failure preserves it", () => {
  let state = editing();
  assert.equal(reduceRecovery(state, { type: "submit" }), state);
  state = reduceRecovery(state, { type: "choose", path: "moved" });
  state = reduceRecovery(state, { type: "submit" });
  assert.equal(state.phase, "submitting");
  assert.equal(reduceRecovery(state, { type: "submit" }), state);
  assert.equal(reduceRecovery(state, { type: "choose", path: "other" }), state);
  state = reduceRecovery(state, {
    type: "failed",
    generation: state.generation,
    message: "Try again"
  });
  assert.equal(state.phase, "editing");
  assert.equal(state.candidate, "moved");
  assert.equal(state.error, "Try again");
});

test("deactivation rejects both old check and old mutation completions", () => {
  let state = reduceRecovery(editing(), { type: "choose", path: "moved" });
  state = reduceRecovery(state, { type: "submit" });
  const generation = state.generation;
  state = reduceRecovery(state, { type: "deactivate" });
  for (const event of [
    { type: "checked", generation, directory },
    { type: "reconnected", generation, directory },
    { type: "failed", generation, message: "Old failure" },
    { type: "choose", path: "old" },
    { type: "recheck" }
  ]) {
    assert.equal(reduceRecovery(state, event), state);
  }
  const current = reduceRecovery(state, { type: "activate" });
  assert.equal(
    reduceRecovery(current, { type: "checked", generation, directory }),
    current
  );
});

test("success requests a canonical check and an unavailable observation cannot submit", () => {
  let state = reduceRecovery(editing(), { type: "choose", path: "moved" });
  state = reduceRecovery(state, { type: "submit" });
  state = reduceRecovery(state, {
    type: "reconnected",
    generation: state.generation,
    directory
  });
  assert.equal(state.phase, "checking");
  state = reduceRecovery(state, {
    type: "checked",
    generation: state.generation,
    directory: {
      ...directory,
      directory: { status: "unavailable", message: "Permission denied" }
    }
  });
  assert.equal(reduceRecovery(state, { type: "submit" }), state);
  const checking = reduceRecovery(state, { type: "recheck" });
  assert.equal(reduceRecovery(checking, { type: "recheck" }), checking);
});

test("a failed check remains retryable and a restored original cannot submit", () => {
  let state = reduceRecovery(initialRecoveryState(), { type: "activate" });
  state = reduceRecovery(state, {
    type: "failed",
    generation: state.generation,
    message: "Offline"
  });
  assert.equal(state.phase, "editing");
  assert.equal(state.directory, null);
  assert.equal(state.error, "Offline");
  state = reduceRecovery(state, { type: "recheck" });
  state = reduceRecovery(state, {
    type: "checked",
    generation: state.generation,
    directory: {
      ...directory,
      directory: { status: "available", message: null }
    }
  });
  state = reduceRecovery(state, { type: "choose", path: "other" });
  assert.equal(state.error, "");
  assert.equal(reduceRecovery(state, { type: "submit" }), state);
});
