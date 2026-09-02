import assert from "node:assert/strict";
import test from "node:test";

import {
  buttonActionHintTarget,
  captureLinkActionHintBinding,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  linkActionHintLabel,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
  radioActionHintTarget,
  rangeActionHintTarget,
  reorderHandleActionHintTarget,
  separatorActionHintTarget,
  selectActionHintTarget,
  switchActionHintTarget,
  textboxActionHintTarget,
} from "./action-hint-scope.js";

test("button Action Hint targets preserve owner state and native activation", () => {
  const calls = [];
  const control = {
    focus: (options) => calls.push(["focus", options]),
    click: () => calls.push(["click"]),
  };
  const clipRoots = [{ id: "clip" }];
  const isActionable = () => true;
  const input = {
    id: "workspace:mode:settings",
    actionId: "navigation.workspace.select",
    label: "Open Settings",
    control,
    clipRoots,
    isActionable,
  };
  const { activate, ...target } = buttonActionHintTarget(input);

  assert.deepEqual(target, {
    ...input,
    controlKind: "button",
    anchor: control,
  });

  activate();

  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["click"],
  ]);

  const anchor = { id: "visible-marker" };
  assert.equal(buttonActionHintTarget({ ...input, anchor }).anchor, anchor);
});

test("link Action Hint targets freeze native navigation and click the exact anchor", () => {
  const calls = [];
  const attributes = new Map([
    ["href", "https://example.com/first"],
    ["target", "_blank"],
    ["rel", "noopener noreferrer"],
  ]);
  const control = {
    getAttribute: (name) => attributes.get(name) ?? null,
    focus: (options) => calls.push(["focus", options]),
    click: () => calls.push(["click"]),
  };
  const ownerIsActionable = () => true;
  const target = linkActionHintTarget({
    id: "settings:remote-access:open",
    actionId: "link.open",
    label: "Open Tailnet URL in a new tab",
    control,
    clipRoots: [],
    isActionable: ownerIsActionable,
  });

  assert.equal(target.controlKind, "link");
  assert.equal(
    target.activationKey,
    JSON.stringify({
      href: "https://example.com/first",
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  );
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["click"],
  ]);

  for (
    const [name, value] of [
      ["href", "https://example.com/second"],
      ["target", "_self"],
      ["rel", "noreferrer"],
    ]
  ) {
    const original = attributes.get(name);
    attributes.set(name, value);
    assert.equal(target.isActionable(), false, name);
    attributes.set(name, original);
    assert.equal(target.isActionable(), true, name);
  }
});

test("link presentation derives an accessible name and native outcome", () => {
  const attributes = new Map([
    ["href", "/tasks/thread/review"],
    ["aria-label", "  Review   source  "],
  ]);
  const control = {
    innerText: "Visible text",
    textContent: "Fallback text",
    getAttribute: (name) => attributes.get(name) ?? null,
    querySelectorAll: () => [],
  };
  const binding = captureLinkActionHintBinding(control);

  assert.deepEqual(binding, {
    href: "/tasks/thread/review",
    target: null,
    rel: null,
  });
  assert.equal(matchesLinkActionHintBinding(control, binding), true);
  assert.equal(linkActionHintLabel(control), "Open Review source");

  attributes.delete("aria-label");
  attributes.set("target", "_blank");
  assert.equal(linkActionHintLabel(control), "Open Visible text in a new tab");
  control.innerText = "";
  attributes.set("title", "Title destination");
  assert.equal(
    linkActionHintLabel(control),
    "Open Title destination in a new tab",
  );
  delete control.innerText;
  attributes.delete("title");
  assert.equal(
    linkActionHintLabel(control),
    "Open Fallback text in a new tab",
  );
  control.textContent = "";
  control.querySelectorAll = () => [{
    getAttribute: () => "Diagram destination",
  }];
  assert.equal(
    linkActionHintLabel(control),
    "Open Diagram destination in a new tab",
  );
  attributes.set("href", "mailto:reviewer@example.com");
  assert.equal(
    linkActionHintLabel(control),
    "Open Diagram destination in an email app",
  );
  attributes.set("href", "#review-ready");
  assert.equal(linkActionHintLabel(control), "");
  attributes.delete("href");
  assert.equal(linkActionHintLabel(control), "");
});

test("disclosure Action Hint targets preserve owner semantics and native activation", () => {
  const calls = [];
  const control = {
    open: false,
    focus: (options) => calls.push(["focus", options]),
    click: () => calls.push(["click"]),
  };
  const clipRoots = [{ id: "clip" }];
  const isActionable = () => !control.open;
  const input = {
    id: "work:a:disclosure:root",
    actionId: "disclosure.toggle",
    label: "Expand Work details",
    control,
    clipRoots,
    isActionable,
  };
  const { activate, ...target } = disclosureActionHintTarget(input);

  assert.deepEqual(target, {
    ...input,
    controlKind: "disclosure",
    anchor: control,
  });

  activate();

  assert.deepEqual(calls, [
    ["focus", { preventScroll: true }],
    ["click"],
  ]);
  assert.equal(target.isActionable(), true);
  control.open = true;
  assert.equal(target.isActionable(), false);

  const anchor = { id: "visible-marker" };
  assert.equal(disclosureActionHintTarget({ ...input, anchor }).anchor, anchor);
});

