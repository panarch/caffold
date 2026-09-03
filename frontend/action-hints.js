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
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "./action-hints/control.js";
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
  reconcileActionHintTargets,
  rectsEqual,
  sameActionHintTargetBinding,
  sameActionHintViewport,
  sortByVisualOrder,
  taskHintSuffix,
  visibleTargetRect,
} from "./action-hints/model.js";

export {
  ACTION_HINT_ACTION,
  TASK_HINT_ALPHABET,
  advanceHintBuffer,
  buttonActionHintTarget,
  captureLinkActionHintBinding,
  clampBadgePosition,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  intersectRects,
  isEditableElement,
  linkActionHintTarget,
  linkActionHintLabel,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
  normalizeActionHintKey,
  normalizeMutationRootList,
  normalizeRect,
  radioActionHintTarget,
  rangeActionHintTarget,
  reconcileActionHintTargets,
  rectsEqual,
  reorderHandleActionHintTarget,
  sameActionHintTargetBinding,
  sameActionHintViewport,
  separatorActionHintTarget,
  sortByVisualOrder,
  selectActionHintTarget,
  switchActionHintTarget,
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
        this.cancel("no-match");
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
      observedMutationRoots: [],
      observedResizeElements: [],
      observedScrollRoots: [],
      ownershipObserver: null,
      revalidationQueued: false,
      resizeObserver: null,
      scrollCleanup: [],
    };
    this.session = session;
    try {
      this.attachDialogSignals(session);
      dialog.open(session.targets, session.viewport.rect);
      this.attachSessionSignals(session);
      if (!this.revalidateSnapshot(session, { refreshPresentation: true })) {
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
    const requestedTarget = session?.targets.find(
      (candidate) => candidate.code === code,
    );
    if (!session || !requestedTarget) {
      return false;
    }
    if (!this.closeSession(session)) {
      return false;
    }
    this.onSessionExit({ activated: true, target: requestedTarget });
    if (!this.revalidateSnapshot(session)) {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-invalidated";
      return false;
    }
    const target = session.targets.find(
      (candidate) => candidate.code === code,
    );
    if (!target) {
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
    const revalidateViewport = () => {
      if (
        this.session === session &&
        !sameActionHintViewport(session.viewport, captureViewport())
      ) {
        this.cancel("viewport");
      }
    };
    window.addEventListener("resize", revalidateViewport, { passive: true });
    window.addEventListener("scroll", revalidateViewport, { passive: true });
    session.cleanup.push(() => {
      window.removeEventListener("resize", revalidateViewport);
      window.removeEventListener("scroll", revalidateViewport);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", revalidateViewport, {
        passive: true,
      });
      window.visualViewport.addEventListener("scroll", revalidateViewport, {
        passive: true,
      });
      session.cleanup.push(() => {
        window.visualViewport.removeEventListener(
          "resize",
          revalidateViewport,
        );
        window.visualViewport.removeEventListener(
          "scroll",
          revalidateViewport,
        );
      });
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
    this.replaceRevalidationSignals(session);
  }

  detachSessionSignals(session) {
    this.detachRevalidationSignals(session);
    session.ownershipObserver?.disconnect();
    session.ownershipObserver = null;
    for (const cleanup of session.cleanup ?? []) {
      cleanup();
    }
    session.cleanup = [];
  }

  detachRevalidationSignals(session) {
    session.mutationObserver?.disconnect();
    session.resizeObserver?.disconnect();
    for (const cleanup of session.scrollCleanup ?? []) {
      cleanup();
    }
    session.mutationObserver = null;
    session.resizeObserver = null;
    session.scrollCleanup = [];
    session.observedMutationRoots = [];
    session.observedResizeElements = [];
    session.observedScrollRoots = [];
  }

  replaceRevalidationSignals(session) {
    if (
      sameElementCollection(
        session.observedMutationRoots,
        session.mutationRoots,
      ) &&
      sameElementCollection(
        session.observedResizeElements,
        session.resizeElements,
      ) &&
      sameElementCollection(session.observedScrollRoots, session.scrollRoots)
    ) {
      return;
    }
    this.detachRevalidationSignals(session);
    const revalidate = () => this.queueRevalidation(session);
    if (typeof MutationObserver === "function" && session.mutationRoots.length) {
      session.mutationObserver = new MutationObserver((records) => {
        if (records.every((record) => session.dialog.contains?.(record.target))) {
          return;
        }
        revalidate();
      });
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
    for (const root of session.scrollRoots) {
      root.addEventListener("scroll", revalidate, { passive: true });
      session.scrollCleanup.push(() =>
        root.removeEventListener("scroll", revalidate)
      );
    }
    session.observedMutationRoots = [...session.mutationRoots];
    session.observedResizeElements = [...session.resizeElements];
    session.observedScrollRoots = [...session.scrollRoots];
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
        !this.revalidateSnapshot(session, { refreshPresentation: true })
      ) {
        this.cancel("snapshot-invalidated");
      }
    });
  }

  revalidateSnapshot(snapshot, { refreshPresentation = false } = {}) {
    try {
      return this.reconcileSnapshot(snapshot, { refreshPresentation });
    } catch {
      return false;
    }
  }

  reconcileSnapshot(snapshot, { refreshPresentation = false } = {}) {
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
    const current = this.captureScopeState(scope);
    if (
      !current ||
      !sameActionHintViewport(snapshot.viewport, current.viewport)
    ) {
      return false;
    }
    const reconciliation = reconcileActionHintTargets(
      snapshot.targets,
      current.descriptorStates,
    );
    if (!reconciliation?.targets.length) {
      return false;
    }
    const presentation = advanceHintBuffer(
      snapshot.buffer,
      "",
      reconciliation.targets.map(({ code }) => code),
    );
    if (!presentation.matches.length) {
      return false;
    }
    snapshot.targets = reconciliation.targets;
    snapshot.mutationRoots = current.mutationRoots;
    snapshot.scrollRoots = current.scrollRoots;
    snapshot.resizeElements = uniqueElements(
      reconciliation.targets.flatMap(({ anchor, clipRoots }) => [
        anchor,
        ...clipRoots,
      ]),
    );
    if (this.session === snapshot) {
      this.replaceRevalidationSignals(snapshot);
    }
    if (refreshPresentation) {
      const dialog = snapshot.binding?.dialog ?? this.dialog;
      if (!dialog.reconcileTargets(snapshot.targets, snapshot.viewport.rect)) {
        return false;
      }
      dialog.updateInput(presentation);
    }
    return true;
  }

  captureSnapshot(scope) {
    let state;
    try {
      state = this.captureScopeState(scope);
    } catch {
      return null;
    }
    if (!state) {
      return null;
    }
    const { descriptorStates, ...snapshot } = state;
    let targets;
    try {
      targets = allocateActionHintCodes(sortByVisualOrder(
        descriptorStates.filter(
          ({ actionable, visibleRect }) => actionable && visibleRect,
        ),
      ));
    } catch {
      return null;
    }
    return { ...snapshot, targets };
  }

  captureScopeState(scope) {
    const descriptors = normalizeDescriptors(scope.targets);
    const mutationRoots = normalizeMutationRootList(scope.mutationRoots ?? []);
    const scrollRoots = normalizeElementList(scope.scrollRoots ?? []);
    if (!descriptors || !mutationRoots || !scrollRoots) {
      return null;
    }
    const viewport = captureViewport();
    const descriptorStates = descriptors.map((descriptor) => {
      const actionable = descriptorIsActionable(descriptor);
      const anchorRect = actionable
        ? normalizeRect(descriptor.anchor.getBoundingClientRect())
        : null;
      const clipRects = actionable
        ? descriptor.clipRoots.map((root) => root.getBoundingClientRect())
        : [];
      return {
        ...descriptor,
        actionable,
        visibleRect: actionable
          ? visibleTargetRect(anchorRect, clipRects, viewport.rect)
          : null,
      };
    });
    const dependencyElements = uniqueElements(
      descriptors.flatMap(({ clipRoots }) => clipRoots),
    );
    return {
      descriptorStates,
      viewport,
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

function normalizeMutationRootList(roots) {
  if (
    !Array.isArray(roots) ||
    roots.some(
      (root) =>
        !(root instanceof Element) &&
        !(typeof ShadowRoot === "function" && root instanceof ShadowRoot),
    )
  ) {
    return null;
  }
  return uniqueValues(roots);
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
    const activationKey = target?.activationKey == null
      ? ""
      : `${target.activationKey}`;
    if (
      !id ||
      ids.has(id) ||
      !actionId ||
      !label ||
      !matchesActionHintPolicy({
        actionId,
        controlKind: target?.controlKind,
      }) ||
      (target?.controlKind === "link" && !activationKey) ||
      !(target?.invalidationOwner instanceof Element) ||
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
      activationKey,
      clipRoots,
    });
  }
  return descriptors;
}

function descriptorIsActionable(descriptor) {
  try {
    return Boolean(
      descriptor.invalidationOwner.isConnected &&
        descriptor.control.isConnected &&
        descriptor.anchor.isConnected &&
        !descriptor.control.disabled &&
        descriptor.isActionable(),
    );
  } catch {
    return false;
  }
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
    scrollLeft: Number(
      window.scrollX ?? document.scrollingElement?.scrollLeft ?? 0,
    ),
    scrollTop: Number(
      window.scrollY ?? document.scrollingElement?.scrollTop ?? 0,
    ),
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

function uniqueValues(values) {
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function sameElementCollection(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return left.length === right.length && left.every(
    (element) => right.includes(element),
  );
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
