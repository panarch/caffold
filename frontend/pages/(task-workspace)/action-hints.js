import { getSettings } from "../../settings.js";
import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
} from "../../action-hint-scope.js";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
  ACTION_HINT_CONTROL_EVENT,
  ACTION_HINT_CONTROL_NODE,
  transitionActionHintControl,
} from "./action-hints/control.js";
import {
  ACTION_HINT_ACTION,
  advanceHintBuffer,
  allocateActionHintCodes,
  isEditableElement,
  matchesActionHintPolicy,
  normalizeActionHintKey,
  normalizeRect,
  sameActionHintSnapshot,
  sortByVisualOrder,
  visibleTargetRect,
} from "./action-hints/model.js";

export {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
};

export class ActionHintController {
  constructor({
    workspace,
    dialog,
    collectScope,
    editingEscapeTarget = () => null,
    afterActivation = () => {},
  }) {
    this.workspace = workspace;
    this.dialog = dialog;
    this.collectScope = collectScope;
    this.editingEscapeTarget = editingEscapeTarget;
    this.afterActivation = afterActivation;
    this.connected = false;
    this.compositionActive = false;
    this.compositionOwner = null;
    this.session = null;
    this.boundKeydown = (event) => this.handleKeydown(event);
    this.boundCompositionStart = (event) => {
      this.compositionActive = true;
      this.compositionOwner = event.target;
    };
    this.boundCompositionEnd = () => {
      this.clearComposition();
    };
    this.boundFocusOut = (event) => {
      if (event.target === this.compositionOwner) {
        this.clearComposition();
      }
    };
    this.boundActivate = (event) => {
      event.stopPropagation();
      this.activate(event.detail?.code);
    };
    this.boundCancel = (event) => {
      event.stopPropagation();
      if (
        event.detail?.reason === "escape" &&
        (this.compositionActive || event.detail?.originalEvent?.isComposing)
      ) {
        return;
      }
      this.cancel(event.detail?.reason ?? "dialog");
    };
    this.boundSettingsChange = (event) => {
      if (
        this.session &&
        event.detail?.settings?.actionHintsEnabled === false
      ) {
        this.cancel("setting-disabled");
      }
    };
  }

  connect() {
    if (this.connected) {
      return;
    }
    this.connected = true;
    document.addEventListener("keydown", this.boundKeydown, true);
    this.workspace.addEventListener(
      "compositionstart",
      this.boundCompositionStart,
      true,
    );
    this.workspace.addEventListener(
      "compositionend",
      this.boundCompositionEnd,
      true,
    );
    this.workspace.addEventListener("focusout", this.boundFocusOut, true);
    this.dialog.addEventListener(ACTION_HINT_ACTIVATE_EVENT, this.boundActivate);
    this.dialog.addEventListener(ACTION_HINT_CANCEL_EVENT, this.boundCancel);
    window.addEventListener("caffold:settings-change", this.boundSettingsChange);
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.cancel("disconnect", { restoreFocus: false });
    this.connected = false;
    this.clearComposition();
    document.removeEventListener("keydown", this.boundKeydown, true);
    this.workspace.removeEventListener(
      "compositionstart",
      this.boundCompositionStart,
      true,
    );
    this.workspace.removeEventListener(
      "compositionend",
      this.boundCompositionEnd,
      true,
    );
    this.workspace.removeEventListener("focusout", this.boundFocusOut, true);
    this.dialog.removeEventListener(
      ACTION_HINT_ACTIVATE_EVENT,
      this.boundActivate,
    );
    this.dialog.removeEventListener(ACTION_HINT_CANCEL_EVENT, this.boundCancel);
    window.removeEventListener(
      "caffold:settings-change",
      this.boundSettingsChange,
    );
  }

  routeWillChange() {
    this.clearComposition();
    this.cancel("route", { restoreFocus: false });
  }

  handleKeydown(event) {
    if (this.session) {
      this.handleHintKeydown(event);
      return;
    }
    if (getSettings().actionHintsEnabled === false) {
      return;
    }
    const editable = editableOwner(event.target) ?? editableOwner(
      document.activeElement,
    );
    if (editable) {
      if (
        event.key === "Escape" &&
        !event.isComposing &&
        !this.compositionActive &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !this.hasOtherInteractionOwner()
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.leaveEditing(editable);
      }
      return;
    }
    if (
      normalizeActionHintKey(event, {
        compositionActive: this.compositionActive,
      }) !== "F" ||
      this.hasOtherInteractionOwner()
    ) {
      return;
    }
    const scope = this.safeCollectScope();
    if (!scope || scope.blocked) {
      return;
    }
    const snapshot = this.captureSnapshot(scope);
    if (!snapshot?.targets.length) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.startSession(snapshot);
  }

