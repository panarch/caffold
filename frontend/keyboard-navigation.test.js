import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "./tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
globalThis.Element = globalThis.HTMLElement;
const { KeyboardNavigationController } = await import("./keyboard-navigation.js");
const {
  KEYBOARD_NAVIGATION_EVENT,
  KEYBOARD_NAVIGATION_NODE,
} = await import("./keyboard-navigation/control.js");
after(() => {
  restoreGlobal("Element", previousElement);
  registry.restore();
});

test("one transition authority keeps Hint, selection, and active Scroll exclusive", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    assert.equal(controller.controlNode(), KEYBOARD_NAVIGATION_NODE.NORMAL);
    assert.equal(
      controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_STARTED).next,
      KEYBOARD_NAVIGATION_NODE.HINT,
    );
    assert.equal(
      controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_STARTED),
      null,
    );
    controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED);
    controller.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_STARTED,
    );
    assert.equal(
      controller.controlNode(),
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
    );
    controller.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SURFACE_SELECTED,
    );
    assert.equal(
      controller.controlNode(),
      KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE,
    );
    assert.equal(
      controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_STARTED),
      null,
    );
    controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
    assert.equal(controller.controlNode(), KEYBOARD_NAVIGATION_NODE.NORMAL);
  } finally {
    restoreDom();
  }
});

test("question mark opens one global shortcut dialog and restores its opener", () => {
  const restoreDom = installEventGlobals();
  try {
    const dialog = keyboardShortcutDialog();
    const controller = createController({ shortcutDialog: dialog });
    const opener = element({
      isConnected: true,
      focus(options) {
        assert.deepEqual(options, { preventScroll: true });
        document.activeElement = opener;
      },
    });
    document.activeElement = opener;

    const open = keyEvent("?");
    open.target = opener;
    controller.handleKeydown(open);
    assert.equal(open.prevented, true);
    assert.equal(open.stopped, true);
    assert.equal(dialog.openCalls, 1);
    assert.equal(
      controller.storedNode,
      KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP,
    );
    assert.equal(controller.workspace.dataset.keyboardShortcutHelp, "open");

    document.activeElement = dialog;
    const close = keyEvent("?");
    close.target = dialog;
    controller.handleKeydown(close);
    assert.equal(close.prevented, true);
    assert.equal(dialog.closeCalls, 1);
    assert.equal(controller.storedNode, null);
    assert.equal(document.activeElement, opener);
    assert.equal(
      controller.workspace.dataset.keyboardShortcutHelpLastExit,
      "keyboard",
    );
  } finally {
    restoreDom();
  }
});

test("shortcut help stays native in editing and ignores unsafe key variants", () => {
  const restoreDom = installEventGlobals();
  try {
    const dialog = keyboardShortcutDialog();
    const controller = createController({ shortcutDialog: dialog });
    const input = element({
      isConnected: true,
      matches: (selector) => selector.includes("input:not"),
    });
    document.activeElement = input;
    for (const event of [
      keyEvent("?"),
      keyEvent("?", { repeat: true }),
      keyEvent("?", { ctrlKey: true }),
      { ...keyEvent("?"), isComposing: true },
    ]) {
      event.target = input;
      controller.handleKeydown(event);
      assert.equal(event.prevented, false);
    }
    assert.equal(dialog.openCalls, 0);

    document.activeElement = null;
    const repeated = keyEvent("?", { repeat: true });
    controller.handleKeydown(repeated);
    assert.equal(dialog.openCalls, 0);
    const modified = keyEvent("?", { ctrlKey: true });
    controller.handleKeydown(modified);
    assert.equal(dialog.openCalls, 0);
  } finally {
    restoreDom();
  }
});

