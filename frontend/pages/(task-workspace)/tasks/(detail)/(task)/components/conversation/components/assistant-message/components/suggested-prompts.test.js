import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./suggested-prompts.js");
const suggestedPrompts = registry
  .element("caffold-task-assistant-message-suggested-prompts")
  .prototype;
after(() => registry.restore());

const COMPARE = { label: "Compare vendors", prompt: "Compare the two vendors." };
const TRACE = { label: "Trace a payment", prompt: "Explain the card approval flow." };

function control(index, label, { disabled = false } = {}) {
  return {
    type: "",
    className: "",
    dataset: { suggestedPrompt: `${index}` },
    textContent: label,
    disabled,
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

function host(properties = {}) {
  const owner = Object.assign(Object.create(suggestedPrompts), {
    connected: true,
    isConnected: true,
    hidden: false,
    threadId: "",
    prompts: [],
    disabled: false,
    renderedPrompts: null,
    children: [],
    events: [],
    replaced: 0,
    replaceChildren(...children) {
      this.replaced += 1;
      this.children = children;
    },
    querySelectorAll(selector) {
      return selector.includes("icon")
        ? this.children.flatMap(({ children = [] }) =>
            children.filter(({ className }) => className === "task-suggested-prompt-icon")
          )
        : this.children;
    },
    contains(node) {
      return this.children.includes(node);
    },
    dispatchEvent(event) {
      this.events.push(event);
      return true;
    },
    ...properties,
  });
  return owner;
}

function element() {
  return {
    ...control(0, ""),
    children: [],
    innerHTML: "",
    append(...children) {
      this.children.push(...children);
    },
  };
}

function withCreatedElements(run) {
  const previous = globalThis.document.createElement;
  globalThis.document.createElement = element;
  try {
    return run();
  } finally {
    globalThis.document.createElement = previous;
  }
}

test("draws one button per request in the order the agent wrote them", () => {
  const owner = host();

  withCreatedElements(() =>
    owner.setSnapshot({ threadId: "thread-a", prompts: [COMPARE, TRACE] }),
  );

  assert.equal(owner.hidden, false);
  assert.deepEqual(
    owner.children.map(({ type, className, dataset, children }) => [
      type,
      className,
      dataset.suggestedPrompt,
      children.map(({ className: slot, textContent }) => [slot, textContent]),
    ]),
    [
      ["button", "task-suggested-prompt", "0", [
        ["task-suggested-prompt-icon", ""],
        ["task-suggested-prompt-label", "Compare vendors"],
      ]],
      ["button", "task-suggested-prompt", "1", [
        ["task-suggested-prompt-icon", ""],
        ["task-suggested-prompt-label", "Trace a payment"],
      ]],
    ],
  );
  // The icon set has not loaded here, so the slot holds the stand-in the
  // other icons use until it does.
  const [icon] = owner.children[0].children;
  assert.match(icon.innerHTML, /sr-only/);
});

test("keeps its buttons when only whether they can be chosen changes", () => {
  const owner = host();
  withCreatedElements(() =>
    owner.setSnapshot({ threadId: "thread-a", prompts: [COMPARE, TRACE] }),
  );
  const drawn = owner.children;

  assert.equal(
    owner.setSnapshot({
      threadId: "thread-a",
      prompts: [{ ...COMPARE }, { ...TRACE }],
    }),
    false,
    "the same requests again change nothing",
  );
  owner.setSnapshot({
    threadId: "thread-a",
    prompts: [COMPARE, TRACE],
    disabled: true,
  });

  assert.equal(owner.replaced, 1);
  assert.equal(owner.children, drawn);
  assert.deepEqual(owner.children.map(({ disabled }) => disabled), [true, true]);
});

test("hides when there is nothing to offer and drops requests without words", () => {
  const owner = host();

  withCreatedElements(() =>
    owner.setSnapshot({
      threadId: "thread-a",
      prompts: [
        { label: "", prompt: "No name" },
        { label: "No request", prompt: " " },
        null,
      ],
    }),
  );

  assert.deepEqual(owner.prompts, []);
  assert.equal(owner.hidden, true);
  assert.deepEqual(owner.children, []);
});

test("asks for the chosen request to be sent to the Composer", () => {
  const first = control(0, COMPARE.label);
  const second = control(1, TRACE.label);
  const owner = host({
    threadId: "thread-a",
    prompts: [COMPARE, TRACE],
    children: [first, second],
  });
  const click = (target) =>
    owner.handleClick({ target: { closest: () => target } });

  click(second);
  click({ ...first, disabled: false });
  second.disabled = true;
  click(second);

  assert.equal(owner.events.length, 1);
  const [intent] = owner.events;
  assert.equal(intent.type, "caffold:task-suggested-prompt-intent");
  assert.equal(intent.bubbles, true);
  assert.deepEqual(intent.detail, {
    threadId: "thread-a",
    prompt: TRACE.prompt,
  });
});

test("offers each choosable request as a keyboard action", () => {
  const first = control(0, COMPARE.label);
  const second = control(1, TRACE.label, { disabled: true });
  const owner = host({ children: [first, second] });
  const message = { id: "message" };

  const scope = owner.actionHintScope({
    scopeId: "message:a:suggested-prompts",
    clipRoots: [message],
  });

  assert.deepEqual(scope.targets.map(({ id, label }) => [id, label]), [
    ["message:a:suggested-prompts:prompt:1", "Compare vendors"],
  ]);
  assert.deepEqual(scope.mutationRoots, [owner]);
  const [target] = scope.targets;
  assert.deepEqual(target.clipRoots, [owner, message]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(first.clicks, 1);

  first.disabled = true;
  assert.equal(target.isActionable(), false);
  owner.hidden = true;
  assert.deepEqual(
    owner.actionHintScope({ scopeId: "message:a:suggested-prompts" }).targets,
    [],
  );
});
