import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionHintController,
} from "./action-hints.js";

test("cancel and activation close one session and clean every owned effect", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = new FakeEventTarget();
    workspace.dataset = {};
    const dialog = new FakeDialog();
    const opener = new FakeHTMLElement();
    document.activeElement = opener;
    let activated = 0;
    let activationPublished = 0;
    const target = {
      id: "task-a",
      actionId: "task.open",
      code: "TA",
      activate: () => {
        activated += 1;
      },
    };
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => null,
      afterActivation: () => {
        activationPublished += 1;
      },
    });
    controller.snapshotIsCurrent = () => true;

    controller.startSession(snapshotFor(target));
    assert.ok(controller.session);
    assert.equal(dialog.openCount, 1);
    assert.ok(window.listenerCount() > 0);
    assert.ok(document.listenerCount() > 0);

    assert.equal(controller.cancel("unit-cancel"), true);
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(window.listenerCount(), 0);
    assert.equal(document.listenerCount(), 0);
    assert.equal(opener.focusCount, 1);
    assert.equal(workspace.dataset.actionHintLastExit, "unit-cancel");
    assert.equal(controller.cancel("duplicate"), false);

    controller.startSession(snapshotFor(target));
    assert.equal(controller.activate("TA"), true);
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 2);
    assert.equal(window.listenerCount(), 0);
    assert.equal(document.listenerCount(), 0);
    assert.equal(activated, 1);
    assert.equal(activationPublished, 1);
    assert.equal(opener.focusCount, 1);
    assert.equal(workspace.dataset.actionHintLastExit, "activated:TA");
    assert.equal(controller.activate("TA"), false);
  } finally {
    restoreGlobals();
  }
});

test("unmatched and unsupported printable input closes Hint without a recoverable error", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const opener = new FakeHTMLElement();
    const exits = [];
    document.activeElement = opener;
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => null,
      onSessionExit: (exit) => exits.push(exit),
    });
    controller.snapshotIsCurrent = () => true;

    const target = {
      id: "task-a",
      actionId: "task.open",
      code: "TA",
      activate: () => {},
    };
    controller.startSession(snapshotFor(target));
    controller.applyInput("T");
    assert.equal(controller.session?.buffer, "T");
    assert.deepEqual(dialog.inputUpdates, [{
      buffer: "T",
      matches: ["TA"],
      exact: "",
      status: "partial",
    }]);

    controller.applyInput("X");
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(opener.focusCount, 1);
    assert.equal(workspace.dataset.actionHintLastExit, "no-match");
    assert.equal(dialog.inputUpdates.length, 1);
    controller.startSession(snapshotFor(target));
    const number = {
      key: "1",
      code: "Digit1",
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    controller.handleHintKeydown(number);
    assert.equal(number.prevented, true);
    assert.equal(number.stopped, true);
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 2);
    assert.equal(opener.focusCount, 2);
    assert.equal(workspace.dataset.actionHintLastExit, "no-match");
    assert.equal(dialog.inputUpdates.length, 1);
    assert.deepEqual(exits, [
      { activated: false, reason: "no-match" },
      { activated: false, reason: "no-match" },
    ]);
    assert.equal(window.listenerCount(), 0);
    assert.equal(document.listenerCount(), 0);
  } finally {
    restoreGlobals();
  }
});

test("disconnect cancels an open Hint without restoring its invoking focus", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = new FakeEventTarget();
    workspace.dataset = {};
    const dialog = new FakeDialog();
    const opener = new FakeHTMLElement();
    document.activeElement = opener;
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => null,
    });
    controller.snapshotIsCurrent = () => true;

    controller.connect();
    controller.startSession(snapshotFor({
      id: "new",
      actionId: "task.create",
      code: "N",
      activate: () => {},
    }));
    assert.ok(controller.session);

    controller.disconnect();
    assert.equal(controller.connected, false);
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(opener.focusCount, 0);
    assert.equal(window.listenerCount(), 0);
    assert.equal(document.listenerCount(), 0);
    assert.equal(workspace.listenerCount(), 0);
    assert.equal(dialog.listenerCount(), 0);
  } finally {
    restoreGlobals();
  }
});

test("native dialog Escape keeps Hint open while the coordinator owns composition", () => {
  const restoreGlobals = installDomGlobals();
  try {
    let compositionActive = true;
    const dialog = new FakeDialog();
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog,
      collectScope: () => null,
      isCompositionActive: () => compositionActive,
    });
    controller.snapshotIsCurrent = () => true;
    controller.startSession(snapshotFor({
      id: "new",
      actionId: "task.create",
      code: "N",
      activate: () => {},
    }));

    controller.boundCancel({
      detail: { reason: "escape", originalEvent: { isComposing: false } },
      stopPropagation() {},
    });
    assert.ok(controller.session);
    assert.equal(dialog.closeCount, 0);

    compositionActive = false;
    controller.boundCancel({
      detail: { reason: "escape", originalEvent: { isComposing: false } },
      stopPropagation() {},
    });
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
  } finally {
    restoreGlobals();
  }
});