test("shortcut help replaces every active keyboard mode before it opens", () => {
  const restoreDom = installEventGlobals();
  try {
    for (const node of [
      KEYBOARD_NAVIGATION_NODE.HINT,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
      KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE,
    ]) {
      const order = [];
      const dialog = keyboardShortcutDialog({
        onOpen: () => order.push("open-help"),
      });
      const controller = createController({ shortcutDialog: dialog });
      controller.storedNode = node;
      controller.cancelStoredMode = (reason, options) => {
        assert.equal(reason, "shortcut-help");
        assert.deepEqual(options, { restoreFocus: false });
        order.push(`close-${node}`);
        controller.storedNode = null;
        return true;
      };

      const event = keyEvent("?");
      controller.handleKeydown(event);
      assert.deepEqual(order, [`close-${node}`, "open-help"]);
      assert.equal(
        controller.storedNode,
        KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP,
      );
      controller.closeShortcutHelp("test", { restoreFocus: false });
    }
  } finally {
    restoreDom();
  }
});

test("route, setting, and disconnect cleanup close shortcut help", () => {
  const restoreDom = installEventGlobals();
  try {
    const dialog = keyboardShortcutDialog();
    const controller = createController({ shortcutDialog: dialog });

    assert.equal(controller.startShortcutHelp(), true);
    controller.routeWillChange();
    assert.equal(controller.storedNode, null);

    assert.equal(controller.startShortcutHelp(), true);
    controller.boundSettingsChange({
      detail: { settings: { actionHintsEnabled: false } },
    });
    assert.equal(controller.storedNode, null);

    controller.connect();
    assert.equal(controller.startShortcutHelp(), true);
    controller.disconnect();
    assert.equal(controller.storedNode, null);
    assert.equal(dialog.closeCalls, 3);
  } finally {
    restoreDom();
  }
});

test("coordinator alone owns the document key listener and releases all inputs", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    controller.connect();
    assert.equal(document.listenerCount("keydown"), 1);
    assert.equal(controller.actionHints.connected, true);
    assert.equal(controller.workspace.listenerCount("compositionstart"), 1);
    assert.equal(window.listenerCount("caffold:settings-change"), 1);
    controller.disconnect();
    assert.equal(document.listenerCount(), 0);
    assert.equal(controller.workspace.listenerCount(), 0);
    assert.equal(window.listenerCount(), 0);
    assert.equal(controller.actionHints.connected, false);
  } finally {
    restoreDom();
  }
});

test("entry uses 0, 1, many policy with selectors in workspace and modal", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const context = { kind: "workspace", blocked: false };
    controller.resolveInteractionContext = () => context;
    controller.beginActive = () => true;
    controller.beginSelection = () => true;

    controller.captureScrollSnapshot = () => ({ context, surfaces: [] });
    assert.equal(controller.startScroll(), false);
    assert.equal(controller.storedNode, null);

    controller.captureScrollSnapshot = () => ({
      context,
      surfaces: [{ id: "task-list" }],
    });
    assert.equal(controller.startScroll(), true);
    assert.equal(controller.storedNode, KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE);
    controller.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);

    controller.captureScrollSnapshot = () => ({
      context,
      surfaces: [{ id: "task-list" }, { id: "conversation" }],
    });
    assert.equal(controller.startScroll(), true);
    assert.equal(
      controller.storedNode,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
    );
    controller.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_CANCELLED,
    );

    const modal = { kind: "modal", blocked: false };
    controller.resolveInteractionContext = () => modal;
    controller.captureScrollSnapshot = () => ({
      context: modal,
      surfaces: [{ id: "one" }, { id: "two" }],
    });
    assert.equal(controller.startScroll(), true);
    assert.equal(
      controller.storedNode,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
    );
    controller.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_CANCELLED,
    );

    const popover = { kind: "popover", blocked: false };
    controller.resolveInteractionContext = () => popover;
    controller.captureScrollSnapshot = () => ({
      context: popover,
      surfaces: [{ id: "one" }, { id: "two" }],
    });
    assert.equal(controller.startScroll(), false);
    assert.equal(controller.storedNode, null);
  } finally {
    restoreDom();
  }
});

