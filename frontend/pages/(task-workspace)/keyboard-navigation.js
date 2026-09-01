import { getSettings } from "../../settings.js";
import {
  ActionHintController,
  advanceHintBuffer,
  isEditableElement,
  normalizeActionHintKey,
  normalizeRect,
  rectsEqual,
} from "./action-hints.js";
import { hasVerticalScrollOverflow } from "./scroll-scope.js";
import {
  KEYBOARD_NAVIGATION_EVENT,
  KEYBOARD_NAVIGATION_NODE,
  transitionKeyboardNavigation,
} from "./keyboard-navigation/control.js";
import {
  allocateScrollSurfaceCodes,
  normalizedContextRect,
  orderScrollSurfaces,
  sameActiveScrollBinding,
  sameScrollSelectionSnapshot,
  scrollCommandPosition,
  visibleScrollSurfaceRect,
} from "./keyboard-navigation/model.js";
import {
  SCROLL_SURFACE_CANCEL_EVENT,
  SCROLL_SURFACE_SELECT_EVENT,
} from "./keyboard-navigation/components/selector.js";
import "./keyboard-navigation/components/hud.js";

export class KeyboardNavigationController {
  constructor({
    workspace,
    actionHintDialog,
    scrollSelector,
    collectActionHintScope,
    collectScrollContexts,
    editingEscapeTarget = () => null,
    afterActionHintActivation = () => {},
  }) {
    this.workspace = workspace;
    this.scrollSelector = scrollSelector;
    this.collectScrollContexts = collectScrollContexts;
    this.editingEscapeTarget = editingEscapeTarget;
    this.connected = false;
    this.compositionActive = false;
    this.compositionOwner = null;
    this.storedNode = null;
    this.selectionSession = null;
    this.activeSession = null;
    this.actionHints = new ActionHintController({
      workspace,
      dialog: actionHintDialog,
      collectScope: collectActionHintScope,
      afterActivation: afterActionHintActivation,
      hasOtherInteractionOwner: () => this.hasHintInteractionOwner(),
      isCompositionActive: () => this.compositionActive,
      onSessionExit: (detail) => this.handleHintSessionExit(detail),
    });
    this.boundKeydown = (event) => this.handleKeydown(event);
    this.boundCompositionStart = (event) => {
      this.compositionActive = true;
      this.compositionOwner = event.target;
      if (
        this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING ||
        this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE
      ) {
        this.cancelScroll("composition");
      }
    };
    this.boundCompositionEnd = () => this.clearComposition();
    this.boundFocusOut = (event) => {
      if (event.target === this.compositionOwner) {
        this.clearComposition();
      }
    };
    this.boundSettingsChange = (event) => {
      if (event.detail?.settings?.actionHintsEnabled === false) {
        this.cancelStoredMode("setting-disabled");
      }
    };
    this.boundSurfaceSelect = (event) => {
      event.stopPropagation();
      this.selectSurface(event.detail?.code);
    };
    this.boundSurfaceCancel = (event) => {
      event.stopPropagation();
      if (
        event.detail?.reason === "escape" &&
        (this.compositionActive || event.detail?.originalEvent?.isComposing)
      ) {
        return;
      }
      this.cancelSelection(event.detail?.reason ?? "selector");
    };
  }

  connect() {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.actionHints.connect();
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
    this.scrollSelector.addEventListener(
      SCROLL_SURFACE_SELECT_EVENT,
      this.boundSurfaceSelect,
    );
    this.scrollSelector.addEventListener(
      SCROLL_SURFACE_CANCEL_EVENT,
      this.boundSurfaceCancel,
    );
    window.addEventListener("caffold:settings-change", this.boundSettingsChange);
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.cancelStoredMode("disconnect", { restoreFocus: false });
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
    this.scrollSelector.removeEventListener(
      SCROLL_SURFACE_SELECT_EVENT,
      this.boundSurfaceSelect,
    );
    this.scrollSelector.removeEventListener(
      SCROLL_SURFACE_CANCEL_EVENT,
      this.boundSurfaceCancel,
    );
    window.removeEventListener(
      "caffold:settings-change",
      this.boundSettingsChange,
    );
    this.actionHints.disconnect();
  }

