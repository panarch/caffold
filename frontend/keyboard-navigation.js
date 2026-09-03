import {
  ActionHintController,
  advanceHintBuffer,
  isEditableElement,
  normalizeActionHintKey,
  normalizeRect,
  rectsEqual,
} from "./action-hints.js";
import { availableScrollAxes } from "./scroll-scope.js";
import {
  KEYBOARD_NAVIGATION_EVENT,
  KEYBOARD_NAVIGATION_NODE,
  transitionKeyboardNavigation,
} from "./keyboard-navigation/control.js";
import {
  normalizeKeyboardNavigationContexts,
} from "./keyboard-navigation/context.js";
import {
  SCROLL_COMMAND,
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
import {
  KEYBOARD_NAVIGATION_KEY,
  KEYBOARD_SHORTCUT_CLOSE_EVENT,
  matchesKeyboardNavigationKey,
} from "./keyboard-navigation/shortcuts.js";

export {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
  popoverScrollSurfaceScope,
} from "./keyboard-navigation/context.js";

export class KeyboardNavigationController {
  constructor({
    workspace,
    collectKeyboardNavigationContexts,
    shortcutDialog = null,
    afterActionHintActivation = () => {},
    readSettings = () => ({ actionHintsEnabled: true }),
  }) {
    this.workspace = workspace;
    this.collectKeyboardNavigationContexts = collectKeyboardNavigationContexts;
    this.shortcutDialog = shortcutDialog;
    this.readSettings = readSettings;
    this.connected = false;
    this.compositionActive = false;
    this.compositionOwner = null;
    this.storedNode = null;
    this.selectionSession = null;
    this.activeSession = null;
    this.shortcutSession = null;
    this.actionHints = new ActionHintController({
      workspace,
      dialog: null,
      collectScope: () => null,
      collectBinding: () => this.resolveActionHintBinding(),
      afterActivation: afterActionHintActivation,
      hasOtherInteractionOwner: (binding) =>
        this.hasHintInteractionOwner(binding),
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
      if (event.target !== this.selectionSession?.selector) {
        return;
      }
      event.stopPropagation();
      this.selectSurface(event.detail?.code);
    };
    this.boundSurfaceCancel = (event) => {
      if (event.target !== this.selectionSession?.selector) {
        return;
      }
      event.stopPropagation();
      if (
        event.detail?.reason === "escape" &&
        (this.compositionActive || event.detail?.originalEvent?.isComposing)
      ) {
        return;
      }
      this.cancelSelection(event.detail?.reason ?? "selector");
    };
    this.boundShortcutClose = (event) => {
      if (event.target !== this.shortcutDialog) {
        return;
      }
      event.stopPropagation();
      this.closeShortcutHelp(event.detail?.reason ?? "dialog");
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
    this.workspace.addEventListener(
      SCROLL_SURFACE_SELECT_EVENT,
      this.boundSurfaceSelect,
    );
    this.workspace.addEventListener(
      SCROLL_SURFACE_CANCEL_EVENT,
      this.boundSurfaceCancel,
    );
    this.workspace.addEventListener(
      KEYBOARD_SHORTCUT_CLOSE_EVENT,
      this.boundShortcutClose,
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
    this.workspace.removeEventListener(
      SCROLL_SURFACE_SELECT_EVENT,
      this.boundSurfaceSelect,
    );
    this.workspace.removeEventListener(
      SCROLL_SURFACE_CANCEL_EVENT,
      this.boundSurfaceCancel,
    );
    this.workspace.removeEventListener(
      KEYBOARD_SHORTCUT_CLOSE_EVENT,
      this.boundShortcutClose,
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
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP) {
      this.handleShortcutHelpKeydown(event);
      return;
    }
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      if (this.handleShortcutHelpEntry(event)) {
        return;
      }
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
    if (this.readSettings().actionHintsEnabled === false) {
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
        !event.metaKey
      ) {
        const target = this.resolveEditingEscapeTarget(editable);
        if (target) {
          event.preventDefault();
          event.stopPropagation();
          this.leaveEditing(editable, target);
          return;
        }
      }
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.EDITING_CONTINUED, {
        editable,
      });
      return;
    }
    const key = normalizeActionHintKey(event, {
      compositionActive: this.compositionActive,
    });
    if (matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
      { compositionActive: this.compositionActive },
    )) {
      if (this.startShortcutHelp()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (key === KEYBOARD_NAVIGATION_KEY.ACTION_HINTS) {
      if (this.startActionHints()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (key === KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT && this.startScroll()) {
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
    if (this.selectionSession?.selector?.allowsNativeActivation(event)) {
      return;
    }
    if (this.handleShortcutHelpEntry(event)) {
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
        this.cancelSelection("no-match");
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.applySelectionInput(key);
  }

  handleActiveKeydown(event) {
    if (this.handleShortcutHelpEntry(event)) {
      return;
    }
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
    if (key === KEYBOARD_NAVIGATION_KEY.ACTION_HINTS && !event.repeat) {
      if (!this.cancelActive("action-hints")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.startActionHints();
      return;
    }
    if (!Object.hasOwn(SCROLL_COMMAND, key)) {
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
      availableAxes: session.availableAxes,
      scrollTop: session.scrollport.scrollTop,
      scrollHeight: session.scrollport.scrollHeight,
      clientHeight: session.scrollport.clientHeight,
      scrollLeft: session.scrollport.scrollLeft,
      scrollWidth: session.scrollport.scrollWidth,
      clientWidth: session.scrollport.clientWidth,
    });
    if (next == null || !this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SCROLL_COMMAND,
    )) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next.axis === "vertical") {
      session.scrollport.scrollTop = next.position;
    } else {
      session.scrollport.scrollLeft = next.position;
    }
  }

  handleShortcutHelpEntry(event) {
    if (!matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
      { compositionActive: this.compositionActive },
    )) {
      return false;
    }
    if (!this.startShortcutHelp()) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  handleShortcutHelpKeydown(event) {
    if (this.shortcutDialog?.allowsNativeActivation?.(event)) {
      return;
    }
    const closes = matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
      { compositionActive: this.compositionActive },
    ) || matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.ESCAPE,
      { compositionActive: this.compositionActive },
    );
    if (!closes || !this.closeShortcutHelp("keyboard")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  startShortcutHelp() {
    if (!this.shortcutDialog || this.shortcutSession) {
      return false;
    }
    const current = this.controlNode();
    if (
      current === KEYBOARD_NAVIGATION_NODE.EDITING ||
      current === KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP
    ) {
      return false;
    }
    const restoreTarget = this.shortcutHelpOpener();
    if (this.storedNode && !this.cancelStoredMode("shortcut-help", {
      restoreFocus: false,
    })) {
      return false;
    }
    if (!this.applyTransition(
      KEYBOARD_NAVIGATION_EVENT.SHORTCUT_HELP_STARTED,
    )) {
      return false;
    }
    const session = { opener: restoreTarget };
    this.shortcutSession = session;
    try {
      if (!this.shortcutDialog.open()) {
        throw new Error("Keyboard shortcut help did not open.");
      }
    } catch {
      this.shortcutSession = null;
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SHORTCUT_HELP_CLOSED);
      this.restoreFocus(restoreTarget);
      return false;
    }
    this.workspace.dataset.keyboardShortcutHelp = "open";
    return true;
  }

  closeShortcutHelp(reason = "close", { restoreFocus = true } = {}) {
    const session = this.shortcutSession;
    if (!session) {
      return false;
    }
    this.shortcutSession = null;
    this.shortcutDialog.close();
    this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SHORTCUT_HELP_CLOSED);
    delete this.workspace.dataset.keyboardShortcutHelp;
    this.workspace.dataset.keyboardShortcutHelpLastExit = reason;
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    return true;
  }

  shortcutHelpOpener() {
    return this.actionHints.session?.opener ??
      this.selectionSession?.opener ??
      this.activeSession?.opener ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
  }

  startActionHints() {
    const snapshot = this.actionHints.prepareSnapshot();
    if (!snapshot) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_STARTED)) {
      return false;
    }
    if (!this.actionHints.startSession(snapshot) &&
      this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED);
    }
    return true;
  }

  leaveEditing(editable, target) {
    if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.EDITING_ENDED, {
      editable,
    })) {
      return;
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      // A control can become non-focusable after the key event was accepted.
    }
  }

  resolveEditingEscapeTarget(editable) {
    const context = this.resolveInteractionContext();
    const escapeTarget = context?.editing?.escapeTarget;
    if (
      !context ||
      typeof escapeTarget !== "function" ||
      !context.root.contains(editable)
    ) {
      return null;
    }
    let target;
    try {
      target = escapeTarget(editable);
    } catch {
      return null;
    }
    return context.root.contains(target) && focusableTarget(target)
      ? target
      : null;
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
    if (snapshot.context.kind === "popover") {
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
      selector: snapshot.context.selector,
      buffer: "",
      cleanup: [],
      mutationObserver: null,
      ownershipObserver: null,
      resizeObserver: null,
      revalidationQueued: false,
    };
    this.selectionSession = session;
    try {
      session.selector.open(session.surfaces, session.viewport.rect);
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
    if (progression.status === "no-match") {
      this.cancelSelection("no-match");
      return;
    }
    session.buffer = progression.buffer;
    session.selector.updateInput(progression);
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
    session.selector.close();
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
    session.selector.close();
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
      opener: snapshot.opener instanceof HTMLElement
        ? snapshot.opener
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      context: snapshot.context,
      contextRect: snapshot.contextRect,
      viewport: snapshot.viewport,
      mutationRoots: snapshot.context.mutationRoots,
      resizeElements: snapshot.context.resizeElements,
      scrollRoots: snapshot.context.scrollRoots,
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
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP) {
      return this.closeShortcutHelp(reason, options);
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
      KEYBOARD_NAVIGATION_NODE.SHORTCUT_HELP,
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

  resolveInteractionContext({
    ignoreOwnedSelector = false,
    ownedHintDialog = null,
  } = {}) {
    const contexts = this.safeCollectKeyboardNavigationContexts();
    if (!contexts) {
      return null;
    }
    const modals = openModalDialogs().filter(
      (modal) =>
        !(
          ignoreOwnedSelector &&
          this.selectionSession?.selector?.ownsModal(modal)
        ) &&
        !(ownedHintDialog?.ownsModal?.(modal)),
    );
    const popovers = openPopovers();
    if (popovers.length) {
      if (popovers.length !== 1) {
        return null;
      }
      const [popover] = popovers;
      const context = contexts.find((candidate) => candidate.root === popover);
      if (
        context?.kind !== "popover" ||
        modals.some((modal) => !modal.contains(popover))
      ) {
        return null;
      }
      return context;
    }
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

  safeCollectKeyboardNavigationContexts() {
    try {
      return normalizeKeyboardNavigationContexts(
        this.collectKeyboardNavigationContexts?.() ?? [],
      );
    } catch {
      return null;
    }
  }

  resolveActionHintBinding() {
    const ownedHintDialog = this.actionHints.session?.dialog ?? null;
    const context = this.resolveInteractionContext({ ownedHintDialog });
    return context?.actionHints
      ? {
          context,
          dialog: context.actionHints.dialog,
          scope: context.actionHints.scope,
        }
      : null;
  }

  captureScrollSnapshot(context) {
    const capability = context?.scroll;
    if (
      !capability ||
      !context.root.isConnected ||
      !hasLayoutBox(context.root)
    ) {
      return null;
    }
    const scrollContext = {
      id: context.id,
      kind: context.kind,
      root: context.root,
      hud: capability.hud,
      selector: capability.selector,
      ...capability.scope,
    };
    const viewport = captureViewport();
    const contextRect = normalizedContextRect(scrollContext.root, viewport.rect);
    if (!contextRect) {
      return null;
    }
    const visible = [];
    for (const surface of scrollContext.surfaces) {
      const availableAxes = scrollSurfaceAvailableAxes(surface, scrollContext);
      if (!availableAxes?.length) {
        continue;
      }
      const visibleRect = visibleScrollSurfaceRect(
        surface.scrollport.getBoundingClientRect(),
        [
          scrollContext.root.getBoundingClientRect(),
          ...surface.clipRoots.map((root) => root.getBoundingClientRect()),
        ],
        viewport.rect,
      );
      if (!visibleRect) {
        continue;
      }
      visible.push({ ...surface, availableAxes, visibleRect });
    }
    let surfaces;
    try {
      surfaces = allocateScrollSurfaceCodes(orderScrollSurfaces(visible));
    } catch {
      return null;
    }
    return {
      context: scrollContext,
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
      session.selector.updateSurfaceLabels(changed);
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
      const position = scrollPosition(root);
      const listener = () => {
        if (!sameScrollPosition(position, scrollPosition(root))) {
          this.cancelSelection("scroll");
        }
      };
      root.addEventListener("scroll", listener, { passive: true });
      session.cleanup.push(() => root.removeEventListener("scroll", listener));
    }
    this.attachViewportSignals(session, () => {
      if (
        this.selectionSession === session &&
        !this.selectionSnapshotIsCurrent(session)
      ) {
        this.cancelSelection("viewport");
      }
    });
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
    for (const root of session.scrollRoots ?? []) {
      if (root === session.scrollport) {
        continue;
      }
      let position = scrollPosition(root);
      const listener = () => {
        const current = scrollPosition(root);
        if (sameScrollPosition(position, current)) {
          return;
        }
        position = current;
        this.queueActiveRevalidation(session);
      };
      root.addEventListener("scroll", listener, { passive: true });
      session.cleanup.push(() => root.removeEventListener("scroll", listener));
    }
    this.attachViewportSignals(session, () => {
      if (
        this.activeSession === session &&
        !this.activeBindingIsCurrent(session, { refreshPresentation: true })
      ) {
        this.cancelActive("viewport");
      }
    });
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
    } else if (session.context.kind === "popover") {
      const close = (event) => {
        if (event.newState === "closed") {
          this.cancelActive("context-closed");
        }
      };
      session.context.root.addEventListener("beforetoggle", close);
      session.cleanup.push(() =>
        session.context.root.removeEventListener("beforetoggle", close)
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

  hasHintInteractionOwner(binding = null) {
    const context = this.resolveInteractionContext({
      ownedHintDialog: binding?.dialog ?? null,
    });
    return !sameContextOwner(context, binding?.context ?? null);
  }

  hasUnregisteredInteractionOwner({ ignoreOwnedSelector = false } = {}) {
    const popovers = openPopovers();
    const modals = openModalDialogs().filter(
      (modal) =>
        !(
          ignoreOwnedSelector &&
          this.selectionSession?.selector?.ownsModal(modal)
        ),
    );
    if (!popovers.length && !modals.length) {
      return false;
    }
    return !this.resolveInteractionContext({ ignoreOwnedSelector });
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

function scrollSurfaceAvailableAxes(surface, context) {
  try {
    if (!(
      surface.scrollport.isConnected &&
        contextContains(context.root, surface.scrollport) &&
        hasLayoutBox(surface.scrollport) &&
        surface.isEligible()
    )) {
      return null;
    }
    return availableScrollAxes(surface.scrollport, surface.axes);
  } catch {
    return null;
  }
}

function contextContains(root, element) {
  if (root.contains(element)) {
    return true;
  }
  let currentRoot = element.getRootNode?.();
  while (typeof ShadowRoot === "function" && currentRoot instanceof ShadowRoot) {
    const host = currentRoot.host;
    if (host === root || root.contains(host)) {
      return true;
    }
    currentRoot = host?.getRootNode?.();
  }
  return false;
}

function hasLayoutBox(element) {
  return Boolean(element?.getClientRects?.().length);
}

function scrollPosition(element) {
  return {
    left: Number(element?.scrollLeft ?? 0),
    top: Number(element?.scrollTop ?? 0),
  };
}

function sameScrollPosition(left, right) {
  return left.left === right.left && left.top === right.top;
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

function openPopovers() {
  try {
    return [...document.querySelectorAll(":popover-open")];
  } catch {
    return [];
  }
}

function sameContextOwner(left, right) {
  return Boolean(
    left &&
      right &&
      left.id === right.id &&
      left.kind === right.kind &&
      left.root === right.root,
  );
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