test("active repeated commands move only the bound scrollport and consume boundaries", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const scrollport = {
      scrollTop: 50,
      scrollHeight: 500,
      clientHeight: 100,
      scrollLeft: 50,
      scrollWidth: 500,
      clientWidth: 100,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = {
      scrollport,
      availableAxes: ["vertical", "horizontal"],
    };
    controller.activeBindingIsCurrent = () => true;
    const repeated = keyEvent("j", { code: "KeyJ", repeat: true });
    controller.handleActiveKeydown(repeated);
    assert.equal(scrollport.scrollTop, 60);
    assert.equal(repeated.prevented, true);
    assert.equal(repeated.stopped, true);

    scrollport.scrollTop = 400;
    const boundary = keyEvent("D", { code: "KeyD", repeat: true });
    controller.handleActiveKeydown(boundary);
    assert.equal(scrollport.scrollTop, 400);
    assert.equal(boundary.prevented, true);

    const horizontal = keyEvent("l", { code: "KeyL", repeat: true });
    controller.handleActiveKeydown(horizontal);
    assert.equal(scrollport.scrollLeft, 60);
    assert.equal(horizontal.prevented, true);
    scrollport.scrollLeft = 400;
    const horizontalBoundary = keyEvent("L", {
      code: "KeyL",
      repeat: true,
    });
    controller.handleActiveKeydown(horizontalBoundary);
    assert.equal(scrollport.scrollLeft, 400);
    assert.equal(horizontalBoundary.prevented, true);

    const modified = keyEvent("j", { code: "KeyJ", ctrlKey: true });
    controller.handleActiveKeydown(modified);
    assert.equal(scrollport.scrollTop, 400);
    assert.equal(modified.prevented, false);
  } finally {
    restoreDom();
  }
});

test("capture intersects declared axes with exact current overflow", () => {
  const restoreDom = installEventGlobals();
  try {
    document.documentElement = { clientWidth: 800, clientHeight: 600 };
    const controller = createController();
    const scrollport = element({
      isConnected: true,
      clientHeight: 100,
      scrollHeight: 101,
      clientWidth: 100,
      scrollWidth: 260,
      getBoundingClientRect: () => rect(20, 20, 220, 120),
    });
    const root = element({
      isConnected: true,
      contains: (candidate) => candidate === scrollport,
      getBoundingClientRect: () => rect(0, 0, 500, 500),
    });
    const context = {
      id: "workspace",
      kind: "workspace",
      root,
      scroll: {
        hud: element(),
        selector: scrollSelector(),
        scope: {
          blocked: false,
          surfaces: [{
            id: "code",
            label: "Code",
            scrollport,
            axes: ["vertical", "horizontal"],
            clipRoots: [],
            isEligible: () => true,
          }],
          mutationRoots: [],
          resizeElements: [],
          scrollRoots: [scrollport],
        },
      },
    };

    let snapshot = controller.captureScrollSnapshot(context);
    assert.equal(snapshot.surfaces.length, 1);
    assert.deepEqual(snapshot.surfaces[0].axes, [
      "vertical",
      "horizontal",
    ]);
    assert.deepEqual(snapshot.surfaces[0].availableAxes, ["horizontal"]);

    scrollport.scrollHeight = 260;
    snapshot = controller.captureScrollSnapshot(context);
    assert.equal(snapshot.surfaces.length, 1);
    assert.deepEqual(snapshot.surfaces[0].availableAxes, [
      "vertical",
      "horizontal",
    ]);

    scrollport.scrollWidth = 101;
    scrollport.scrollHeight = 101;
    assert.equal(controller.captureScrollSnapshot(context).surfaces.length, 0);
  } finally {
    restoreDom();
  }
});

test("active F closes Scroll before collecting a fresh Action Hint session", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const order = [];
    const snapshot = { targets: [{ id: "settings" }] };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = {
      cleanup: [],
      context: { hud: { close: () => order.push("hud-close") } },
    };
    controller.detachActiveSignals = () => order.push("detach-scroll");
    controller.actionHints.prepareSnapshot = () => {
      assert.equal(controller.storedNode, null);
      assert.equal(controller.activeSession, null);
      order.push("capture-hints");
      return snapshot;
    };
    controller.actionHints.startSession = (candidate) => {
      assert.equal(candidate, snapshot);
      order.push("start-hints");
      return true;
    };

    const repeated = keyEvent("f", { code: "KeyF", repeat: true });
    controller.handleKeydown(repeated);
    assert.equal(controller.storedNode, KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE);
    assert.equal(repeated.prevented, false);

    const event = keyEvent("f", { code: "KeyF" });
    controller.handleKeydown(event);

    assert.deepEqual(order, [
      "detach-scroll",
      "hud-close",
      "capture-hints",
      "start-hints",
    ]);
    assert.equal(controller.storedNode, KEYBOARD_NAVIGATION_NODE.HINT);
    assert.equal(
      controller.workspace.dataset.scrollModeLastExit,
      "action-hints",
    );
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  } finally {
    restoreDom();
  }
});

