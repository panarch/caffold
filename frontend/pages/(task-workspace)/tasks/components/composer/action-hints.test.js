import assert from "node:assert/strict";
import test from "node:test";

import { collectComposerActionHintTargets } from "./action-hints.js";

test("collects Model, Permission, and Prompt targets for named create and follow-up scopes", () => {
  const model = { id: "model" };
  const permission = { id: "permission" };
  const prompt = { id: "prompt" };
  for (const mode of ["create", "follow-up"]) {
    assert.deepEqual(
      collectComposerActionHintTargets({
        mode,
        scopeId: mode === "create" ? "new" : "task:a",
        modelTarget: () => model,
        permissionTarget: () => permission,
        promptTarget: () => prompt,
      }),
      [model, permission, prompt],
    );
  }
});

test("does not ask unsupported or unnamed composers for Action Hint targets", () => {
  let providerCalls = 0;
  const options = {
    modelTarget: () => {
      providerCalls += 1;
      return { id: "model" };
    },
    permissionTarget: () => {
      providerCalls += 1;
      return { id: "permission" };
    },
    promptTarget: () => {
      providerCalls += 1;
      return { id: "prompt" };
    },
  };
  assert.deepEqual(
    collectComposerActionHintTargets({
      ...options,
      mode: "review",
      scopeId: "task:a",
    }),
    [],
  );
  assert.deepEqual(
    collectComposerActionHintTargets({
      ...options,
      mode: "create",
      scopeId: "",
    }),
    [],
  );
  assert.equal(providerCalls, 0);
});