test("radio and switch Action Hint targets preserve native focus and click", () => {
  for (
    const [helper, controlKind, actionId] of [
      [radioActionHintTarget, "radio", "control.radio.select"],
      [switchActionHintTarget, "switch", "control.switch.toggle"],
    ]
  ) {
    const calls = [];
    const control = {
      focus: (options) => calls.push(["focus", options]),
      click: () => calls.push(["click"]),
    };
    const anchor = { id: `${controlKind}-label` };
    const target = helper({
      id: `settings:${controlKind}`,
      actionId,
      label: `Choose ${controlKind}`,
      control,
      anchor,
      clipRoots: [],
      isActionable: () => true,
    });

    assert.equal(target.controlKind, controlKind);
    assert.equal(target.anchor, anchor);
    target.activate();
    assert.deepEqual(calls, [
      ["focus", { preventScroll: true }],
      ["click"],
    ]);
  }
});

test("Action Hint scopes compose direct owners in declaration order", () => {
  const firstTarget = { id: "first" };
  const secondTarget = { id: "second" };
  const mutationRoot = {};
  const scrollRoot = {};
  const first = {
    targets: [firstTarget],
    mutationRoots: [mutationRoot],
  };
  const second = {
    blocked: true,
    targets: [secondTarget],
    scrollRoots: [scrollRoot],
  };

  const merged = mergeActionHintScopes(null, first, second);

  assert.deepEqual(merged, {
    blocked: true,
    targets: [firstTarget, secondTarget],
    mutationRoots: [mutationRoot],
    scrollRoots: [scrollRoot],
  });
  assert.notEqual(merged.targets, first.targets);
  first.targets.push({ id: "later" });
  assert.deepEqual(merged.targets, [firstTarget, secondTarget]);
});

test("editable Action Hint targets focus synchronously and select uses native picker", () => {
  const calls = [];
  const textbox = {
    focus: (options) => calls.push(["textbox-focus", options]),
  };
  const select = {
    focus: (options) => calls.push(["select-focus", options]),
    showPicker: () => calls.push(["show-picker"]),
  };
  const common = {
    id: "dialog:editable",
    actionId: "dialog.textbox.focus",
    label: "Edit value",
    clipRoots: [],
    isActionable: () => true,
  };

  const textboxTarget = textboxActionHintTarget({ ...common, control: textbox });
  const selectTarget = selectActionHintTarget({
    ...common,
    id: "dialog:select",
    actionId: "control.select.open",
    label: "Choose value",
    control: select,
  });

  assert.equal(textboxTarget.controlKind, "textbox");
  assert.equal(selectTarget.controlKind, "select");
  textboxTarget.activate();
  selectTarget.activate();
  assert.deepEqual(calls, [
    ["textbox-focus", { preventScroll: true }],
    ["select-focus", { preventScroll: true }],
    ["show-picker"],
  ]);
});

test("native select activation keeps focus when showPicker is absent or throws", () => {
  for (const showPicker of [undefined, () => { throw new Error("blocked"); }]) {
    let focused = 0;
    const control = {
      focus() {
        focused += 1;
      },
      showPicker,
    };
    selectActionHintTarget({
      id: "dialog:select",
      actionId: "control.select.open",
      label: "Choose value",
      control,
      clipRoots: [],
      isActionable: () => true,
    }).activate();
    assert.equal(focused, 1);
  }
});

test("range, separator, and reorder targets transfer focus without activation", () => {
  for (
    const [helper, controlKind, actionId] of [
      [rangeActionHintTarget, "range", "control.range.focus"],
      [separatorActionHintTarget, "separator", "control.separator.focus"],
      [
        reorderHandleActionHintTarget,
        "reorder-handle",
        "task.reorder.handle.focus",
      ],
    ]
  ) {
    const calls = [];
    const control = {
      focus: (options) => calls.push(["focus", options]),
      click: () => calls.push(["click"]),
    };
    const target = helper({
      id: `control:${controlKind}`,
      actionId,
      label: `Focus ${controlKind}`,
      control,
      clipRoots: [],
      isActionable: () => true,
    });

    assert.equal(target.controlKind, controlKind);
    target.activate();
    assert.deepEqual(calls, [["focus", { preventScroll: true }]]);
  }
});

test("Action Hint scope helpers return complete shapes and reject malformed lists", () => {
  const first = emptyActionHintScope();
  const second = emptyActionHintScope();

  assert.deepEqual(first, {
    blocked: false,
    targets: [],
    mutationRoots: [],
    scrollRoots: [],
  });
  assert.notEqual(first.targets, second.targets);
  assert.throws(
    () => mergeActionHintScopes({ targets: {} }),
    /scope targets must be an array/,
  );
  assert.equal(hasActionHintLayoutBox({ getClientRects: () => [{}] }), true);
  assert.equal(hasActionHintLayoutBox({ getClientRects: () => [] }), false);
  assert.equal(hasActionHintLayoutBox(null), false);
});
