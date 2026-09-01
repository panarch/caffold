import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation.js");
const conversation = registry.element("caffold-task-conversation").prototype;
after(() => registry.restore());

test("provides only the exact active Conversation scrollport", () => {
  const scrollport = {
    clientHeight: 200,
    scrollHeight: 800,
    getClientRects: () => [{}],
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    snapshot: { threadId: "thread-a", task: { threadId: "thread-a" } },
    ensureState() {},
    getClientRects: () => [{}],
    scroller: () => scrollport,
  };

  const scope = conversation.scrollSurfaceScope.call(owner);
  const surface = scope.surfaces[0];
  assert.deepEqual(
    {
      id: surface.id,
      label: surface.label,
      scrollport: surface.scrollport,
      clipRoots: surface.clipRoots,
    },
    {
      id: "task:thread-a:conversation",
      label: "Conversation",
      scrollport,
      clipRoots: [owner, scrollport],
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner, scrollport]);
  assert.equal(surface.isEligible(), true);
  owner.active = false;
  assert.equal(surface.isEligible(), false);
  owner.active = true;
  owner.snapshot = { threadId: "thread-b", task: { threadId: "thread-b" } };
  assert.equal(surface.isEligible(), false);
});

test("returns an empty scope before a Conversation owns a Task scrollport", () => {
  const scope = conversation.scrollSurfaceScope.call({
    snapshot: { threadId: "", task: null },
    ensureState() {},
    scroller: () => null,
  });
  assert.deepEqual(scope.surfaces, []);
});
