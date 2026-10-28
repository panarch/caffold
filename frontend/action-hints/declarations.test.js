import assert from "node:assert/strict";
import test, { after } from "node:test";

const previousNode = globalThis.Node;
globalThis.Node = { DOCUMENT_POSITION_PRECEDING: 2 };
const { ActionHints, declaredActionHintScope } = await import(
  "./declarations.js"
);
const { ACTION_HINT_ACTION } = await import("./model.js");

after(() => restoreGlobal("Node", previousNode));

test("a declaration becomes a target named inside the scope it is pulled into", () => {
  const owner = control();
  const button = control();
  const clip = control();
  const scope = declaredActionHintScope(
    owner,
    [
      declared(button, "button", {
        id: "restart",
        label: "Restart Codex",
        action: ACTION_HINT_ACTION.DIALOG_BUTTON,
        badgeAtEnd: true,
      }),
    ],
    { scopeId: "codex-runtime-restart", clipRoots: [clip] },
  );

  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.scrollRoots, [clip]);
  const [target] = scope.targets;
  assert.equal(target.id, "codex-runtime-restart:restart");
  assert.equal(target.actionId, ACTION_HINT_ACTION.DIALOG_BUTTON);
  assert.equal(target.label, "Restart Codex");
  assert.equal(target.controlKind, "button");
  assert.equal(target.control, button);
  assert.equal(target.anchor, button);
  assert.equal(target.invalidationOwner, owner);
  assert.deepEqual(target.clipRoots, [clip]);
  assert.equal(target.badgeAtEnd, true);
});

test("the parent names the action of a declaration that leaves it out", () => {
  const owner = control();
  const page = control();
  const refresh = control();
  const unnamed = control();
  const scope = declaredActionHintScope(
    owner,
    [
      declared(page, "button", { id: "page:2", label: "Open page 2" }),
      declared(refresh, "button", {
        id: "refresh",
        label: "Refresh",
        role: "refresh",
      }),
      declared(unnamed, "button", {
        id: "details",
        label: "Details",
        role: "details",
      }),
    ],
    {
      actionId: ACTION_HINT_ACTION.PAGE,
      actions: { refresh: ACTION_HINT_ACTION.BUTTON_ACTIVATE },
    },
  );

  assert.deepEqual(
    scope.targets.map((target) => [target.id, target.actionId]),
    [
      ["page:2", ACTION_HINT_ACTION.PAGE],
      ["refresh", ACTION_HINT_ACTION.BUTTON_ACTIVATE],
    ],
  );
});

test("a declaration the person cannot use now, or cannot see, makes no target", () => {
  const scope = declaredActionHintScope(
    control(),
    [
      declared(control(), "button", {
        id: "open",
        label: "Open",
        action: ACTION_HINT_ACTION.DIALOG_BUTTON,
        when: false,
      }),
      declared(control({ getClientRects: () => [] }), "button", {
        id: "hidden",
        label: "Hidden",
        action: ACTION_HINT_ACTION.DIALOG_BUTTON,
      }),
      declared(control({ disabled: true }), "button", {
        id: "disabled",
        label: "Disabled",
        action: ACTION_HINT_ACTION.DIALOG_BUTTON,
      }),
    ],
    {},
  );

  assert.deepEqual(scope.targets, []);
});

test("a declaration may name its own anchor, owner, and clip roots, which it scrolls in", () => {
  const owner = control();
  const row = control();
  const button = control();
  const badge = control();
  const list = control();
  const scope = declaredActionHintScope(
    owner,
    [
      declared(button, "button", {
        id: "pin",
        label: "Pin",
        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        anchor: () => badge,
        owner: () => row,
        clipRoots: () => [list, null],
      }),
    ],
    { clipRoots: [owner] },
  );

  const [target] = scope.targets;
  assert.equal(target.anchor, badge);
  assert.equal(target.invalidationOwner, row);
  assert.deepEqual(target.clipRoots, [owner, list]);
  assert.deepEqual(scope.mutationRoots, [row]);
  assert.deepEqual(scope.scrollRoots, [owner, list]);
});

test("a change in any declaration's owner revalidates, the component's own included", () => {
  const owner = control();
  const row = control();
  const scope = declaredActionHintScope(
    owner,
    [
      declared(control(), "button", {
        id: "open",
        label: "Open",
        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        owner: () => row,
      }),
      declared(control(), "button", {
        id: "close",
        label: "Close",
        action: ACTION_HINT_ACTION.DIALOG_BUTTON,
      }),
    ],
    {},
  );

  assert.deepEqual(scope.mutationRoots, [row, owner]);
  assert.deepEqual(declaredActionHintScope(owner, [], {}).mutationRoots, [
    owner,
  ]);
});

test("an owner that renders into a shadow root has a change there revalidate", () => {
  const shadowRoot = {};
  const owner = control({ shadowRoot });
  const scope = declaredActionHintScope(
    owner,
    [
      declared(control(), "button", {
        id: "next",
        label: "Next page",
        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      }),
    ],
    {},
  );

  assert.deepEqual(scope.mutationRoots, [owner, shadowRoot]);
  assert.deepEqual(declaredActionHintScope(owner, [], {}).mutationRoots, [
    owner,
    shadowRoot,
  ]);
});

test("a link left unlabeled is named from what it shows and where it goes", () => {
  const attributes = new Map([
    ["href", "https://status.example.com"],
    ["target", "_blank"],
  ]);
  const status = control({
    innerText: "Service status",
    getAttribute: (name) => attributes.get(name) ?? null,
    querySelectorAll: () => [],
  });
  const unnamed = control({ innerText: "", querySelectorAll: () => [] });
  const scope = declaredActionHintScope(
    control(),
    [
      declared(status, "link", {
        id: "service-status",
        action: ACTION_HINT_ACTION.LINK_OPEN,
      }),
      declared(unnamed, "link", {
        id: "nowhere",
        action: ACTION_HINT_ACTION.LINK_OPEN,
      }),
    ],
    {},
  );

  assert.deepEqual(
    scope.targets.map(({ id, label }) => [id, label]),
    [["service-status", "Open Service status in a new tab"]],
  );
});

function declared(element, kind, declaration) {
  return { element, value: { kind, declaration } };
}

function control(properties = {}) {
  return {
    parentElement: null,
    isConnected: true,
    getAttribute: () => null,
    getClientRects: () => [{}],
    compareDocumentPosition: () => 4,
    ...properties,
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
