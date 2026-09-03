import assert from "node:assert/strict";
import test from "node:test";

import {
  ActionHintController,
  normalizeMutationRootList,
} from "./action-hints.js";

test("normalizes Action Hint mutation roots at the public boundary", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const root = new FakeElement();
    assert.deepEqual(normalizeMutationRootList([root, root]), [root]);
    assert.equal(normalizeMutationRootList([{}]), null);
    assert.equal(normalizeMutationRootList(null), null);
  } finally {
    restoreGlobals();
  }
});

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
    controller.revalidateSnapshot = () => true;

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
    controller.revalidateSnapshot = () => true;

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
    controller.revalidateSnapshot = () => true;

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
    controller.revalidateSnapshot = () => true;
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
    controller.revalidateSnapshot = () => false;

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
    controller.revalidateSnapshot = () => true;
    controller.startSession(snapshotFor({
      id: "task-a",
      actionId: "task.open",
      code: "TA",
      activate: () => {},
    }));
    const resize = [...window.listeners.get("resize")][0];
    const scroll = [...window.listeners.get("scroll")][0];

    resize();
    scroll();
    assert.ok(controller.session);
    assert.equal(dialog.closeCount, 0);

    window.scrollY = 10;
    scroll();
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
    const invalidationOwner = new FakeHTMLElement();
    const control = new FakeHTMLElement();
    const target = {
      id: "task:a",
      actionId: "task.open",
      controlKind: "button",
      code: "TA",
      invalidationOwner,
      control,
      anchor: control,
      clipRoots: [],
      activationKey: "",
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
    controller.captureScopeState = () => current;

    assert.equal(
      controller.revalidateSnapshot(snapshot, { refreshPresentation: true }),
      true,
    );
    assert.equal(snapshot.targets[0].label, "Open task: After");
    assert.equal(snapshot.targets[0].activate, activate);
    assert.equal(dialog.targetUpdates.length, 1);
    assert.equal(
      dialog.targetUpdates[0].targets[0].label,
      "Open task: After",
    );
  } finally {
    restoreGlobals();
  }
});

test("revalidation retires only the changed owner and ignores fresh targets", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const firstOwner = new FakeHTMLElement();
    const secondOwner = new FakeHTMLElement();
    const firstControl = new FakeHTMLElement();
    const replacedControl = new FakeHTMLElement();
    const secondControl = new FakeHTMLElement();
    const frozenActivation = () => {};
    const snapshot = snapshotForTargets([
      {
        id: "first:a",
        actionId: "button.activate",
        code: "A",
        invalidationOwner: firstOwner,
        control: firstControl,
        anchor: firstControl,
        activate: () => {},
      },
      {
        id: "first:b",
        actionId: "button.activate",
        code: "S",
        invalidationOwner: firstOwner,
        control: replacedControl,
        anchor: replacedControl,
        activate: () => {},
      },
      {
        id: "second:a",
        actionId: "button.activate",
        code: "DA",
        invalidationOwner: secondOwner,
        control: secondControl,
        anchor: secondControl,
        label: "Before",
        activate: frozenActivation,
      },
    ]);
    const current = snapshotForTargets([
      {
        id: "first:a",
        actionId: "button.activate",
        invalidationOwner: firstOwner,
        control: firstControl,
        anchor: firstControl,
      },
      {
        id: "first:b",
        actionId: "button.activate",
        invalidationOwner: firstOwner,
        control: new FakeHTMLElement(),
      },
      {
        id: "second:a",
        actionId: "button.activate",
        invalidationOwner: secondOwner,
        control: secondControl,
        anchor: secondControl,
        label: "After",
        visibleRect: { left: 40, top: 50, right: 60, bottom: 70 },
        activate: () => {
          throw new Error("fresh activation must not replace frozen action");
        },
      },
      {
        id: "new:a",
        actionId: "button.activate",
        invalidationOwner: new FakeHTMLElement(),
        control: new FakeHTMLElement(),
      },
    ]);
    const dialog = new FakeDialog();
    const controller = new ActionHintController({
      workspace: Object.assign(new FakeEventTarget(), { dataset: {} }),
      dialog,
      collectScope: () => ({}),
    });
    controller.captureScopeState = () => current;
    snapshot.buffer = "D";

    assert.equal(controller.revalidateSnapshot(
      snapshot,
      { refreshPresentation: true },
    ), true);
    assert.deepEqual(snapshot.targets.map(({ id, code }) => [id, code]), [
      ["second:a", "DA"],
    ]);
    assert.equal(snapshot.targets[0].label, "After");
    assert.equal(snapshot.targets[0].activate, frozenActivation);
    assert.deepEqual(snapshot.targets[0].visibleRect, {
      left: 40,
      top: 50,
      right: 60,
      bottom: 70,
    });
    assert.deepEqual(dialog.inputUpdates.at(-1), {
      buffer: "D",
      matches: ["DA"],
      exact: "",
      status: "partial",
    });
    assert.equal(
      dialog.targetUpdates.at(-1).targets.some(({ id }) => id === "new:a"),
      false,
    );
  } finally {
    restoreGlobals();
  }
});

