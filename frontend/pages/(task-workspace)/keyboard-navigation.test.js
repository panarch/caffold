import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

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
    assert.equal(controller.scrollSelector.listenerCount(), 0);
    assert.equal(window.listenerCount(), 0);
    assert.equal(controller.actionHints.connected, false);
  } finally {
    restoreDom();
  }
});

test("entry uses 0, 1, many policy without nesting a modal selector", () => {
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
    };
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE;
    controller.activeSession = { scrollport };
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

    const modified = keyEvent("j", { code: "KeyJ", ctrlKey: true });
    controller.handleActiveKeydown(modified);
    assert.equal(scrollport.scrollTop, 400);
    assert.equal(modified.prevented, false);
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

test("Scroll selection keeps F as surface-code input", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    let selectionInput = null;
    controller.storedNode = KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING;
    controller.applySelectionInput = (key) => {
      selectionInput = key;
    };
    const selecting = keyEvent("f", { code: "KeyF" });
    controller.handleKeydown(selecting);
    assert.equal(selectionInput, "F");
    assert.equal(
      controller.storedNode,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
    );
    assert.equal(selecting.prevented, true);
    assert.equal(selecting.stopped, true);
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
    const scrollport = element();
    const surface = {
      id: "same",
      label: "Surface",
      scrollport,
      clipRoots: [],
      isEligible: () => true,
    };
    controller.collectKeyboardNavigationContexts = () => [{
      id: "workspace",
      kind: "workspace",
      root,
      scroll: {
        hud,
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

test("opening beforetoggle invalidates selection and active mode before selector state changes", () => {
  const restoreDom = installEventGlobals();
  try {
    const controller = createController();
    const selection = {
      cleanup: [],
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

function createController() {
  const workspace = Object.assign(new FakeEventTarget(), { dataset: {} });
  const actionHintDialog = Object.assign(new FakeEventTarget(), {
    ownsModal: () => false,
  });
  const scrollSelector = Object.assign(new FakeEventTarget(), {
    ownsModal: () => false,
    allowsNativeActivation: () => false,
    close() {},
  });
  return new KeyboardNavigationController({
    workspace,
    actionHintDialog,
    scrollSelector,
    collectKeyboardNavigationContexts: () => [],
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
  root.contains = (candidate) => candidate === root || candidate === hud;
  return {
    id,
    kind,
    root,
    scroll: {
      hud,
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