  handleHintKeydown(event) {
    if (
      event.isComposing ||
      this.compositionActive ||
      event.repeat ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    if (this.dialog.allowsNativeActivation(event)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.cancel("escape");
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      this.applyInput("Backspace");
      return;
    }
    const key = normalizeActionHintKey(event);
    if (!key) {
      if (`${event.key ?? ""}`.length === 1) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.applyInput(key);
  }

  applyInput(key) {
    const session = this.session;
    if (
      !session ||
      !this.applyControlTransition(
        ACTION_HINT_CONTROL_EVENT.HINT_INPUT_CHANGED,
      )
    ) {
      return;
    }
    const progression = advanceHintBuffer(
      session.buffer,
      key,
      session.targets.map(({ code }) => code),
    );
    session.buffer = progression.buffer;
    this.dialog.updateInput(progression);
    if (progression.exact) {
      this.activate(progression.exact);
    }
  }

  startSession(snapshot) {
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const session = {
      ...snapshot,
      opener,
      buffer: "",
      cleanup: [],
      mutationObserver: null,
      ownershipObserver: null,
      revalidationQueued: false,
      resizeObserver: null,
    };
    if (
      !this.applyControlTransition(
        ACTION_HINT_CONTROL_EVENT.HINT_STARTED,
        { nextSession: session },
      )
    ) {
      return;
    }
    try {
      this.dialog.open(session.targets, session.viewport.rect);
      this.attachSessionSignals(session);
      if (!this.snapshotIsCurrent(session, { refreshPresentation: true })) {
        this.cancel("snapshot-invalidated");
      }
    } catch {
      if (this.closeSession(
        session,
        ACTION_HINT_CONTROL_EVENT.HINT_CANCELLED,
      )) {
        this.restoreFocus(opener);
      }
    }
  }

  cancel(reason = "cancel", { restoreFocus = true } = {}) {
    const session = this.session;
    if (!session) {
      return false;
    }
    if (!this.closeSession(
      session,
      ACTION_HINT_CONTROL_EVENT.HINT_CANCELLED,
    )) {
      return false;
    }
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    this.workspace.dataset.actionHintLastExit = reason;
    return true;
  }

  activate(code) {
    const session = this.session;
    const target = session?.targets.find((candidate) => candidate.code === code);
    if (!session || !target) {
      return false;
    }
    if (!this.closeSession(
      session,
      ACTION_HINT_CONTROL_EVENT.HINT_CLOSED_FOR_ACTIVATION,
    )) {
      return false;
    }
    if (!this.snapshotIsCurrent(session)) {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-invalidated";
      return false;
    }
    try {
      target.activate();
      this.afterActivation(target);
      this.workspace.dataset.actionHintLastExit = `activated:${target.code}`;
      return true;
    } catch {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-failed";
      return false;
    }
  }

  leaveEditing(editable) {
    if (
      !this.applyControlTransition(
        ACTION_HINT_CONTROL_EVENT.EDITING_ENDED,
        { editable },
      )
    ) {
      return;
    }
    const target = this.editingEscapeTarget(editable);
    if (focusableTarget(target)) {
      target.focus({ preventScroll: true });
    } else {
      editable.blur?.();
    }
  }

  restoreFocus(element) {
    if (!focusableTarget(element)) {
      return;
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      // A control can become non-focusable between validation and focus.
    }
  }

  applyControlTransition(event, { editable = null, nextSession } = {}) {
    const current = this.controlNode(editable);
    const next = transitionActionHintControl(current, event);
    if (!next) {
      return null;
    }
    if (next === ACTION_HINT_CONTROL_NODE.HINT) {
      const session = nextSession ?? this.session;
      if (!session) {
        return null;
      }
      this.session = session;
    } else if (current === ACTION_HINT_CONTROL_NODE.HINT) {
      this.session = null;
    }
    return { current, next };
  }

  controlNode(editable = null) {
    if (this.session) {
      return ACTION_HINT_CONTROL_NODE.HINT;
    }
    if (
      this.compositionActive ||
      editable ||
      editableOwner(document.activeElement)
    ) {
      return ACTION_HINT_CONTROL_NODE.EDITING;
    }
    return ACTION_HINT_CONTROL_NODE.NORMAL;
  }

  closeSession(session, event) {
    if (
      this.session !== session ||
      !this.applyControlTransition(event)
    ) {
      return false;
    }
    this.detachSessionSignals(session);
    this.dialog.close();
    return true;
  }

  clearComposition() {
    this.compositionActive = false;
    this.compositionOwner = null;
  }

  attachSessionSignals(session) {
    const cancelOnScroll = () => this.cancel("scroll");
    for (const root of session.scrollRoots) {
      root.addEventListener("scroll", cancelOnScroll, { passive: true });
      session.cleanup.push(() => root.removeEventListener("scroll", cancelOnScroll));
    }
    const cancelOnViewportChange = () => this.cancel("viewport");
    window.addEventListener("resize", cancelOnViewportChange, { passive: true });
    window.addEventListener("scroll", cancelOnViewportChange, { passive: true });
    session.cleanup.push(() => {
      window.removeEventListener("resize", cancelOnViewportChange);
      window.removeEventListener("scroll", cancelOnViewportChange);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", cancelOnViewportChange, {
        passive: true,
      });
      window.visualViewport.addEventListener("scroll", cancelOnViewportChange, {
        passive: true,
      });
      session.cleanup.push(() => {
        window.visualViewport.removeEventListener(
          "resize",
          cancelOnViewportChange,
        );
        window.visualViewport.removeEventListener(
          "scroll",
          cancelOnViewportChange,
        );
      });
    }

    const revalidate = () => this.queueRevalidation(session);
    if (typeof MutationObserver === "function" && session.mutationRoots.length) {
      session.mutationObserver = new MutationObserver(revalidate);
      for (const root of session.mutationRoots) {
        session.mutationObserver.observe(root, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    if (typeof ResizeObserver === "function") {
      session.resizeObserver = new ResizeObserver(revalidate);
      for (const element of session.resizeElements) {
        session.resizeObserver.observe(element);
      }
    }
    if (typeof MutationObserver === "function" && document.documentElement) {
      session.ownershipObserver = new MutationObserver(() => {
        if (this.hasOtherInteractionOwner()) {
          this.cancel("interaction-owner");
        }
      });
      session.ownershipObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["open"],
        subtree: true,
      });
    }
    const handleBeforeToggle = (event) => {
      if (
        event.newState === "open" &&
        !this.dialog.contains(event.target)
      ) {
        this.cancel("interaction-owner");
      }
    };
    document.addEventListener("beforetoggle", handleBeforeToggle, true);
    session.cleanup.push(() =>
      document.removeEventListener("beforetoggle", handleBeforeToggle, true)
    );
  }

  detachSessionSignals(session) {
    session.mutationObserver?.disconnect();
    session.ownershipObserver?.disconnect();
    session.resizeObserver?.disconnect();
    for (const cleanup of session.cleanup ?? []) {
      cleanup();
    }
    session.cleanup = [];
  }

  queueRevalidation(session) {
    if (this.session !== session || session.revalidationQueued) {
      return;
    }
    session.revalidationQueued = true;
    queueMicrotask(() => {
      session.revalidationQueued = false;
      if (
        this.session === session &&
        !this.snapshotIsCurrent(session, { refreshPresentation: true })
      ) {
        this.cancel("snapshot-invalidated");
      }
    });
  }

  snapshotIsCurrent(snapshot, { refreshPresentation = false } = {}) {
    if (this.hasOtherInteractionOwner()) {
      return false;
    }
    const scope = this.safeCollectScope();
    if (!scope || scope.blocked) {
      return false;
    }
    const current = this.captureSnapshot(scope);
    if (!current || !sameActionHintSnapshot(snapshot, current)) {
      return false;
    }
    if (refreshPresentation) {
      this.refreshSnapshotPresentation(snapshot, current);
    }
    return true;
  }

  refreshSnapshotPresentation(snapshot, current) {
    const changed = [];
    for (const [index, target] of snapshot.targets.entries()) {
      const label = current.targets[index]?.label;
      if (!label || target.label === label) {
        continue;
      }
      // Binding equality was already validated; only its presented name moves.
      target.label = label;
      changed.push(target);
    }
    if (changed.length) {
      this.dialog.updateTargetLabels(changed);
    }
  }

  captureSnapshot(scope) {
    const descriptors = normalizeDescriptors(scope.targets);
    const mutationRoots = normalizeElementList(scope.mutationRoots ?? []);
    const scrollRoots = normalizeElementList(scope.scrollRoots ?? []);
    if (!descriptors || !mutationRoots || !scrollRoots) {
      return null;
    }
    const viewport = captureViewport();
    const descriptorStates = descriptors.map((descriptor) => ({
      actionable: descriptorIsActionable(descriptor),
      descriptor,
    }));
    const topology = descriptorStates.map(({ actionable, descriptor }) =>
      topologyEntry(descriptor, actionable)
    );
    const visible = [];
    for (const { actionable, descriptor } of descriptorStates) {
      if (!actionable) {
        continue;
      }
      const anchorRect = normalizeRect(descriptor.anchor.getBoundingClientRect());
      const clipRects = descriptor.clipRoots.map((root) =>
        root.getBoundingClientRect()
      );
      const targetRect = visibleTargetRect(
        anchorRect,
        clipRects,
        viewport.rect,
      );
      if (!targetRect) {
        continue;
      }
      visible.push({
        ...descriptor,
        anchorRect,
        visibleRect: targetRect,
      });
    }
    let targets;
    try {
      targets = allocateActionHintCodes(sortByVisualOrder(visible));
    } catch {
      return null;
    }
    const dependencyElements = uniqueElements(
      descriptors.flatMap(({ clipRoots }) => clipRoots),
    );
    return {
      topology,
      targets,
      viewport,
      dependencies: dependencyElements.map((element) => ({
        element,
        rect: normalizeRect(element.getBoundingClientRect()),
      })),
      mutationRoots,
      scrollRoots,
      resizeElements: uniqueElements([
        ...descriptors.map(({ anchor }) => anchor),
        ...dependencyElements,
      ]),
    };
  }

  safeCollectScope() {
    try {
      return this.collectScope() ?? null;
    } catch {
      return null;
    }
  }

  hasOtherInteractionOwner() {
    const modal = document.querySelector("dialog:modal");
    if (modal && !this.dialog.ownsModal(modal)) {
      return true;
    }
    return Boolean(document.querySelector(":popover-open"));
  }
}

function normalizeDescriptors(targets) {
  if (!Array.isArray(targets)) {
    return null;
  }
  const ids = new Set();
  const descriptors = [];
  for (const target of targets) {
    const id = `${target?.id ?? ""}`;
    const actionId = `${target?.actionId ?? ""}`;
    const label = `${target?.label ?? ""}`;
    if (
      !id ||
      ids.has(id) ||
      !actionId ||
      !label ||
      !matchesActionHintPolicy({
        actionId,
        controlKind: target?.controlKind,
      }) ||
      !(target?.control instanceof HTMLElement) ||
      !(target?.anchor instanceof HTMLElement) ||
      typeof target?.isActionable !== "function" ||
      typeof target?.activate !== "function"
    ) {
      return null;
    }
    const clipRoots = normalizeElementList(target.clipRoots ?? []);
    if (!clipRoots) {
      return null;
    }
    ids.add(id);
    descriptors.push({
      ...target,
      id,
      actionId,
      label,
      clipRoots,
    });
  }
  return descriptors;
}

function descriptorIsActionable(descriptor) {
  try {
    return Boolean(
      descriptor.control.isConnected &&
        descriptor.anchor.isConnected &&
        !descriptor.control.disabled &&
        descriptor.isActionable(),
    );
  } catch {
    return false;
  }
}

function topologyEntry(descriptor, actionable) {
  return {
    id: descriptor.id,
    actionId: descriptor.actionId,
    controlKind: descriptor.controlKind,
    actionable,
    control: descriptor.control,
    anchor: descriptor.anchor,
    clipRoots: descriptor.clipRoots,
  };
}

function captureViewport() {
  const visual = window.visualViewport;
  const left = Number(visual?.offsetLeft ?? 0);
  const top = Number(visual?.offsetTop ?? 0);
  const width = Number(
    visual?.width ?? document.documentElement?.clientWidth ?? window.innerWidth,
  );
  const height = Number(
    visual?.height ?? document.documentElement?.clientHeight ?? window.innerHeight,
  );
  return {
    rect: normalizeRect({
      left,
      top,
      right: left + width,
      bottom: top + height,
    }),
    scale: Number(visual?.scale ?? 1),
    devicePixelRatio: Number(window.devicePixelRatio ?? 1),
  };
}

function uniqueElements(elements) {
  const unique = [];
  const seen = new Set();
  for (const element of elements) {
    if (!element || typeof element.getBoundingClientRect !== "function") {
      continue;
    }
    if (!seen.has(element)) {
      seen.add(element);
      unique.push(element);
    }
  }
  return unique;
}

function normalizeElementList(elements) {
  if (
    !Array.isArray(elements) ||
    elements.some(
      (element) =>
        !(element instanceof Element) ||
        typeof element.getBoundingClientRect !== "function",
    )
  ) {
    return null;
  }
  return uniqueElements(elements);
}

function editableOwner(element) {
  if (!(element instanceof Element)) {
    return null;
  }
  if (isEditableElement(element)) {
    return element;
  }
  const owner = element.closest(
    "[contenteditable]:not([contenteditable='false'])",
  );
  return isEditableElement(owner) ? owner : null;
}

function focusableTarget(element) {
  return Boolean(
    element instanceof HTMLElement &&
      element.isConnected &&
      !element.hidden &&
      !element.disabled &&
      element.getClientRects().length,
  );
}
