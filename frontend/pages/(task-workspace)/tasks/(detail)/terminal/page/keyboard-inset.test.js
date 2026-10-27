import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { watchKeyboardInset } from "./keyboard-inset.js";

const originalGlobals = {
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
});

test("the covered height follows the keyboard, a panned page, and a zoom", () => {
  const { viewport, runFrames } = installViewport({ height: 800 });
  const element = { getBoundingClientRect: () => ({ bottom: 800 }) };
  const seen = [];
  watchKeyboardInset(element, (covered) => seen.push(covered));

  // The keyboard takes the bottom 300 pixels.
  viewport.change({ height: 500 });
  runFrames();
  // The browser pans the page up by 100 pixels to show an input.
  viewport.change({ offsetTop: 100 }, "scroll");
  runFrames();
  // A pinch zoom shrinks the visible area without any keyboard.
  viewport.change({ offsetTop: 0, scale: 2 });
  runFrames();
  // The keyboard closes.
  viewport.change({ height: 800, scale: 1 });
  runFrames();

  assert.deepEqual(seen, [0, 300, 200, 0]);
});

test("changes within one frame are measured once, and none after the watch stops", () => {
  const { viewport, runFrames } = installViewport({ height: 800 });
  const element = { getBoundingClientRect: () => ({ bottom: 800 }) };
  const seen = [];
  const stop = watchKeyboardInset(element, (covered) => seen.push(covered));

  viewport.change({ height: 600 });
  viewport.change({ height: 450 });
  runFrames();
  stop();
  viewport.change({ height: 800 });
  runFrames();

  assert.deepEqual(seen, [0, 350]);
});

test("without a visual viewport nothing counts as covered", () => {
  globalThis.window = {};
  const seen = [];

  watchKeyboardInset({ getBoundingClientRect: () => ({ bottom: 800 }) }, (covered) => {
    seen.push(covered);
  });

  assert.deepEqual(seen, [0]);
});

function installViewport(initial) {
  const viewport = Object.assign(new EventTarget(), {
    offsetTop: 0,
    scale: 1,
    ...initial,
    change(values, type = "resize") {
      Object.assign(this, values);
      this.dispatchEvent(new Event(type));
    },
  });
  let frames = [];
  globalThis.window = { visualViewport: viewport };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  globalThis.cancelAnimationFrame = () => {};
  return {
    viewport,
    runFrames() {
      const due = frames;
      frames = [];
      for (const callback of due) {
        callback();
      }
    },
  };
}