  routeWillChange() {
    this.clearComposition();
    this.cancelStoredMode("route", { restoreFocus: false });
  }

  handleKeydown(event) {
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      this.actionHints.handleHintKeydown(event, {
        compositionActive: this.compositionActive,
      });
      return;
    }
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING) {
      this.handleSelectionKeydown(event);
      return;
    }
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE) {
      this.handleActiveKeydown(event);
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
        !this.hasUnregisteredInteractionOwner()
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.leaveEditing(editable);
      } else {
        this.applyTransition(KEYBOARD_NAVIGATION_EVENT.EDITING_CONTINUED, {
          editable,
        });
      }
      return;
    }
    const key = normalizeActionHintKey(event, {
      compositionActive: this.compositionActive,
    });
    if (key === "F") {
      if (this.hasHintInteractionOwner()) {
        this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
        return;
      }
      const snapshot = this.actionHints.prepareSnapshot();
      if (!snapshot) {
        this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
        return;
      }
      if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_STARTED)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!this.actionHints.startSession(snapshot) &&
        this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
        this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED);
      }
      return;
    }
    if (key === "S" && this.startScroll()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  handleSelectionKeydown(event) {
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
    if (this.scrollSelector.allowsNativeActivation(event)) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.cancelSelection("escape");
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      this.applySelectionInput("Backspace");
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
    this.applySelectionInput(key);
  }

  handleActiveKeydown(event) {
    if (event.key === "Escape" &&
      !event.isComposing &&
      !this.compositionActive &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      this.cancelActive("escape");
      return;
    }
    const key = normalizeActionHintKey(event, {
      compositionActive: this.compositionActive,
      allowRepeat: true,
    });
    if (!Object.hasOwn({ J: true, K: true, D: true, U: true }, key)) {
      return;
    }
    const session = this.activeSession;
    if (!session || !this.activeBindingIsCurrent(session, {
      refreshPresentation: true,
    })) {
      this.cancelActive("binding-invalidated");
      return;
    }
    const next = scrollCommandPosition({
      command: key,
      scrollTop: session.scrollport.scrollTop,
      scrollHeight: session.scrollport.scrollHeight,
      clientHeight: session.scrollport.clientHeight,
    });
    if (next == null || !this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_COMMAND,
    )) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    session.scrollport.scrollTop = next;
  }

  leaveEditing(editable) {
    if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.EDITING_ENDED, {
      editable,
    })) {
      return;
    }
    const target = this.editingEscapeTarget(editable);
    if (focusableTarget(target)) {
      target.focus({ preventScroll: true });
    } else {
      editable.blur?.();
    }
  }

  startScroll() {
    const context = this.resolveInteractionContext();
    if (!context) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    const snapshot = this.captureScrollSnapshot(context);
    if (!snapshot || snapshot.context.blocked || snapshot.surfaces.length === 0) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    if (snapshot.surfaces.length === 1) {
      if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_STARTED)) {
        return false;
      }
      if (!this.beginActive(snapshot, snapshot.surfaces[0])) {
        this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
        return false;
      }
      return true;
    }
    if (snapshot.context.kind !== "workspace") {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    if (!this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_STARTED,
    )) {
      return false;
    }
    return this.beginSelection(snapshot);
  }

  beginSelection(snapshot) {
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
      resizeObserver: null,
      revalidationQueued: false,
    };
    this.selectionSession = session;
    try {
      this.scrollSelector.open(session.surfaces, session.viewport.rect);
      this.attachSelectionSignals(session);
      if (!this.selectionSnapshotIsCurrent(session)) {
        this.cancelSelection("snapshot-invalidated");
      }
      return true;
    } catch {
      this.cancelSelection("open-failed");
      return false;
    }
  }

  applySelectionInput(key) {
    const session = this.selectionSession;
    if (!session || !this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_INPUT_CHANGED,
    )) {
      return;
    }
    const progression = advanceHintBuffer(
      session.buffer,
      key,
      session.surfaces.map(({ code }) => code),
    );
    session.buffer = progression.buffer;
    this.scrollSelector.updateInput(progression);
    if (progression.exact) {
      this.selectSurface(progression.exact);
    }
  }

  selectSurface(code) {
    const session = this.selectionSession;
    const surface = session?.surfaces.find((candidate) => candidate.code === code);
    if (!session || !surface) {
      return false;
    }
    if (!this.selectionSnapshotIsCurrent(session)) {
      this.cancelSelection("selection-invalidated");
      return false;
    }
    this.detachSelectionSignals(session);
    this.selectionSession = null;
    this.scrollSelector.close();
    this.restoreFocus(session.opener);
    if (!this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_SURFACE_SELECTED,
    )) {
      return false;
    }
    if (!this.beginActive(session, surface)) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
      return false;
    }
    return true;
  }

  cancelSelection(reason = "cancel", { restoreFocus = true } = {}) {
    const session = this.selectionSession;
    if (!session) {
      return false;
    }
    this.detachSelectionSignals(session);
    this.selectionSession = null;
    this.scrollSelector.close();
    this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_CANCELLED);
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    this.workspace.dataset.scrollModeLastExit = reason;
    return true;
  }

  beginActive(snapshot, surface) {
    const session = {
      ...surface,
      context: snapshot.context,
      contextRect: snapshot.contextRect,
      viewport: snapshot.viewport,
      mutationRoots: snapshot.context.mutationRoots,
      resizeElements: snapshot.context.resizeElements,
      cleanup: [],
      mutationObserver: null,
      ownershipObserver: null,
      resizeObserver: null,
      revalidationQueued: false,
    };
    this.activeSession = session;
    if (!this.showActiveHud(session)) {
      this.activeSession = null;
      return false;
    }
    this.attachActiveSignals(session);
    if (!this.activeBindingIsCurrent(session, { refreshPresentation: true })) {
      this.cancelActive("binding-invalidated");
      return false;
    }
    this.workspace.dataset.scrollMode = "active";
    return true;
  }

  cancelActive(reason = "cancel") {
    const session = this.activeSession;
    if (!session) {
      return false;
    }
    this.detachActiveSignals(session);
    this.activeSession = null;
    session.context.hud.close();
    this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
    delete this.workspace.dataset.scrollMode;
    this.workspace.dataset.scrollModeLastExit = reason;
    return true;
  }

  cancelScroll(reason, options = {}) {
    return this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING
      ? this.cancelSelection(reason, options)
      : this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE
        ? this.cancelActive(reason)
        : false;
  }

  cancelStoredMode(reason, options = {}) {
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      return this.actionHints.cancel(reason, options);
    }
    return this.cancelScroll(reason, options);
  }

  handleHintSessionExit({ activated = false } = {}) {
    if (this.storedNode !== KEYBOARD_NAVIGATION_NODE.HINT) {
      return;
    }
    this.applyTransition(
      activated
        ? KEYBOARD_NAVIGATION_EVENT.HINT_CLOSED_FOR_ACTIVATION
        : KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED,
    );
  }

  applyTransition(event, { editable = null } = {}) {
    const current = this.controlNode(editable);
    const next = transitionKeyboardNavigation(current, event);
    if (!next) {
      return null;
    }
    this.storedNode = [
      KEYBOARD_NAVIGATION_NODE.HINT,
      KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING,
      KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE,
    ].includes(next)
      ? next
      : null;
    return { current, next };
  }

  controlNode(editable = null) {
    if (this.storedNode) {
      return this.storedNode;
    }
    if (
      this.compositionActive ||
      editable ||
      editableOwner(document.activeElement)
    ) {
      return KEYBOARD_NAVIGATION_NODE.EDITING;
    }
    return KEYBOARD_NAVIGATION_NODE.NORMAL;
  }

  resolveInteractionContext({ ignoreOwnedSelector = false } = {}) {
    if (hasOpenPopover()) {
      return null;
    }
    const contexts = this.safeCollectScrollContexts();
    if (!contexts) {
      return null;
    }
    const modals = openModalDialogs().filter(
      (modal) =>
        !(ignoreOwnedSelector && this.scrollSelector.ownsModal(modal)),
    );
    if (modals.length) {
      if (modals.length !== 1) {
        return null;
      }
      const [modal] = modals;
      const context = contexts.find((candidate) => candidate.root === modal);
      return context?.kind === "modal" ? context : null;
    }
    const workspaceContexts = contexts.filter(
      (context) => context.kind === "workspace",
    );
    return workspaceContexts.length === 1 ? workspaceContexts[0] : null;
  }

  safeCollectScrollContexts() {
    try {
      return normalizeContexts(this.collectScrollContexts?.() ?? []);
    } catch {
      return null;
    }
  }

  captureScrollSnapshot(context) {
    if (!context?.root.isConnected || !hasLayoutBox(context.root)) {
      return null;
    }
    const viewport = captureViewport();
    const contextRect = normalizedContextRect(context.root, viewport.rect);
    if (!contextRect) {
      return null;
    }
    const visible = [];
    for (const surface of context.surfaces) {
      if (!scrollSurfaceIsEligible(surface, context)) {
        continue;
      }
      const visibleRect = visibleScrollSurfaceRect(
        surface.scrollport.getBoundingClientRect(),
        [
          context.root.getBoundingClientRect(),
          ...surface.clipRoots.map((root) => root.getBoundingClientRect()),
        ],
        viewport.rect,
      );
      if (!visibleRect) {
        continue;
      }
      visible.push({ ...surface, visibleRect });
    }
    let surfaces;
    try {
      surfaces = allocateScrollSurfaceCodes(orderScrollSurfaces(visible));
    } catch {
      return null;
    }
    return {
      context,
      contextRect,
      viewport,
      surfaces,
    };
  }

  selectionSnapshotIsCurrent(session) {
    if (this.hasUnregisteredInteractionOwner({ ignoreOwnedSelector: true })) {
      return false;
    }
    const context = this.resolveInteractionContext({
      ignoreOwnedSelector: true,
    });
    const current = context && this.captureScrollSnapshot(context);
    if (!current || !sameScrollSelectionSnapshot(session, current)) {
      return false;
    }
    const changed = [];
    for (const [index, surface] of session.surfaces.entries()) {
      const label = current.surfaces[index]?.label;
      if (label && label !== surface.label) {
        surface.label = label;
        changed.push(surface);
      }
    }
    if (changed.length) {
      this.scrollSelector.updateSurfaceLabels(changed);
    }
    return true;
  }

  activeBindingIsCurrent(session, { refreshPresentation = false } = {}) {
    if (this.hasUnregisteredInteractionOwner()) {
      return false;
    }
    const context = this.resolveInteractionContext();
    const snapshot = context && this.captureScrollSnapshot(context);
    const surface = snapshot?.surfaces.find(({ id }) => id === session.id);
    const current = surface
      ? {
          ...surface,
          context: snapshot.context,
          contextRect: snapshot.contextRect,
          viewport: snapshot.viewport,
        }
      : null;
    if (!current || !sameActiveScrollBinding(session, current)) {
      return false;
    }
    const labelChanged = current.label !== session.label;
    const geometryChanged =
      !rectsEqual(current.visibleRect, session.visibleRect) ||
      !rectsEqual(current.contextRect, session.contextRect);
    if (refreshPresentation && (labelChanged || geometryChanged)) {
      session.label = current.label;
      session.visibleRect = current.visibleRect;
      session.contextRect = current.contextRect;
      session.viewport = current.viewport;
      if (geometryChanged) {
        return this.showActiveHud(session);
      }
      session.context.hud.updateLabel(current.label);
    }
    return true;
  }

  showActiveHud(session) {
    return Boolean(session.contextRect && session.context.hud.show({
      label: session.label,
      visibleRect: session.visibleRect,
      contextRect: session.contextRect,
    }));
  }

  attachSelectionSignals(session) {
    const cancel = (reason) => () => this.cancelSelection(reason);
    for (const root of session.context.scrollRoots) {
      const listener = cancel("scroll");
      root.addEventListener("scroll", listener, { passive: true });
      session.cleanup.push(() => root.removeEventListener("scroll", listener));
    }
    this.attachViewportSignals(session, cancel("viewport"));
    if (typeof MutationObserver === "function") {
      session.mutationObserver = new MutationObserver(() =>
        this.queueSelectionRevalidation(session)
      );
      for (const root of session.context.mutationRoots) {
        session.mutationObserver.observe(root, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }
    if (typeof ResizeObserver === "function") {
      session.resizeObserver = new ResizeObserver(() =>
        this.queueSelectionRevalidation(session)
      );
      for (const element of session.context.resizeElements) {
        session.resizeObserver.observe(element);
      }
    }
    this.attachOwnershipSignals(session, (signal) => {
      if (
        signal?.opening ||
        this.hasUnregisteredInteractionOwner({ ignoreOwnedSelector: true })
      ) {
        this.cancelSelection("interaction-owner");
      }
    });
  }

  detachSelectionSignals(session) {
    detachSignals(session);
  }

  attachActiveSignals(session) {
    this.attachViewportSignals(session, () => this.cancelActive("viewport"));
    if (typeof MutationObserver === "function") {
      session.mutationObserver = new MutationObserver(() =>
        this.queueActiveRevalidation(session)
      );
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
      session.resizeObserver = new ResizeObserver(() =>
        this.queueActiveRevalidation(session)
      );
      for (const element of session.resizeElements) {
        session.resizeObserver.observe(element);
      }
    }
    if (session.context.kind === "modal") {
      const close = () => this.cancelActive("context-closed");
      session.context.root.addEventListener("close", close);
      session.cleanup.push(() =>
        session.context.root.removeEventListener("close", close)
      );
    }
    this.attachOwnershipSignals(session, (signal) => {
      if (
        signal?.opening ||
        !this.activeBindingIsCurrent(session, { refreshPresentation: true })
      ) {
        this.cancelActive("interaction-owner");
      }
    });
  }

  detachActiveSignals(session) {
    detachSignals(session);
  }

  attachViewportSignals(session, listener) {
    window.addEventListener("resize", listener, { passive: true });
    window.addEventListener("scroll", listener, { passive: true });
    session.cleanup.push(() => {
      window.removeEventListener("resize", listener);
      window.removeEventListener("scroll", listener);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", listener, {
        passive: true,
      });
      window.visualViewport.addEventListener("scroll", listener, {
        passive: true,
      });
      session.cleanup.push(() => {
        window.visualViewport.removeEventListener("resize", listener);
        window.visualViewport.removeEventListener("scroll", listener);
      });
    }
  }

  attachOwnershipSignals(session, revalidate) {
    if (typeof MutationObserver === "function" && document.documentElement) {
      session.ownershipObserver = new MutationObserver(revalidate);
      session.ownershipObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["open"],
        subtree: true,
      });
    }
    const handleBeforeToggle = (event) => {
      if (event.newState === "open") {
        revalidate({ opening: true, owner: event.target });
      }
    };
    document.addEventListener("beforetoggle", handleBeforeToggle, true);
    session.cleanup.push(() =>
      document.removeEventListener("beforetoggle", handleBeforeToggle, true)
    );
  }

  queueSelectionRevalidation(session) {
    if (this.selectionSession !== session || session.revalidationQueued) {
      return;
    }
    session.revalidationQueued = true;
    queueMicrotask(() => {
      session.revalidationQueued = false;
      if (
        this.selectionSession === session &&
        !this.selectionSnapshotIsCurrent(session)
      ) {
        this.cancelSelection("snapshot-invalidated");
      }
    });
  }

  queueActiveRevalidation(session) {
    if (this.activeSession !== session || session.revalidationQueued) {
      return;
    }
    session.revalidationQueued = true;
    queueMicrotask(() => {
      session.revalidationQueued = false;
      if (
        this.activeSession === session &&
        !this.activeBindingIsCurrent(session, { refreshPresentation: true })
      ) {
        this.cancelActive("binding-invalidated");
      }
    });
  }

  hasHintInteractionOwner() {
    return hasOpenPopover() || openModalDialogs().some(
      (modal) => !this.actionHints.dialog.ownsModal(modal),
    );
  }

  hasUnregisteredInteractionOwner({ ignoreOwnedSelector = false } = {}) {
    if (hasOpenPopover()) {
      return true;
    }
    const modals = openModalDialogs().filter(
      (modal) =>
        !(ignoreOwnedSelector && this.scrollSelector.ownsModal(modal)),
    );
    if (!modals.length) {
      return false;
    }
    const contexts = this.safeCollectScrollContexts();
    return modals.some(
      (modal) => !contexts?.some((context) => context.root === modal),
    );
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

  clearComposition() {
    this.compositionActive = false;
    this.compositionOwner = null;
  }
}

