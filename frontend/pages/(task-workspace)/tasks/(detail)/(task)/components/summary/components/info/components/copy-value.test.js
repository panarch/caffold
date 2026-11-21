import assert from "node:assert/strict";
import test, { after, mock } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./copy-value.js");
const copyValue = registry
  .element("caffold-task-detail-info-copy-value")
  .prototype;
after(() => registry.restore());

function copyValueHost(properties = {}) {
  return Object.create(copyValue, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      generation: 0,
      feedbackTimer: undefined,
      copyState: "idle",
      value: "62f05222-da19-4b65-ae32-fe14543574b7",
      label: "Thread ID",
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

// Runs `body` with a clipboard that answers as `writeText` does and timers the
// test moves by hand.
async function withClipboard(writeText, body) {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  const written = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          written.push(text);
          await writeText(text);
        },
      },
    },
  });
  mock.timers.enable({ apis: ["setTimeout"] });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout, clearTimeout },
  });
  try {
    await body(written);
  } finally {
    mock.timers.reset();
    if (navigator) {
      Object.defineProperty(globalThis, "navigator", navigator);
    } else {
      delete globalThis.navigator;
    }
    if (window) {
      Object.defineProperty(globalThis, "window", window);
    } else {
      delete globalThis.window;
    }
  }
}

test("copies its value, shows that it did for a moment, then rests", async () => {
  await withClipboard(async () => {}, async (written) => {
    const host = copyValueHost();
    await host.copy();
    assert.deepEqual(written, ["62f05222-da19-4b65-ae32-fe14543574b7"]);
    assert.equal(host.copyState, "copied");
    mock.timers.tick(1_800);
    assert.equal(host.copyState, "idle");
  });
});

test("shows that a copy failed for a moment, then rests", async () => {
  await withClipboard(
    async () => {
      throw new Error("denied");
    },
    async () => {
      const host = copyValueHost();
      await host.copy();
      assert.equal(host.copyState, "failed");
      mock.timers.tick(1_800);
      assert.equal(host.copyState, "idle");
    },
  );
});

test("retires a copy in flight when its value changes", () => {
  const host = copyValueHost({ copyState: "copying", clearFeedback() {} });
  const inFlight = host.generation;
  assert.equal(host.acceptsCompletion(inFlight), true);

  host.willUpdate(new Map([["value", "older value"]]));
  assert.equal(host.acceptsCompletion(inFlight), false);
  assert.equal(host.copyState, "idle");

  // A new label leaves the copy alone.
  const current = host.generation;
  host.willUpdate(new Map([["label", "Thread"]]));
  assert.equal(host.acceptsCompletion(current), true);
});

test("refuses a completion that outlived its element", () => {
  const host = copyValueHost({ generation: 3 });
  assert.equal(host.acceptsCompletion(3), true);
  host.isConnected = false;
  assert.equal(host.acceptsCompletion(3), false);
});
