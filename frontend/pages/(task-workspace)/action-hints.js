import {
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  mergeActionHintScopes,
  selectActionHintTarget,
  textboxActionHintTarget,
} from "../../action-hint-scope.js";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "./action-hints/control.js";
import { normalizeMutationRootList } from "./keyboard-navigation-context.js";
import {
  ACTION_HINT_ACTION,
  TASK_HINT_ALPHABET,
  advanceHintBuffer,
  allocateActionHintCodes,
  clampBadgePosition,
  intersectRects,
  isEditableElement,
  matchesActionHintPolicy,
  normalizeActionHintKey,
  normalizeRect,
  rectsEqual,
  sameActionHintSnapshot,
  sortByVisualOrder,
  taskHintSuffix,
  visibleTargetRect,
} from "./action-hints/model.js";

export {
  ACTION_HINT_ACTION,
  TASK_HINT_ALPHABET,
  advanceHintBuffer,
  buttonActionHintTarget,
  clampBadgePosition,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  intersectRects,
  isEditableElement,
  mergeActionHintScopes,
  normalizeActionHintKey,
  normalizeRect,
  rectsEqual,
  sortByVisualOrder,
  selectActionHintTarget,
  taskHintSuffix,
  textboxActionHintTarget,
};

export class ActionHintController {
  constructor({
    workspace,
    dialog,
    collectScope,
    collectBinding = null,
    afterActivation = () => {},
    hasOtherInteractionOwner = () => false,
    isCompositionActive = () => false,
    onSessionExit = () => {},
  }) {
    this.workspace = workspace;
    this.dialog = dialog;
    this.collectScope = collectScope;
    this.collectBinding = collectBinding;
    this.afterActivation = afterActivation;
    this.hasOtherInteractionOwner = hasOtherInteractionOwner;
    this.isCompositionActive = isCompositionActive;
    this.onSessionExit = onSessionExit;
    this.connected = false;
    this.session = null;
    this.boundActivate = (event) => {
      event.stopPropagation();
      this.activate(event.detail?.code);
    };
    this.boundCancel = (event) => {
      event.stopPropagation();
      if (
        event.detail?.reason === "escape" &&
        (this.isCompositionActive() ||
          event.detail?.originalEvent?.isComposing)
      ) {
        return;
      }
      this.cancel(event.detail?.reason ?? "dialog");
    };
  }

  connect() {
    if (this.connected) {
      return;
    }
    this.connected = true;
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.cancel("disconnect", { restoreFocus: false });
    this.connected = false;
  }

  prepareSnapshot() {
    const binding = this.safeCollectBinding();
    const scope = binding?.scope;
    if (!scope || scope.blocked) {
      return null;
    }
    const snapshot = this.captureSnapshot(scope);
    return snapshot?.targets.length ? { ...snapshot, binding } : null;
  }