test("active F leaves no stored mode when the fresh context has no Hint target", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = {
      cleanup: [],
      context: { hud: { close() {} } },
    };
    controller.actionHints.prepareSnapshot = () => null;
    const active = keyEvent("f", { code: "KeyF" });
    controller.handleKeydown(active);
    assert.equal(controller.storedNode, null);
    assert.equal(controller.activeSession, null);
    assert.equal(active.prevented, true);
    assert.equal(active.stopped, true);
  } finally {
    restoreDom();
  }
});

test("Scroll selection keeps matching prefixes and exits on unmatched printable input", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selector = scrollSelector();
    let progression = null;
    let closeCalls = 0;
    selector.updateInput = (next) => {
      progression = next;
    };
    selector.close = () => {
      closeCalls += 1;
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    controller.selectionSession = {
      selector,
      surfaces: [{ code: "FA" }],
      buffer: "",
      cleanup: [],
    };

    const prefix = keyEvent("f", { code: "KeyF" });
    controller.handleKeydown(prefix);
    assert.deepEqual(progression, {
      buffer: "F",
      matches: ["FA"],
      exact: "",
      status: "partial",
    });
    assert.equal(
      controller.storedNode,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
    );
    assert.equal(prefix.prevented, true);
    assert.equal(prefix.stopped, true);

    const unmatchedLetter = keyEvent("z", { code: "KeyZ" });
    controller.handleKeydown(unmatchedLetter);
    assert.equal(controller.storedNode, null);
    assert.equal(controller.selectionSession, null);
    assert.equal(controller.workspace.dataset.scrollModeLastExit, "no-match");
    assert.equal(closeCalls, 1);
    assert.equal(unmatchedLetter.prevented, true);
    assert.equal(unmatchedLetter.stopped, true);

    const unsupported = createController();
    unsupported.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    unsupported.selectionSession = {
      selector: scrollSelector(),
      surfaces: [{ code: "A" }],
      buffer: "",
      cleanup: [],
    };
    const number = keyEvent("1");
    unsupported.handleKeydown(number);
    assert.equal(unsupported.storedNode, null);
    assert.equal(unsupported.selectionSession, null);
    assert.equal(
      unsupported.workspace.dataset.scrollModeLastExit,
      "no-match",
    );
    assert.equal(number.prevented, true);
    assert.equal(number.stopped, true);
  } finally {
    restoreDom();
  }
});

test("Scroll selection accepts events only from its pinned context selector", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selector = scrollSelector();
    const selected = [];
    controller.selectionSession = { selector };
    controller.selectSurface = (code) => selected.push(code);

    const foreign = {
      target: scrollSelector(),
      detail: { code: "A" },
      stopPropagation() {
        throw new Error("foreign selector event must not be consumed");
      },
    };
    controller.boundSurfaceSelect(foreign);
    assert.deepEqual(selected, []);

    let stopped = false;
    controller.boundSurfaceSelect({
      target: selector,
      detail: { code: "S" },
      stopPropagation: () => {
        stopped = true;
      },
    });
    assert.deepEqual(selected, ["S"]);
    assert.equal(stopped, true);
  } finally {
    restoreDom();
  }
});

