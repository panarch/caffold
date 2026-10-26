import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./suggested-prompts.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const suggestedPrompts = registry
  .element("caffold-task-assistant-message-suggested-prompts")
  .prototype;
after(() => registry.restore());

const COMPARE = { label: "Compare vendors", prompt: "Compare the two vendors." };
const TRACE = { label: "Trace a payment", prompt: "Explain the card approval flow." };

function host(properties = {}) {
  const owner = Object.create(suggestedPrompts, {
    ...Object.getOwnPropertyDescriptors({
      isConnected: true,
      hidden: false,
      threadId: "",
      prompts: [],
      disabled: false,
      offered: [],
      buttons: [],
      events: [],
      dispatchEvent(event) {
        this.events.push(event);
        return true;
      },
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
  owner.hints = new ActionHints(owner, () => {});
  return owner;
}

function offer(owner, prompts) {
  owner.prompts = prompts;
  owner.willUpdate(new Map([["prompts", undefined]]));
}

test("draws one button per request in the order the agent wrote them", () => {
  const owner = host({ threadId: "thread-a" });

  offer(owner, [COMPARE, TRACE]);
  const html = templateHtml(owner.render());

  assert.deepEqual(
    [...html.matchAll(/data-suggested-prompt="(\d)"/g)].map(([, index]) => index),
    ["0", "1"],
  );
  assert.deepEqual(
    [...html.matchAll(/class="task-suggested-prompt-label"\s*>([^<]*)</g)].map(
      ([, label]) => label,
    ),
    ["Compare vendors", "Trace a payment"],
  );
  // The icon set has not loaded here, so the slot holds the stand-in the
  // other icons use until it does.
  assert.match(
    html,
    /<span class="task-suggested-prompt-icon"><span class="sr-only"><\/span><\/span>/,
  );
});

test("keeps its buttons when only whether they can be chosen changes", () => {
  const owner = host();
  offer(owner, [COMPARE, TRACE]);
  const drawn = owner.offered;

  offer(owner, [{ ...COMPARE }, { ...TRACE }]);
  assert.equal(owner.offered, drawn, "the same requests again keep their buttons");
  owner.disabled = true;
  assert.equal(
    [...templateHtml(owner.render()).matchAll(/\?disabled="true"/g)].length,
    2,
  );
  offer(owner, [TRACE]);
  assert.notEqual(owner.offered, drawn, "different requests get new buttons");
});

test("hides when there is nothing to offer and drops requests without words", () => {
  const owner = host();

  offer(owner, [
    { label: "", prompt: "No name" },
    { label: "No request", prompt: " " },
    null,
  ]);
  owner.updated();

  assert.deepEqual(owner.offered, []);
  assert.equal(owner.hidden, true);
});

test("asks for the chosen request to be sent to the Composer", () => {
  const owner = host({ threadId: "thread-a" });
  offer(owner, [COMPARE, TRACE]);

  owner.choose(1);
  owner.disabled = true;
  owner.choose(0);

  assert.equal(owner.events.length, 1);
  const [intent] = owner.events;
  assert.equal(intent.type, "caffold:task-suggested-prompt-intent");
  assert.equal(intent.bubbles, true);
  assert.deepEqual(intent.detail, {
    threadId: "thread-a",
    prompt: TRACE.prompt,
  });
});