  handleHintKeydown(event, { compositionActive = false } = {}) {
    if (
      event.isComposing ||
      compositionActive ||
      event.repeat ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }
    const dialog = this.session?.dialog ?? this.dialog;
    if (dialog?.allowsNativeActivation(event)) {
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
    if (!session) {
      return;
    }
    const progression = advanceHintBuffer(
      session.buffer,
      key,
      session.targets.map(({ code }) => code),
    );
    if (progression.status === "no-match") {
      this.cancel("no-match");
      return;
    }
    session.buffer = progression.buffer;
    session.dialog.updateInput(progression);
    if (progression.exact) {
      this.activate(progression.exact);
    }
  }

  startSession(snapshot) {
    if (this.session || !snapshot?.targets?.length) {
      return false;
    }
    const binding = snapshot.binding ?? {
      context: null,
      dialog: this.dialog,
      scope: null,
    };
    const dialog = binding?.dialog;
    if (!dialog) {
      return false;
    }
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const session = {
      ...snapshot,
      binding,
      dialog,
      opener,
      buffer: "",
      cleanup: [],
      mutationObserver: null,
      ownershipObserver: null,
      revalidationQueued: false,
      resizeObserver: null,
    };
    this.session = session;
    try {
      this.attachDialogSignals(session);
      dialog.open(session.targets, session.viewport.rect);
      this.attachSessionSignals(session);
      if (!this.snapshotIsCurrent(session, { refreshPresentation: true })) {
        this.cancel("snapshot-invalidated");
      }
      return this.session === session;
    } catch {
      if (this.closeSession(session)) {
        this.restoreFocus(opener);
        this.onSessionExit({ activated: false, reason: "open-failed" });
      }
      return false;
    }
  }

  cancel(reason = "cancel", { restoreFocus = true } = {}) {
    const session = this.session;
    if (!session) {
      return false;
    }
    if (!this.closeSession(session)) {
      return false;
    }
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    this.workspace.dataset.actionHintLastExit = reason;
    this.onSessionExit({ activated: false, reason });
    return true;
  }

  activate(code) {
    const session = this.session;
    const target = session?.targets.find((candidate) => candidate.code === code);
    if (!session || !target) {
      return false;
    }
    if (!this.closeSession(session)) {
      return false;
    }
    this.onSessionExit({ activated: true, target });
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

  closeSession(session) {
    if (this.session !== session) {
      return false;
    }
    this.session = null;
    this.detachSessionSignals(session);
    session.dialog.close();
    return true;
  }

  attachDialogSignals(session) {
    session.dialog.addEventListener(
      ACTION_HINT_ACTIVATE_EVENT,
      this.boundActivate,
    );
    session.dialog.addEventListener(ACTION_HINT_CANCEL_EVENT, this.boundCancel);
    session.cleanup.push(() => {
      session.dialog.removeEventListener(
        ACTION_HINT_ACTIVATE_EVENT,
        this.boundActivate,
      );
      session.dialog.removeEventListener(
        ACTION_HINT_CANCEL_EVENT,
        this.boundCancel,
      );
    });
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
        if (this.hasOtherInteractionOwner(session.binding ?? null)) {
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
        event.newState === "closed" &&
        event.target === session.binding?.context?.root
      ) {
        this.cancel("context-closed", { restoreFocus: false });
        return;
      }
      if (
        event.newState === "open" &&
        !session.dialog.contains?.(event.target)
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
    if (this.hasOtherInteractionOwner(snapshot.binding ?? null)) {
      return false;
    }
    const binding = snapshot.binding ? this.safeCollectBinding() : null;
    if (snapshot.binding && !sameActionHintBinding(snapshot.binding, binding)) {
      return false;
    }
    const scope = binding?.scope ?? this.safeCollectScope();
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
      (snapshot.binding?.dialog ?? this.dialog).updateTargetLabels(changed);
    }
  }

  captureSnapshot(scope) {
    const descriptors = normalizeDescriptors(scope.targets);
    const mutationRoots = normalizeMutationRootList(scope.mutationRoots ?? []);
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

  safeCollectBinding() {
    if (typeof this.collectBinding !== "function") {
      const scope = this.safeCollectScope();
      return scope && this.dialog
        ? { context: null, dialog: this.dialog, scope }
        : null;
    }
    try {
      const binding = this.collectBinding();
      return binding?.dialog && binding?.scope ? binding : null;
    } catch {
      return null;
    }
  }

}

function sameActionHintBinding(left, right) {
  if (!left || !right || left.dialog !== right.dialog) {
    return false;
  }
  if (!left.context || !right.context) {
    return left.context === right.context;
  }
  return Boolean(
    left.context.id === right.context.id &&
      left.context.kind === right.context.kind &&
      left.context.root === right.context.root,
  );
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

function focusableTarget(element) {
  return Boolean(
    element instanceof HTMLElement &&
      element.isConnected &&
      !element.hidden &&
      !element.disabled &&
      element.getClientRects().length,
  );
}