test("owned scroll revalidates geometry and retires an unavailable owner", async () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const owner = new FakeHTMLElement();
    const control = new FakeHTMLElement();
    const firstScrollRoot = new FakeHTMLElement();
    const secondScrollRoot = new FakeHTMLElement();
    const initial = snapshotFor({
      id: "task:a",
      actionId: "task.open",
      code: "TA",
      invalidationOwner: owner,
      control,
      anchor: control,
      activate: () => {},
    });
    initial.scrollRoots = [firstScrollRoot];
    let current = snapshotFor({
      id: "task:a",
      actionId: "task.open",
      invalidationOwner: owner,
      control,
      anchor: control,
      visibleRect: { left: 20, top: 30, right: 40, bottom: 50 },
      activate: () => {},
    });
    current.scrollRoots = [firstScrollRoot];
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => ({}),
    });
    controller.captureScopeState = () => current;

    assert.equal(controller.startSession(initial), true);
    assert.equal(firstScrollRoot.listenerCount(), 1);
    firstScrollRoot.dispatch("scroll");
    await Promise.resolve();
    assert.ok(controller.session);
    assert.deepEqual(controller.session.targets[0].visibleRect, {
      left: 20,
      top: 30,
      right: 40,
      bottom: 50,
    });

    current = {
      ...current,
      scrollRoots: [secondScrollRoot],
      descriptorStates: current.descriptorStates.map((target) => ({
        ...target,
        visibleRect: { left: 25, top: 35, right: 45, bottom: 55 },
      })),
    };
    firstScrollRoot.dispatch("scroll");
    await Promise.resolve();
    assert.equal(firstScrollRoot.listenerCount(), 0);
    assert.equal(secondScrollRoot.listenerCount(), 1);

    current = {
      ...current,
      descriptorStates: current.descriptorStates.map((target) => ({
        ...target,
        actionable: false,
        visibleRect: null,
      })),
    };
    secondScrollRoot.dispatch("scroll");
    await Promise.resolve();
    assert.equal(controller.session, null);
    assert.equal(secondScrollRoot.listenerCount(), 0);
    assert.equal(workspace.dataset.actionHintLastExit, "snapshot-invalidated");
  } finally {
    restoreGlobals();
  }
});

test("coalesces owner signals and cleans every refreshed subscription", async () => {
  const restoreGlobals = installDomGlobals();
  try {
    const mutationObservers = [];
    const resizeObservers = [];
    globalThis.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        this.observed = [];
        mutationObservers.push(this);
      }

      observe(element) {
        this.observed.push(element);
      }

      disconnect() {
        this.disconnected = true;
      }
    };
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.disconnected = false;
        this.observed = [];
        resizeObservers.push(this);
      }

      observe(element) {
        this.observed.push(element);
      }

      disconnect() {
        this.disconnected = true;
      }
    };
    document.documentElement = new FakeHTMLElement();
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const mutationRoot = new FakeHTMLElement();
    const resizeElement = new FakeHTMLElement();
    const scrollRoot = new FakeHTMLElement();
    const snapshot = snapshotFor({
      id: "task:a",
      actionId: "task.open",
      code: "TA",
      activate: () => {},
    });
    snapshot.mutationRoots = [mutationRoot];
    snapshot.resizeElements = [resizeElement];
    snapshot.scrollRoots = [scrollRoot];
    let validations = 0;
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => ({}),
    });
    controller.revalidateSnapshot = () => {
      validations += 1;
      return true;
    };

    assert.equal(controller.startSession(snapshot), true);
    assert.equal(validations, 1);
    assert.equal(mutationObservers.length, 2);
    assert.equal(resizeObservers.length, 1);
    assert.deepEqual(mutationObservers[1].observed, [mutationRoot]);
    assert.deepEqual(resizeObservers[0].observed, [resizeElement]);
    assert.equal(scrollRoot.listenerCount(), 1);

    mutationObservers[1].callback([{ target: mutationRoot }]);
    mutationObservers[1].callback([{ target: mutationRoot }]);
    resizeObservers[0].callback([]);
    scrollRoot.dispatch("scroll");
    assert.equal(validations, 1);
    await Promise.resolve();
    assert.equal(validations, 2);

    controller.cancel("unit");
    assert.equal(mutationObservers[0].disconnected, true);
    assert.equal(mutationObservers[1].disconnected, true);
    assert.equal(resizeObservers[0].disconnected, true);
    assert.equal(scrollRoot.listenerCount(), 0);
    mutationObservers[1].callback([{ target: mutationRoot }]);
    resizeObservers[0].callback([]);
    scrollRoot.dispatch("scroll");
    await Promise.resolve();
    assert.equal(validations, 2);
  } finally {
    restoreGlobals();
  }
});