test("resolves workspace, exact modal, and registered popover ownership", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const workspace = context("workspace", "workspace");
    const modal = context("current-plan", "modal");
    const popover = context("popover:model", "popover");
    controller.collectKeyboardNavigationContexts = () => [
      workspace,
      modal,
      popover,
    ];

    assert.equal(controller.resolveInteractionContext()?.root, workspace.root);
    document.modal = modal.root;
    assert.equal(controller.resolveInteractionContext()?.root, modal.root);
    document.modals = [modal.root, element()];
    assert.equal(controller.resolveInteractionContext(), null);
    assert.equal(controller.hasUnregisteredInteractionOwner(), true);
    document.modals = null;
    document.modal = element();
    assert.equal(controller.resolveInteractionContext(), null);
    document.modal = null;
    document.popover = popover.root;
    assert.equal(controller.resolveInteractionContext()?.root, popover.root);

    document.modal = element({ contains: (candidate) => candidate === popover.root });
    assert.equal(controller.resolveInteractionContext()?.root, popover.root);
    document.modal = element({ contains: () => false });
    assert.equal(controller.resolveInteractionContext(), null);

    document.modal = null;
    document.popover = element();
    assert.equal(controller.resolveInteractionContext(), null);
    document.popovers = [popover.root, element()];
    assert.equal(controller.resolveInteractionContext(), null);
  } finally {
    restoreDom();
  }
});

test("registered modal consumes only the first non-composing Editing Escape", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const root = element();
    const input = element({
      isConnected: true,
      matches: (selector) => selector.includes("input:not"),
      closest: () => null,
    });
    const cancel = element({
      isConnected: true,
      hidden: false,
      disabled: false,
      focus(options) {
        assert.deepEqual(options, { preventScroll: true });
        document.activeElement = cancel;
      },
    });
    root.contains = (candidate) => [root, input, cancel].includes(candidate);
    controller.collectKeyboardNavigationContexts = () => [{
      id: "fork",
      kind: "modal",
      root,
      editing: { escapeTarget: (editable) => editable === input ? cancel : null },
    }];
    document.modal = root;
    document.activeElement = input;

    const first = keyEvent("Escape");
    first.target = input;
    controller.handleKeydown(first);
    assert.equal(first.prevented, true);
    assert.equal(first.stopped, true);
    assert.equal(document.activeElement, cancel);

    const second = keyEvent("Escape");
    second.target = cancel;
    controller.handleKeydown(second);
    assert.equal(second.prevented, false);
    assert.equal(second.stopped, false);
  } finally {
    restoreDom();
  }
});

test("Editing Escape stays native for composition, unknown modal, or invalid target", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const root = element();
    const input = element({
      isConnected: true,
      matches: (selector) => selector.includes("input:not"),
      closest: () => null,
    });
    root.contains = (candidate) => candidate === root || candidate === input;
    document.activeElement = input;
    document.modal = root;

    const unknown = keyEvent("Escape");
    unknown.target = input;
    controller.handleKeydown(unknown);
    assert.equal(unknown.prevented, false);

    controller.collectKeyboardNavigationContexts = () => [{
      id: "modal",
      kind: "modal",
      root,
      editing: { escapeTarget: () => element({ isConnected: true }) },
    }];
    const invalid = keyEvent("Escape");
    invalid.target = input;
    controller.handleKeydown(invalid);
    assert.equal(invalid.prevented, false);

    const composing = keyEvent("Escape");
    composing.target = input;
    composing.isComposing = true;
    controller.handleKeydown(composing);
    assert.equal(composing.prevented, false);
  } finally {
    restoreDom();
  }
});

test("rejects malformed and duplicate provider identities centrally", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const root = element();
    const hud = element({ show() {}, close() {}, updateLabel() {} });
    const selector = scrollSelector();
    const scrollport = element();
    const surface = {
      id: "same",
      label: "Surface",
      scrollport,
      axes: ["vertical"],
      availableAxes: ["vertical"],
      clipRoots: [],
      isEligible: () => true,
    };
    root.contains = (candidate) =>
      candidate === root || candidate === hud || candidate === selector;
    controller.collectKeyboardNavigationContexts = () => [{
      id: "workspace",
      kind: "workspace",
      root,
      scroll: {
        hud,
        selector,
        scope: {
          blocked: false,
          surfaces: [surface, { ...surface }],
          mutationRoots: [],
          resizeElements: [],
          scrollRoots: [],
        },
      },
    }];
    assert.equal(controller.safeCollectKeyboardNavigationContexts(), null);

    controller.collectKeyboardNavigationContexts = () => [
      context("duplicate", "workspace"),
      context("duplicate", "modal"),
    ];
    assert.equal(controller.safeCollectKeyboardNavigationContexts(), null);
  } finally {
    restoreDom();
  }
});