function normalizeContexts(contexts) {
  if (!Array.isArray(contexts)) {
    return null;
  }
  const ids = new Set();
  const normalized = [];
  for (const context of contexts) {
    const id = `${context?.id ?? ""}`.trim();
    const kind = `${context?.kind ?? ""}`;
    if (
      !id ||
      ids.has(id) ||
      !["workspace", "modal"].includes(kind) ||
      !(context?.root instanceof HTMLElement) ||
      !(context?.hud instanceof HTMLElement) ||
      typeof context.hud.show !== "function" ||
      typeof context.hud.close !== "function" ||
      typeof context.hud.updateLabel !== "function" ||
      !Array.isArray(context?.surfaces)
    ) {
      return null;
    }
    const mutationRoots = normalizeElementList([
      context.root,
      ...(context.mutationRoots ?? []),
    ]);
    const resizeElements = normalizeElementList([
      context.root,
      ...(context.resizeElements ?? []),
    ]);
    const scrollRoots = normalizeElementList(context.scrollRoots ?? []);
    const surfaces = normalizeSurfaces(context.surfaces);
    if (!mutationRoots || !resizeElements || !scrollRoots || !surfaces) {
      return null;
    }
    ids.add(id);
    normalized.push({
      ...context,
      id,
      kind,
      blocked: Boolean(context.blocked),
      surfaces,
      mutationRoots,
      resizeElements,
      scrollRoots,
    });
  }
  return normalized;
}