test("entry closes and restores focus when showModal-time effects stale the snapshot", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const opener = new FakeHTMLElement();
    document.activeElement = opener;
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => null,
    });
    controller.snapshotIsCurrent = () => false;

    controller.startSession(snapshotFor({
      id: "new",
      actionId: "task.create",
      code: "N",
      activate: () => {},
    }));

    assert.equal(controller.session, null);
    assert.equal(dialog.openCount, 1);
    assert.equal(dialog.closeCount, 1);
    assert.equal(opener.focusCount, 1);
    assert.equal(
      workspace.dataset.actionHintLastExit,
      "snapshot-invalidated",
    );
    assert.equal(window.listenerCount(), 0);
    assert.equal(document.listenerCount(), 0);
  } finally {
    restoreGlobals();
  }
});

test("viewport signals ignore stale delivery and cancel real snapshot drift", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => null,
    });
    controller.snapshotIsCurrent = () => true;
    controller.startSession(snapshotFor({
      id: "task-a",
      actionId: "task.open",
      code: "TA",
      activate: () => {},
    }));
    const resize = [...window.listeners.get("resize")][0];

    resize();
    assert.ok(controller.session);
    assert.equal(dialog.closeCount, 0);

    controller.snapshotIsCurrent = () => false;
    resize();
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(workspace.dataset.actionHintLastExit, "viewport");
  } finally {
    restoreGlobals();
  }
});

test("revalidation refreshes a label without replacing its frozen action", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const activate = () => {};
    const target = {
      id: "task:a",
      actionId: "task.open",
      controlKind: "button",
      code: "TA",
      control: {},
      anchor: {},
      label: "Open task: Before",
      visibleRect: { left: 0, top: 0, right: 20, bottom: 20 },
      activate,
    };
    const snapshot = snapshotFor(target);
    const current = snapshotFor({
      ...target,
      label: "Open task: After",
      activate: () => {
        throw new Error("current activation must not replace the frozen one");
      },
    });
    const dialog = new FakeDialog();
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog,
      collectScope: () => ({}),
    });
    controller.captureSnapshot = () => current;

    assert.equal(
      controller.snapshotIsCurrent(snapshot, { refreshPresentation: true }),
      true,
    );
    assert.equal(snapshot.targets[0].label, "Open task: After");
    assert.equal(snapshot.targets[0].activate, activate);
    assert.deepEqual(dialog.labelUpdates, [[{
      code: "TA",
      label: "Open task: After",
    }]]);
  } finally {
    restoreGlobals();
  }
});

test("binds one session to the selected context-local dialog", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const fallbackDialog = new FakeDialog();
    const localDialog = new FakeDialog();
    const context = {
      id: "popover:model",
      kind: "popover",
      root: new FakeHTMLElement(),
    };
    const target = {
      id: "model:gpt",
      actionId: "task.model.select",
      code: "A",
      activate: () => {},
    };
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog: fallbackDialog,
      collectScope: () => null,
    });
    controller.snapshotIsCurrent = () => true;

    controller.startSession({
      ...snapshotFor(target),
      binding: { context, dialog: localDialog, scope: {} },
    });

    assert.equal(localDialog.openCount, 1);
    assert.equal(fallbackDialog.openCount, 0);
    assert.equal(localDialog.listenerCount(), 2);
    controller.cancel("unit");
    assert.equal(localDialog.closeCount, 1);
    assert.equal(localDialog.listenerCount(), 0);
  } finally {
    restoreGlobals();
  }
});

test("ownership revalidation compares against the frozen context binding", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const observerCallbacks = [];
    globalThis.MutationObserver = class {
      constructor(callback) {
        observerCallbacks.push(callback);
      }

      observe() {}

      disconnect() {}
    };
    document.documentElement = new FakeHTMLElement();
    const dialog = new FakeDialog();
    const context = {
      id: "popover:model",
      kind: "popover",
      root: new FakeHTMLElement(),
    };
    const binding = { context, dialog, scope: {} };
    const observedBindings = [];
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog: new FakeDialog(),
      collectScope: () => null,
      hasOtherInteractionOwner: (candidate) => {
        observedBindings.push(candidate);
        return false;
      },
    });
    controller.snapshotIsCurrent = () => true;
    controller.startSession({
      ...snapshotFor({
        id: "model:gpt",
        actionId: "task.model.select",
        code: "A",
        activate: () => {},
      }),
      binding,
    });

    assert.equal(observerCallbacks.length, 1);
    observerCallbacks[0]([]);
    assert.equal(observedBindings.at(-1), binding);
    assert.ok(controller.session);
    controller.cancel("unit");
  } finally {
    restoreGlobals();
  }
});