test("settings, route, and composition ownership clean an active Scroll session", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const exits = [];
    const beginActive = () => {
      controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
      controller.activeSession = {
        cleanup: [],
        context: { hud: { close: () => exits.push("hud-close") } },
      };
    };

    beginActive();
    controller.boundSettingsChange({
      detail: { settings: { actionHintsEnabled: false } },
    });
    assert.equal(controller.storedNode, null);
    assert.deepEqual(exits, ["hud-close"]);

    beginActive();
    controller.routeWillChange();
    assert.equal(controller.storedNode, null);
    assert.deepEqual(exits, ["hud-close", "hud-close"]);

    beginActive();
    controller.boundCompositionStart({ target: element() });
    assert.equal(controller.storedNode, null);
    assert.equal(controller.compositionActive, true);
    assert.deepEqual(exits, ["hud-close", "hud-close", "hud-close"]);
  } finally {
    restoreDom();
  }
});

test("observer revalidation ignores initial stable delivery and cancels real drift", async () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selection = { revalidationQueued: false };
    controller.selectionSession = selection;
    controller.selectionSnapshotIsCurrent = () => true;
    controller.queueSelectionRevalidation(selection);
    await Promise.resolve();
    assert.equal(controller.selectionSession, selection);

    controller.selectionSnapshotIsCurrent = () => false;
    controller.cancelSelection = () => {
      controller.selectionSession = null;
      return true;
    };
    controller.queueSelectionRevalidation(selection);
    await Promise.resolve();
    assert.equal(controller.selectionSession, null);

    const active = { revalidationQueued: false };
    controller.activeSession = active;
    controller.activeBindingIsCurrent = () => true;
    controller.queueActiveRevalidation(active);
    await Promise.resolve();
    assert.equal(controller.activeSession, active);

    controller.activeBindingIsCurrent = () => false;
    controller.cancelActive = () => {
      controller.activeSession = null;
      return true;
    };
    controller.queueActiveRevalidation(active);
    await Promise.resolve();
    assert.equal(controller.activeSession, null);
  } finally {
    restoreDom();
  }
});

test("Scroll selection ignores stale scroll delivery and cancels real movement", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const scrollRoot = Object.assign(new FakeEventTarget(), {
      scrollLeft: 0,
      scrollTop: 40,
    });
    const selection = {
      cleanup: [],
      selector: scrollSelector(),
      context: {
        mutationRoots: [],
        resizeElements: [],
        scrollRoots: [scrollRoot],
      },
      mutationObserver: null,
      opener: null,
      ownershipObserver: null,
      resizeObserver: null,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    controller.selectionSession = selection;
    controller.attachSelectionSignals(selection);
    const listener = [...scrollRoot.listeners.get("scroll")][0];

    listener();
    assert.equal(controller.selectionSession, selection);

    scrollRoot.scrollTop = 50;
    listener();
    assert.equal(controller.selectionSession, null);
    assert.equal(controller.workspace.dataset.scrollModeLastExit, "scroll");
  } finally {
    restoreDom();
  }
});

test("active Scroll ignores its own movement and revalidates ancestor or sibling movement", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selected = Object.assign(new FakeEventTarget(), {
      scrollLeft: 0,
      scrollTop: 0,
    });
    const ancestor = Object.assign(new FakeEventTarget(), {
      scrollLeft: 0,
      scrollTop: 40,
    });
    const sibling = Object.assign(new FakeEventTarget(), {
      scrollLeft: 12,
      scrollTop: 0,
    });
    const session = {
      cleanup: [],
      context: { kind: "workspace", root: element(), hud: { close() {} } },
      mutationRoots: [],
      resizeElements: [],
      scrollRoots: [selected, ancestor, sibling],
      scrollport: selected,
    };
    const queued = [];
    controller.activeSession = session;
    controller.activeBindingIsCurrent = () => true;
    controller.queueActiveRevalidation = (candidate) => queued.push(candidate);
    controller.attachActiveSignals(session);

    assert.equal(selected.listenerCount("scroll"), 0);
    assert.equal(ancestor.listenerCount("scroll"), 1);
    assert.equal(sibling.listenerCount("scroll"), 1);

    selected.scrollLeft = 20;
    assert.deepEqual(queued, []);
    const ancestorListener = [...ancestor.listeners.get("scroll")][0];
    ancestorListener();
    assert.deepEqual(queued, []);
    ancestor.scrollTop = 60;
    ancestorListener();
    assert.deepEqual(queued, [session]);
    const siblingListener = [...sibling.listeners.get("scroll")][0];
    sibling.scrollLeft = 20;
    siblingListener();
    assert.deepEqual(queued, [session, session]);
  } finally {
    restoreDom();
  }
});