function normalizeSurfaces(surfaces) {
  const ids = new Set();
  const normalized = [];
  for (const surface of surfaces) {
    const id = `${surface?.id ?? ""}`.trim();
    const label = `${surface?.label ?? ""}`.trim();
    const clipRoots = normalizeElementList(surface?.clipRoots ?? []);
    if (
      !id ||
      ids.has(id) ||
      !label ||
      !(surface?.scrollport instanceof HTMLElement) ||
      !clipRoots ||
      typeof surface?.isEligible !== "function"
    ) {
      return null;
    }
    ids.add(id);
    normalized.push({ ...surface, id, label, clipRoots });
  }
  return normalized;
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

function uniqueElements(elements) {
  const unique = [];
  const seen = new Set();
  for (const element of elements) {
    if (!seen.has(element)) {
      seen.add(element);
      unique.push(element);
    }
  }
  return unique;
}

function scrollSurfaceIsEligible(surface, context) {
  try {
    return Boolean(
      surface.scrollport.isConnected &&
        context.root.contains(surface.scrollport) &&
        hasLayoutBox(surface.scrollport) &&
        hasVerticalScrollOverflow(surface.scrollport) &&
        surface.isEligible()
    );
  } catch {
    return false;
  }
}

function hasLayoutBox(element) {
  return Boolean(element?.getClientRects?.().length);
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
      element.getClientRects().length
  );
}

function hasOpenPopover() {
  try {
    return Boolean(document.querySelector(":popover-open"));
  } catch {
    return false;
  }
}

function openModalDialogs() {
  try {
    return [...document.querySelectorAll("dialog:modal")];
  } catch {
    return [];
  }
}

function detachSignals(session) {
  session.mutationObserver?.disconnect();
  session.ownershipObserver?.disconnect();
  session.resizeObserver?.disconnect();
  for (const cleanup of session.cleanup ?? []) {
    cleanup();
  }
  session.cleanup = [];
}