test("fails closed when retained presentation reconciliation throws", async () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const snapshot = snapshotFor({
      id: "task:a",
      actionId: "task.open",
      code: "TA",
      activate: () => {},
    });
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => ({}),
    });
    controller.captureScopeState = () => snapshot;

    assert.equal(controller.startSession(snapshot), true);
    dialog.reconcileTargets = () => {
      throw new Error("presentation failed");
    };
    controller.queueRevalidation(controller.session);
    await Promise.resolve();

    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(workspace.dataset.actionHintLastExit, "snapshot-invalidated");
  } finally {
    restoreGlobals();
  }
});

test("exits when owner retirement removes the current input prefix", async () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const opener = new FakeHTMLElement();
    document.activeElement = opener;
    const retiredOwner = new FakeHTMLElement();
    const survivorOwner = new FakeHTMLElement();
    const retiredControl = new FakeHTMLElement();
    const survivorControl = new FakeHTMLElement();
    const snapshot = snapshotForTargets([
      {
        id: "retired",
        actionId: "button.activate",
        code: "SA",
        invalidationOwner: retiredOwner,
        control: retiredControl,
        anchor: retiredControl,
        activate: () => {},
      },
      {
        id: "survivor",
        actionId: "button.activate",
        code: "D",
        invalidationOwner: survivorOwner,
        control: survivorControl,
        anchor: survivorControl,
        activate: () => {},
      },
    ]);
    let current = snapshotForTargets([
      {
        id: "retired",
        actionId: "button.activate",
        invalidationOwner: retiredOwner,
        control: retiredControl,
        anchor: retiredControl,
      },
      {
        id: "survivor",
        actionId: "button.activate",
        invalidationOwner: survivorOwner,
        control: survivorControl,
        anchor: survivorControl,
      },
    ]);
    const retiredCurrent = snapshotForTargets([
      {
        id: "retired",
        actionId: "button.activate",
        invalidationOwner: retiredOwner,
        control: retiredControl,
        anchor: retiredControl,
        actionable: false,
        visibleRect: null,
      },
      {
        id: "survivor",
        actionId: "button.activate",
        invalidationOwner: survivorOwner,
        control: survivorControl,
        anchor: survivorControl,
      },
    ]);
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => ({}),
    });
    controller.captureScopeState = () => current;

    assert.equal(controller.startSession(snapshot), true);
    controller.applyInput("S");
    assert.equal(controller.session?.buffer, "S");
    current = retiredCurrent;
    controller.queueRevalidation(controller.session);
    await Promise.resolve();

    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(opener.focusCount, 1);
    assert.equal(
      workspace.dataset.actionHintLastExit,
      "snapshot-invalidated",
    );
  } finally {
    restoreGlobals();
  }
});