test("viewport signals ignore stale delivery and cancel real snapshot drift", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selection = {
      cleanup: [],
      selector: scrollSelector(),
      context: {
        mutationRoots: [],
        resizeElements: [],
        scrollRoots: [],
      },
      mutationObserver: null,
      opener: null,
      ownershipObserver: null,
      resizeObserver: null,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    controller.selectionSession = selection;
    controller.selectionSnapshotIsCurrent = () => true;
    controller.attachSelectionSignals(selection);
    const selectionResize = [...window.listeners.get("resize")][0];

    selectionResize();
    assert.equal(controller.selectionSession, selection);

    controller.selectionSnapshotIsCurrent = () => false;
    selectionResize();
    assert.equal(controller.selectionSession, null);
    assert.equal(controller.workspace.dataset.scrollModeLastExit, "viewport");

    const active = {
      cleanup: [],
      context: { kind: "workspace", hud: { close() {} }, root: element() },
      mutationRoots: [],
      ownershipObserver: null,
      resizeElements: [],
      resizeObserver: null,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = active;
    controller.activeBindingIsCurrent = () => true;
    controller.attachActiveSignals(active);
    const activeResize = [...window.listeners.get("resize")][0];

    activeResize();
    assert.equal(controller.activeSession, active);

    controller.activeBindingIsCurrent = () => false;
    activeResize();
    assert.equal(controller.activeSession, null);
    assert.equal(controller.workspace.dataset.scrollModeLastExit, "viewport");
  } finally {
    restoreDom();
  }
});

test("opening beforetoggle invalidates selection and active mode before selector state changes", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selection = {
      cleanup: [],
      selector: scrollSelector(),
      context: { mutationRoots: [], resizeElements: [], scrollRoots: [] },
      mutationObserver: null,
      opener: null,
      ownershipObserver: null,
      resizeObserver: null,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    controller.selectionSession = selection;
    controller.hasUnregisteredInteractionOwner = () => false;
    controller.attachSelectionSignals(selection);
    dispatchBeforeToggleOpen();
    assert.equal(controller.selectionSession, null);
    assert.equal(
      controller.workspace.dataset.scrollModeLastExit,
      "interaction-owner",
    );

    const active = {
      cleanup: [],
      context: { kind: "workspace", hud: { close() {} }, root: element() },
      mutationRoots: [],
      ownershipObserver: null,
      resizeElements: [],
      resizeObserver: null,
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = active;
    controller.activeBindingIsCurrent = () => true;
    controller.attachActiveSignals(active);
    dispatchBeforeToggleOpen();
    assert.equal(controller.activeSession, null);
    assert.equal(
      controller.workspace.dataset.scrollModeLastExit,
      "interaction-owner",
    );
  } finally {
    restoreDom();
  }
});