test("revalidation rejects a changed context or presentation binding", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const dialog = new FakeDialog();
    const context = {
      id: "popover:model",
      kind: "popover",
      root: new FakeHTMLElement(),
    };
    const target = {
      id: "model:gpt",
      actionId: "task.model.select",
      controlKind: "button",
      code: "A",
      control: {},
      anchor: {},
      label: "GPT",
      visibleRect: { left: 0, top: 0, right: 20, bottom: 20 },
      activate: () => {},
    };
    const scope = {};
    let binding = { context, dialog, scope };
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog: new FakeDialog(),
      collectScope: () => null,
      collectBinding: () => binding,
    });
    controller.captureSnapshot = () => snapshotFor(target);
    const snapshot = { ...snapshotFor(target), binding };

    assert.equal(controller.snapshotIsCurrent(snapshot), true);
    binding = { ...binding, dialog: new FakeDialog() };
    assert.equal(controller.snapshotIsCurrent(snapshot), false);
    binding = {
      context: { ...context, root: new FakeHTMLElement() },
      dialog,
      scope,
    };
    assert.equal(controller.snapshotIsCurrent(snapshot), false);
  } finally {
    restoreGlobals();
  }
});

test("snapshot capture rejects a descriptor outside the central semantic policy", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const control = new FakeHTMLElement();
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog: new FakeDialog(),
      collectScope: () => null,
    });

    assert.equal(controller.captureSnapshot({
      targets: [{
        id: "task:dangerous",
        actionId: "task.delete",
        controlKind: "button",
        label: "Delete task",
        control,
        anchor: control,
        clipRoots: [],
        isActionable: () => true,
        activate: () => {},
      }],
      mutationRoots: [],
      scrollRoots: [],
    }), null);
    assert.equal(controller.captureSnapshot({
      targets: [{
        id: "task:invalid-anchor",
        actionId: "task.open",
        controlKind: "button",
        label: "Open task",
        control,
        anchor: {},
        clipRoots: [],
        isActionable: () => true,
        activate: () => {},
      }],
      mutationRoots: [],
      scrollRoots: [],
    }), null);
  } finally {
    restoreGlobals();
  }
});

function snapshotFor(target) {
  return {
    topology: [],
    targets: [target],
    viewport: {
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      devicePixelRatio: 1,
    },
    dependencies: [],
    mutationRoots: [],
    scrollRoots: [],
    resizeElements: [],
  };
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      this.listeners.delete(type);
    }
  }

  listenerCount() {
    return [...this.listeners.values()].reduce(
      (count, listeners) => count + listeners.size,
      0,
    );
  }
}

class FakeElement extends FakeEventTarget {
  constructor() {
    super();
    this.disabled = false;
    this.hidden = false;
    this.isConnected = true;
  }

  closest() {
    return null;
  }

  getClientRects() {
    return [{}];
  }

  matches() {
    return false;
  }
}

class FakeHTMLElement extends FakeElement {
  constructor() {
    super();
    this.focusCount = 0;
  }

  focus() {
    this.focusCount += 1;
  }
}

class FakeDialog extends FakeEventTarget {
  constructor() {
    super();
    this.closeCount = 0;
    this.inputUpdates = [];
    this.labelUpdates = [];
    this.openCount = 0;
  }

  close() {
    this.closeCount += 1;
  }

  open() {
    this.openCount += 1;
  }

  allowsNativeActivation() {
    return false;
  }

  contains() {
    return false;
  }

  updateTargetLabels(targets) {
    this.labelUpdates.push(targets.map(({ code, label }) => ({ code, label })));
  }

  updateInput(progression) {
    this.inputUpdates.push({
      ...progression,
      matches: [...progression.matches],
    });
  }
}

function installDomGlobals() {
  const previous = new Map();
  const install = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };
  const windowTarget = new FakeEventTarget();
  windowTarget.devicePixelRatio = 1;
  windowTarget.visualViewport = null;
  const documentTarget = new FakeEventTarget();
  documentTarget.activeElement = null;
  documentTarget.documentElement = null;
  documentTarget.querySelector = () => null;
  install("Element", FakeElement);
  install("HTMLElement", FakeHTMLElement);
  install("window", windowTarget);
  install("document", documentTarget);
  install("MutationObserver", undefined);
  install("ResizeObserver", undefined);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    }
  };
}