test("activation cleanup precedes cancellation for a changed link binding", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
    const dialog = new FakeDialog();
    const invalidationOwner = new FakeHTMLElement();
    const control = new FakeHTMLElement();
    let activationKey = JSON.stringify([
      "https://example.com/first",
      "_blank",
      "noopener noreferrer",
    ]);
    let activated = 0;
    const target = {
      id: "settings:remote-access:open",
      actionId: "link.open",
      controlKind: "link",
      code: "A",
      invalidationOwner,
      control,
      anchor: control,
      clipRoots: [],
      label: "Open Tailnet URL in a new tab",
      visibleRect: { left: 0, top: 0, right: 20, bottom: 20 },
      activate: () => {
        activated += 1;
      },
    };
    const currentSnapshot = () => snapshotFor({
      ...target,
      activationKey,
    });
    const controller = new ActionHintController({
      workspace,
      dialog,
      collectScope: () => ({}),
    });
    controller.captureScopeState = currentSnapshot;

    controller.startSession(currentSnapshot());
    activationKey = JSON.stringify([
      "https://example.com/second",
      "_blank",
      "noopener noreferrer",
    ]);

    assert.equal(controller.activate("A"), false);
    assert.equal(controller.session, null);
    assert.equal(dialog.closeCount, 1);
    assert.equal(activated, 0);
    assert.equal(
      workspace.dataset.actionHintLastExit,
      "activation-invalidated",
    );
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
    controller.revalidateSnapshot = () => true;

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
    controller.revalidateSnapshot = () => true;
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
    const invalidationOwner = new FakeHTMLElement();
    const control = new FakeHTMLElement();
    const target = {
      id: "model:gpt",
      actionId: "task.model.select",
      controlKind: "button",
      code: "A",
      invalidationOwner,
      control,
      anchor: control,
      clipRoots: [],
      activationKey: "",
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
    controller.captureScopeState = () => snapshotFor(target);
    const snapshot = { ...snapshotFor(target), binding };

    assert.equal(controller.revalidateSnapshot(snapshot), true);
    binding = { ...binding, dialog: new FakeDialog() };
    assert.equal(controller.revalidateSnapshot(snapshot), false);
    binding = {
      context: { ...context, root: new FakeHTMLElement() },
      dialog,
      scope,
    };
    assert.equal(controller.revalidateSnapshot(snapshot), false);
  } finally {
    restoreGlobals();
  }
});

test("snapshot capture rejects a descriptor outside the central semantic policy", () => {
  const restoreGlobals = installDomGlobals();
  try {
    const control = new FakeHTMLElement();
    const invalidationOwner = new FakeHTMLElement();
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
        invalidationOwner,
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
        invalidationOwner,
        control,
        anchor: {},
        clipRoots: [],
        isActionable: () => true,
        activate: () => {},
      }],
      mutationRoots: [],
      scrollRoots: [],
    }), null);
    assert.equal(controller.captureSnapshot({
      targets: [{
        id: "task:ownerless",
        actionId: "task.open",
        controlKind: "button",
        label: "Open task",
        control,
        anchor: control,
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
  return snapshotForTargets([target]);
}

function snapshotForTargets(targets) {
  const normalizedTargets = targets.map(normalizeTestTarget);
  return {
    descriptorStates: normalizedTargets,
    targets: normalizedTargets,
    viewport: {
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      devicePixelRatio: 1,
    },
    mutationRoots: [],
    scrollRoots: [],
    resizeElements: [],
  };
}

function normalizeTestTarget(target) {
  const control = target.control ?? new FakeHTMLElement();
  const invalidationOwner = target.invalidationOwner ?? new FakeHTMLElement();
  return {
    controlKind: "button",
    activationKey: "",
    invalidationOwner,
    control,
    anchor: target.anchor ?? control,
    clipRoots: [],
    label: target.label ?? target.id,
    actionable: true,
    visibleRect: { left: 0, top: 0, right: 20, bottom: 20 },
    isActionable: () => true,
    ...target,
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

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, ...event });
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
    this.rect = { left: 0, top: 0, right: 20, bottom: 20 };
  }

  closest() {
    return null;
  }

  getClientRects() {
    return [{}];
  }

  getBoundingClientRect() {
    return this.rect;
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
    this.openCount = 0;
    this.targetUpdates = [];
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

  reconcileTargets(targets, viewportRect) {
    this.targetUpdates.push({
      targets: [...targets],
      viewportRect,
    });
    return true;
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
  windowTarget.innerWidth = 100;
  windowTarget.innerHeight = 100;
  windowTarget.scrollX = 0;
  windowTarget.scrollY = 0;
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