test("active revalidation keeps one binding and refreshes its retained presentation", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const root = element();
    const hud = element({ show() {}, close() {}, updateLabel() {} });
    const scrollport = element();
    const clipRoot = element();
    const viewport = {
      rect: rect(0, 0, 100, 100),
      scale: 1,
      devicePixelRatio: 2,
    };
    const context = {
      id: "workspace",
      kind: "workspace",
      root,
      hud,
    };
    const session = {
      id: "conversation",
      label: "Before",
      scrollport,
      axes: ["vertical"],
      availableAxes: ["vertical"],
      clipRoots: [clipRoot],
      visibleRect: rect(0, 0, 80, 80),
      context,
      contextRect: rect(0, 0, 100, 100),
      viewport,
    };
    const refreshed = [];
    controller.hasUnregisteredInteractionOwner = () => false;
    controller.resolveInteractionContext = () => context;
    controller.captureScrollSnapshot = () => ({
      context,
      contextRect: rect(0, 0, 90, 100),
      viewport,
      surfaces: [{
        id: "conversation",
        label: "After",
        scrollport,
        axes: ["vertical"],
        availableAxes: ["vertical"],
        clipRoots: [clipRoot],
        visibleRect: rect(0, 0, 70, 80),
      }],
    });
    controller.showActiveHud = (current) => {
      refreshed.push({
        label: current.label,
        visibleRect: current.visibleRect,
        contextRect: current.contextRect,
      });
      return true;
    };

    assert.equal(controller.activeBindingIsCurrent(session, {
      refreshPresentation: true,
    }), true);
    assert.deepEqual(refreshed, [{
      label: "After",
      visibleRect: rect(0, 0, 70, 80),
      contextRect: rect(0, 0, 90, 100),
    }]);
  } finally {
    restoreDom();
  }
});

function createController({ shortcutDialog = null } = {}) {
  const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
  return new KeyboardNavigationController({
    workspace,
    collectKeyboardNavigationContexts: () => [],
    shortcutDialog,
  });
}

function keyEvent(key, options = {}) {
  return {
    key,
    code: options.code ?? "",
    repeat: Boolean(options.repeat),
    ctrlKey: Boolean(options.ctrlKey),
    altKey: Boolean(options.altKey),
    metaKey: Boolean(options.metaKey),
    isComposing: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
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

  listenerCount(type = "") {
    if (type) {
      return this.listeners.get(type)?.size ?? 0;
    }
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0,
    );
  }
}

function installEventGlobals() {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const documentTarget = Object.assign(new FakeEventTarget(), {
    activeElement: null,
    documentElement: null,
    modal: null,
    modals: null,
    popover: null,
    querySelector(selector) {
      if (selector === "dialog:modal") {
        return this.modal;
      }
      if (selector === ":popover-open") {
        return this.popover;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "dialog:modal") {
        return this.modals ?? (this.modal ? [this.modal] : []);
      }
      if (selector === ":popover-open") {
        return this.popovers ?? (this.popover ? [this.popover] : []);
      }
      return [];
    },
  });
  const windowTarget = Object.assign(new FakeEventTarget(), {
    visualViewport: null,
  });
  globalThis.document = documentTarget;
  globalThis.window = windowTarget;
  return () => {
    restoreGlobal("document", previousDocument);
    restoreGlobal("window", previousWindow);
  };
}

function context(id, kind) {
  const root = element();
  const hud = element({ show() {}, close() {}, updateLabel() {} });
  const selector = scrollSelector();
  root.contains = (candidate) =>
    candidate === root || candidate === hud || candidate === selector;
  return {
    id,
    kind,
    root,
    scroll: {
      hud,
      selector,
      scope: {
        blocked: false,
        surfaces: [],
        mutationRoots: [],
        resizeElements: [],
        scrollRoots: [],
      },
    },
  };
}

function scrollSelector() {
  return element({
    open() {},
    close() {},
    ownsModal: () => false,
    allowsNativeActivation: () => false,
    updateInput() {},
    updateSurfaceLabels() {},
  });
}

function keyboardShortcutDialog({ onOpen = () => {} } = {}) {
  return element({
    openCalls: 0,
    closeCalls: 0,
    open() {
      this.openCalls += 1;
      onOpen();
      return true;
    },
    close() {
      this.closeCalls += 1;
      return true;
    },
    allowsNativeActivation: () => false,
  });
}

function element(properties = {}) {
  return Object.assign(new HTMLElement(), {
    closest: () => null,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
    }),
    getClientRects: () => [{}],
    matches: () => false,
    ...properties,
  });
}

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}

function dispatchBeforeToggleOpen() {
  const listeners = document.listeners.get("beforetoggle") ?? [];
  assert.equal(listeners.size, 1);
  for (const listener of listeners) {
    listener({ newState: "open", target: element() });
  }
}
