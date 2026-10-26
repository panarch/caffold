import type { CaffoldActionHintDialog } from "./action-hints/components/dialog.ts";
import {
  type ActionHintBinding,
  ActionHintController,
  type ActionHintSessionExit,
  type ActionHintSessionTarget,
  advanceHintBuffer,
  isEditableElement,
  normalizeActionHintKey,
  normalizeRect,
  type Rect,
  rectsEqual,
} from "./action-hints.ts";
import type { CaffoldScrollModeHud } from "./keyboard-navigation/components/hud.ts";
import {
  type CaffoldScrollSurfaceSelector,
  SCROLL_SURFACE_CANCEL_EVENT,
  SCROLL_SURFACE_SELECT_EVENT,
} from "./keyboard-navigation/components/selector.ts";
import type { CaffoldKeyboardShortcutDialog } from "./keyboard-navigation/components/shortcut-dialog.ts";
import {
  type ContextScrollSurface,
  type KeyboardNavigationContext,
  type NormalizedKeyboardNavigationContext,
  normalizeKeyboardNavigationContexts,
} from "./keyboard-navigation/context.ts";
import {
  KEYBOARD_NAVIGATION_EVENT,
  KEYBOARD_NAVIGATION_NODE,
  type KeyboardNavigationEvent,
  type KeyboardNavigationNode,
  transitionKeyboardNavigation,
} from "./keyboard-navigation/control.ts";
import {
  allocateScrollSurfaceCodes,
  normalizedContextRect,
  orderScrollSurfaces,
  SCROLL_COMMAND,
  sameActiveScrollBinding,
  sameScrollSelectionSnapshot,
  scrollCommandPosition,
  visibleScrollSurfaceRect,
} from "./keyboard-navigation/model.ts";
import {
  KEY_COMBINATION_ACTION,
  KEYBOARD_NAVIGATION_KEY,
  KEYBOARD_SHORTCUT_CLOSE_EVENT,
  keyCombinationAction,
  matchesKeyboardNavigationKey,
} from "./keyboard-navigation/shortcuts.ts";
import { availableScrollAxes, type ScrollAxis } from "./scroll-scope.ts";

export {
  KeyboardContexts,
  type KeyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "./keyboard-navigation/context.ts";

export const KEYBOARD_SESSION_DISMISS_EVENT =
  "caffold:keyboard-session-dismiss";
const KEYBOARD_SESSION_DISMISSAL_REASONS = new Set([
  "escape",
  "no-match",
  "overlay",
]);

interface Viewport {
  rect: Rect | null;
  scale: number;
  devicePixelRatio: number;
}

interface ScrollContext {
  id: string;
  kind: NormalizedKeyboardNavigationContext["kind"];
  root: HTMLElement;
  presentation: Element;
  sessionBound: boolean;
  hud: CaffoldScrollModeHud;
  selector: CaffoldScrollSurfaceSelector;
  blocked: boolean;
  surfaces: ContextScrollSurface[];
  mutationRoots: Node[];
  resizeElements: Element[];
  scrollRoots: Element[];
}

type CodedScrollSurface = ContextScrollSurface & {
  availableAxes: ScrollAxis[];
  visibleRect: Rect;
  code: string;
};

interface ScrollSnapshot {
  context: ScrollContext;
  contextRect: Rect | null;
  viewport: Viewport;
  surfaces: CodedScrollSurface[];
  opener?: HTMLElement | null;
}

// What a session watches to end itself when its snapshot stops being true.
interface SessionSignals {
  cleanup: Array<() => void>;
  mutationObserver: MutationObserver | null;
  ownershipObserver: MutationObserver | null;
  resizeObserver: ResizeObserver | null;
  revalidationQueued: boolean;
  revalidationAfterDrawQueued: boolean;
}

interface SelectionSession extends ScrollSnapshot, SessionSignals {
  opener: HTMLElement | null;
  selector: CaffoldScrollSurfaceSelector;
  buffer: string;
}

interface ActiveSession extends CodedScrollSurface, SessionSignals {
  opener: HTMLElement | null;
  context: ScrollContext;
  contextRect: Rect | null;
  viewport: Viewport;
  mutationRoots: Node[];
  resizeElements: Element[];
  scrollRoots: Element[];
}

interface ShortcutSession {
  opener: HTMLElement | null;
  coveredModals: Element[];
}

type SignalRevalidation = (signal?: {
  opening?: boolean;
  owner?: EventTarget | null;
}) => void;

export interface KeyboardNavigationControllerOptions {
  workspace: HTMLElement;
  collectKeyboardNavigationContexts: () => KeyboardNavigationContext[];
  shortcutDialog?: CaffoldKeyboardShortcutDialog | null;
  afterActionHintActivation?: (target: ActionHintSessionTarget) => void;
  openTaskSwitcher?: () => boolean;
  toggleTerminal?: () => boolean;
  toggleSidePane?: () => boolean;
  readSettings?: () => { actionHintsEnabled?: boolean };
}

/**
 * The one keyboard navigation over the app shell: Action Hints, Scroll mode,
 * the shortcut help, and the shell's key combinations. It reads the keyboard
 * contexts each time it acts, so it works in whichever one is in front.
 */
export class KeyboardNavigationController {
  readonly actionHints: ActionHintController;
  connected = false;
  private readonly workspace: HTMLElement;
  private readonly collectKeyboardNavigationContexts: () => KeyboardNavigationContext[];
  private readonly shortcutDialog: CaffoldKeyboardShortcutDialog | null;
  private readonly openTaskSwitcher: () => boolean;
  private readonly keyCombinations: Record<string, () => boolean>;
  private readonly readSettings: () => { actionHintsEnabled?: boolean };
  private compositionActive = false;
  private compositionOwner: EventTarget | null = null;
  private storedNode: KeyboardNavigationNode | null = null;
  private selectionSession: SelectionSession | null = null;
  private activeSession: ActiveSession | null = null;
  private shortcutSession: ShortcutSession | null = null;
  private readonly boundKeydown = (event: KeyboardEvent) =>
    this.handleKeydown(event);
  private readonly boundCompositionStart = (event: Event) => {
    this.compositionActive = true;
    this.compositionOwner = event.target;
    if (
      this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING ||
      this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE
    ) {
      this.cancelScroll("composition");
    }
  };
  private readonly boundCompositionEnd = () => this.clearComposition();
  private readonly boundFocusOut = (event: Event) => {
    if (event.target === this.compositionOwner) {
      this.clearComposition();
    }
  };
  private readonly boundSettingsChange = (event: Event) => {
    const { detail } = event as CustomEvent<{
      settings?: { actionHintsEnabled?: boolean };
    }>;
    if (detail?.settings?.actionHintsEnabled === false) {
      this.cancelStoredMode("setting-disabled");
      this.closeShortcutHelp("setting-disabled");
    }
  };
  private readonly boundSurfaceSelect = (event: Event) => {
    if (event.target !== this.selectionSession?.selector) {
      return;
    }
    event.stopPropagation();
    this.selectSurface((event as CustomEvent<{ code?: string }>).detail?.code);
  };
  private readonly boundSurfaceCancel = (event: Event) => {
    if (event.target !== this.selectionSession?.selector) {
      return;
    }
    event.stopPropagation();
    const { detail } = event as CustomEvent<{
      reason?: string;
      originalEvent?: Event & { isComposing?: boolean };
    }>;
    if (
      detail?.reason === "escape" &&
      (this.compositionActive || detail?.originalEvent?.isComposing)
    ) {
      return;
    }
    this.cancelSelection(detail?.reason ?? "selector");
  };
  private readonly boundShortcutClose = (event: Event) => {
    if (event.target !== this.shortcutDialog) {
      return;
    }
    event.stopPropagation();
    this.closeShortcutHelp(
      (event as CustomEvent<{ reason?: string }>).detail?.reason ?? "dialog",
    );
  };

  constructor({
    workspace,
    collectKeyboardNavigationContexts,
    shortcutDialog = null,
    afterActionHintActivation = () => {},
    openTaskSwitcher = () => false,
    toggleTerminal = () => false,
    toggleSidePane = () => false,
    readSettings = () => ({ actionHintsEnabled: true }),
  }: KeyboardNavigationControllerOptions) {
    this.workspace = workspace;
    this.collectKeyboardNavigationContexts = collectKeyboardNavigationContexts;
    this.shortcutDialog = shortcutDialog;
    this.openTaskSwitcher = openTaskSwitcher;
    this.keyCombinations = {
      [KEY_COMBINATION_ACTION.TERMINAL]: toggleTerminal,
      [KEY_COMBINATION_ACTION.SIDE_PANE]: toggleSidePane,
      [KEY_COMBINATION_ACTION.ACTION_HINTS]: () => this.startActionHints(),
    };
    this.readSettings = readSettings;
    this.actionHints = new ActionHintController({
      workspace,
      dialog: null,
      collectScope: () => null,
      collectBinding: () => this.resolveActionHintBinding(),
      afterActivation: (target, activation) => {
        afterActionHintActivation(target);
        // What the activation opened has drawn by the next frame.
        requestAnimationFrame(() => this.continueActionHints(activation));
      },
      hasOtherInteractionOwner: (binding) =>
        this.hasHintInteractionOwner(binding),
      isCompositionActive: () => this.compositionActive,
      onSessionExit: (detail) => this.handleHintSessionExit(detail),
    });
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
    window.addEventListener(
      "caffold:settings-change",
      this.boundSettingsChange,
    );
  }

  disconnect() {
    if (!this.connected) {
      return;
    }
    this.cancelStoredMode("disconnect", { restoreFocus: false });
    this.closeShortcutHelp("disconnect", { restoreFocus: false });
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
    this.closeShortcutHelp("route", { restoreFocus: false });
  }

  handleKeydown(event: KeyboardEvent) {
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      if (
        this.handleShortcutHelpEntry(event) ||
        this.handleHintScrollSwitch(event)
      ) {
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
    const combination = keyCombinationAction(event, {
      compositionActive: this.compositionActive,
    });
    if (combination) {
      // An open dialog or popover owns the keyboard until it closes; only the
      // Action Hint combination, which shows that overlay's own actions, works
      // there. An action that did nothing leaves the key to the page.
      const overlayOpen = openPopovers().length || openModalDialogs().length;
      if (
        (!overlayOpen || combination === KEY_COMBINATION_ACTION.ACTION_HINTS) &&
        this.keyCombinations[combination]()
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (this.readSettings().actionHintsEnabled === false) {
      return;
    }
    const editable =
      editableOwner(event.target) ?? editableOwner(document.activeElement);
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
    if (this.handleShortcutHelpEntry(event)) {
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
      return;
    }
    if (
      key === KEYBOARD_NAVIGATION_KEY.TASK_SWITCHER &&
      this.startTaskSwitcher()
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  private handleHintScrollSwitch(event: KeyboardEvent) {
    const session = this.actionHints.session;
    if (
      !session?.binding?.reservedCodes?.includes(
        KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT,
      ) ||
      session.buffer !== "" ||
      normalizeActionHintKey(event, {
        compositionActive: this.compositionActive,
      }) !== KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const context = this.resolveInteractionContext({
      ownedHintDialog: session.dialog,
    });
    const snapshot = context ? this.captureScrollSnapshot(context) : null;
    if (
      !snapshot ||
      snapshot.context.blocked ||
      snapshot.surfaces.length === 0
    ) {
      return true;
    }
    if (this.actionHints.cancel("scroll")) {
      this.startScroll();
    }
    return true;
  }

  private handleSelectionKeydown(event: KeyboardEvent) {
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
    if (this.selectionSession?.selector.allowsNativeActivation(event)) {
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

  private handleActiveKeydown(event: KeyboardEvent) {
    if (this.handleShortcutHelpEntry(event)) {
      return;
    }
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      !this.compositionActive &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
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
    if (key === KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      this.reselectScroll();
      return;
    }
    if (!Object.hasOwn(SCROLL_COMMAND, key)) {
      return;
    }
    const session = this.activeSession;
    if (
      !session ||
      !this.activeBindingIsCurrent(session, { refreshPresentation: true })
    ) {
      this.cancelActive("binding-invalidated");
      return;
    }
    const { scrollport } = session;
    const next = scrollCommandPosition({
      command: key,
      availableAxes: session.availableAxes,
      scrollTop: scrollport.scrollTop,
      scrollHeight: scrollport.scrollHeight,
      clientHeight: scrollport.clientHeight,
      scrollLeft: scrollport.scrollLeft,
      scrollWidth: scrollport.scrollWidth,
      clientWidth: scrollport.clientWidth,
    });
    if (
      next == null ||
      !this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_COMMAND)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next.axis === "vertical") {
      scrollport.scrollTop = next.position;
    } else {
      scrollport.scrollLeft = next.position;
    }
  }

  private handleShortcutHelpEntry(event: KeyboardEvent) {
    if (
      !matchesKeyboardNavigationKey(
        event,
        KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
        { compositionActive: this.compositionActive },
      )
    ) {
      return false;
    }
    const toggled = this.shortcutSession
      ? this.closeShortcutHelp("keyboard")
      : this.startShortcutHelp();
    if (!toggled) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  /**
   * Open keyboard shortcut help over whatever the person was doing.
   *
   * The help is an ordinary modal context rather than a mode of its own, so
   * Action Hint and Scroll work inside it. The modal dialogs it covers stay
   * open but out of reach until it closes.
   */
  private startShortcutHelp() {
    if (
      !this.shortcutDialog ||
      this.shortcutSession ||
      this.controlNode() === KEYBOARD_NAVIGATION_NODE.EDITING
    ) {
      return false;
    }
    const restoreTarget = this.shortcutHelpOpener();
    if (
      this.storedNode &&
      !this.cancelStoredMode("shortcut-help", { restoreFocus: false })
    ) {
      return false;
    }
    this.shortcutSession = {
      opener: restoreTarget,
      coveredModals: openModalDialogs(),
    };
    try {
      if (!this.shortcutDialog.open()) {
        throw new Error("Keyboard shortcut help did not open.");
      }
    } catch {
      this.shortcutSession = null;
      this.restoreFocus(restoreTarget);
      return false;
    }
    this.workspace.dataset.keyboardShortcutHelp = "open";
    return true;
  }

  private closeShortcutHelp(reason = "close", { restoreFocus = true } = {}) {
    const session = this.shortcutSession;
    if (!session) {
      return false;
    }
    // A mode started inside the help ends with it.
    if (this.storedNode) {
      this.cancelStoredMode(reason, { restoreFocus: false });
    }
    this.shortcutSession = null;
    this.shortcutDialog?.close();
    delete this.workspace.dataset.keyboardShortcutHelp;
    this.workspace.dataset.keyboardShortcutHelpLastExit = reason;
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    return true;
  }

  private shortcutHelpOpener() {
    return (
      this.actionHints.session?.opener ??
      this.selectionSession?.opener ??
      this.activeSession?.opener ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    );
  }

  private startActionHints() {
    const snapshot = this.actionHints.prepareSnapshot();
    if (!snapshot) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    if (!this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_STARTED)) {
      return false;
    }
    if (
      !this.actionHints.startSession(snapshot) &&
      this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT
    ) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED);
    }
    return true;
  }

  /**
   * Open the Task switcher and hand the Action Hint session to it.
   *
   * The switcher is an ordinary modal context rather than a mode of its own,
   * so this adds no control node: it opens the surface and, once its rows
   * have drawn in the next frame, enters Hint the same way the Action Hints
   * key does.
   */
  private startTaskSwitcher() {
    if (
      this.controlNode() !== KEYBOARD_NAVIGATION_NODE.NORMAL ||
      this.shortcutSession
    ) {
      return false;
    }
    if (!this.openTaskSwitcher()) {
      return false;
    }
    requestAnimationFrame(() => {
      if (this.controlNode() === KEYBOARD_NAVIGATION_NODE.NORMAL) {
        this.startActionHints();
      }
    });
    return true;
  }

  private continueActionHints({
    context: previous = null,
  }: {
    context?: ActionHintBinding["context"];
  } = {}) {
    if (this.controlNode() !== KEYBOARD_NAVIGATION_NODE.NORMAL) {
      return false;
    }
    const context = this.resolveInteractionContext();
    if (!context?.sessionBound || sameContextOwner(context, previous)) {
      return false;
    }
    return this.startActionHints();
  }

  private leaveEditing(editable: Element, target: HTMLElement) {
    if (
      !this.applyTransition(KEYBOARD_NAVIGATION_EVENT.EDITING_ENDED, {
        editable,
      })
    ) {
      return;
    }
    try {
      target.focus({ preventScroll: true });
    } catch {
      // A control can become non-focusable after the key event was accepted.
    }
  }

  private resolveEditingEscapeTarget(editable: Element) {
    const context = this.resolveInteractionContext();
    const escapeTarget = context?.editing?.escapeTarget;
    if (!context || !escapeTarget || !context.root.contains(editable)) {
      return null;
    }
    let target: Element | null;
    try {
      target = escapeTarget(editable);
    } catch {
      return null;
    }
    return context.root.contains(target) && focusableTarget(target)
      ? target
      : null;
  }

  private startScroll() {
    const context = this.resolveInteractionContext();
    if (!context) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.ENTRY_REJECTED);
      return false;
    }
    const snapshot = this.captureScrollSnapshot(context);
    if (
      !snapshot ||
      snapshot.context.blocked ||
      snapshot.surfaces.length === 0
    ) {
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
    if (
      !this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_STARTED)
    ) {
      return false;
    }
    return this.beginSelection(snapshot);
  }

  private reselectScroll() {
    const session = this.activeSession;
    if (
      !session ||
      !this.activeBindingIsCurrent(session, { refreshPresentation: true })
    ) {
      this.cancelActive("binding-invalidated");
      return false;
    }
    const context = this.resolveInteractionContext();
    const snapshot = context && this.captureScrollSnapshot(context);
    if (
      !snapshot ||
      snapshot.context.blocked ||
      snapshot.surfaces.length < 2 ||
      snapshot.context.kind === "popover"
    ) {
      return false;
    }
    return this.cancelActive("scroll-reselect") && this.startScroll();
  }

  private beginSelection(snapshot: ScrollSnapshot) {
    const session: SelectionSession = {
      ...snapshot,
      opener:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      selector: snapshot.context.selector,
      buffer: "",
      cleanup: [],
      mutationObserver: null,
      ownershipObserver: null,
      resizeObserver: null,
      revalidationQueued: false,
      revalidationAfterDrawQueued: false,
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

  private applySelectionInput(key: string) {
    const session = this.selectionSession;
    if (
      !session ||
      !this.applyTransition(
        KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_INPUT_CHANGED,
      )
    ) {
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

  private selectSurface(code: string | undefined) {
    const session = this.selectionSession;
    const surface = session?.surfaces.find(
      (candidate) => candidate.code === code,
    );
    if (!session || !surface) {
      return false;
    }
    if (!this.selectionSnapshotIsCurrent(session)) {
      this.cancelSelection("selection-invalidated");
      return false;
    }
    detachSignals(session);
    this.selectionSession = null;
    session.selector.close();
    this.restoreFocus(session.opener);
    if (
      !this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_SURFACE_SELECTED)
    ) {
      return false;
    }
    if (!this.beginActive(session, surface)) {
      this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
      return false;
    }
    return true;
  }

  private cancelSelection(reason = "cancel", { restoreFocus = true } = {}) {
    const session = this.selectionSession;
    if (!session) {
      return false;
    }
    detachSignals(session);
    this.selectionSession = null;
    session.selector.close();
    this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_SELECTION_CANCELLED);
    if (restoreFocus) {
      this.restoreFocus(session.opener);
    }
    this.workspace.dataset.scrollModeLastExit = reason;
    return true;
  }

  private beginActive(snapshot: ScrollSnapshot, surface: CodedScrollSurface) {
    const session: ActiveSession = {
      ...surface,
      opener:
        snapshot.opener instanceof HTMLElement
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
      revalidationAfterDrawQueued: false,
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

  private cancelActive(reason = "cancel") {
    const session = this.activeSession;
    if (!session) {
      return false;
    }
    detachSignals(session);
    this.activeSession = null;
    session.context.hud.close();
    this.applyTransition(KEYBOARD_NAVIGATION_EVENT.SCROLL_CANCELLED);
    delete this.workspace.dataset.scrollMode;
    this.workspace.dataset.scrollModeLastExit = reason;
    this.reportDismissal(
      session.context.root,
      session.context.sessionBound,
      reason,
    );
    return true;
  }

  private cancelScroll(
    reason: string,
    options: { restoreFocus?: boolean } = {},
  ) {
    return this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING
      ? this.cancelSelection(reason, options)
      : this.storedNode === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE
        ? this.cancelActive(reason)
        : false;
  }

  cancelStoredMode(reason: string, options: { restoreFocus?: boolean } = {}) {
    if (this.storedNode === KEYBOARD_NAVIGATION_NODE.HINT) {
      return this.actionHints.cancel(reason, options);
    }
    return this.cancelScroll(reason, options);
  }

  private handleHintSessionExit({
    activated = false,
    reason = "",
    context = null,
  }: Partial<ActionHintSessionExit> = {}) {
    if (this.storedNode !== KEYBOARD_NAVIGATION_NODE.HINT) {
      return;
    }
    this.applyTransition(
      activated
        ? KEYBOARD_NAVIGATION_EVENT.HINT_CLOSED_FOR_ACTIVATION
        : KEYBOARD_NAVIGATION_EVENT.HINT_CANCELLED,
    );
    if (!activated && context) {
      this.reportDismissal(context.root, context.sessionBound, reason);
    }
  }

  private reportDismissal(
    root: Element,
    sessionBound: boolean,
    reason: string,
  ) {
    if (!sessionBound || !KEYBOARD_SESSION_DISMISSAL_REASONS.has(reason)) {
      return;
    }
    root.dispatchEvent(
      new CustomEvent(KEYBOARD_SESSION_DISMISS_EVENT, { bubbles: true }),
    );
  }

  private applyTransition(
    event: KeyboardNavigationEvent,
    { editable = null }: { editable?: Element | null } = {},
  ) {
    const current = this.controlNode(editable);
    const next = transitionKeyboardNavigation(current, event);
    if (!next) {
      return null;
    }
    this.storedNode =
      next === KEYBOARD_NAVIGATION_NODE.HINT ||
      next === KEYBOARD_NAVIGATION_NODE.SCROLL_SELECTING ||
      next === KEYBOARD_NAVIGATION_NODE.SCROLL_ACTIVE
        ? next
        : null;
    return { current, next };
  }

  private controlNode(editable: Element | null = null): KeyboardNavigationNode {
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

  // The context in front: the one open popover, else the one open modal,
  // else the workspace. Nothing when that is ambiguous or unregistered.
  private resolveInteractionContext({
    ignoreOwnedSelector = false,
    ownedHintDialog = null,
  }: {
    ignoreOwnedSelector?: boolean;
    ownedHintDialog?: { ownsModal(element: Element): boolean } | null;
  } = {}) {
    const contexts = this.safeCollectKeyboardNavigationContexts();
    if (!contexts) {
      return null;
    }
    const covered = this.shortcutSession?.coveredModals ?? [];
    const modals = openModalDialogs().filter(
      (modal) =>
        !covered.includes(modal) &&
        !(
          ignoreOwnedSelector &&
          this.selectionSession?.selector.ownsModal(modal)
        ) &&
        !ownedHintDialog?.ownsModal(modal),
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

  private safeCollectKeyboardNavigationContexts() {
    try {
      return normalizeKeyboardNavigationContexts(
        this.collectKeyboardNavigationContexts(),
      );
    } catch {
      return null;
    }
  }

  private resolveActionHintBinding(): ActionHintBinding | null {
    const ownedHintDialog = this.actionHints.session?.dialog ?? null;
    const context = this.resolveInteractionContext({ ownedHintDialog });
    const dialog: CaffoldActionHintDialog | null | undefined =
      context?.presentation.actionHintDialog();
    return context?.actionHints && dialog
      ? {
          context,
          dialog,
          scope: context.actionHints,
          reservedCodes: context.sessionBound
            ? [KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT]
            : [],
        }
      : null;
  }

  private captureScrollSnapshot(
    context: NormalizedKeyboardNavigationContext,
  ): ScrollSnapshot | null {
    const scope = context.scroll;
    const hud = context.presentation.scrollModeHud();
    const selector = context.presentation.scrollSurfaceSelector();
    if (
      !scope ||
      !hud ||
      !selector ||
      !context.root.isConnected ||
      !hasLayoutBox(context.root)
    ) {
      return null;
    }
    const scrollContext: ScrollContext = {
      id: context.id,
      kind: context.kind,
      root: context.root,
      presentation: context.presentation,
      sessionBound: context.sessionBound,
      hud,
      selector,
      ...scope,
    };
    const viewport = captureViewport();
    const contextRect = normalizedContextRect(context.root, viewport.rect);
    if (!contextRect) {
      return null;
    }
    const visible = scope.surfaces.flatMap((surface) => {
      const availableAxes = scrollSurfaceAvailableAxes(surface, context.root);
      if (!availableAxes?.length) {
        return [];
      }
      const visibleRect = visibleScrollSurfaceRect(
        surface.scrollport.getBoundingClientRect(),
        [
          context.root.getBoundingClientRect(),
          ...surface.clipRoots.map((root) => root.getBoundingClientRect()),
        ],
        viewport.rect,
      );
      return visibleRect ? [{ ...surface, availableAxes, visibleRect }] : [];
    });
    let surfaces: CodedScrollSurface[];
    try {
      surfaces = allocateScrollSurfaceCodes(orderScrollSurfaces(visible));
    } catch {
      return null;
    }
    return { context: scrollContext, contextRect, viewport, surfaces };
  }

  private selectionSnapshotIsCurrent(session: SelectionSession) {
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

  private activeBindingIsCurrent(
    session: ActiveSession,
    { refreshPresentation = false } = {},
  ) {
    if (this.hasUnregisteredInteractionOwner()) {
      return false;
    }
    const context = this.resolveInteractionContext();
    const snapshot = context && this.captureScrollSnapshot(context);
    const surface = snapshot?.surfaces.find(({ id }) => id === session.id);
    const current =
      snapshot && surface
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

  private showActiveHud(session: ActiveSession) {
    return Boolean(
      session.contextRect &&
        session.context.hud.show({
          label: session.label,
          visibleRect: session.visibleRect,
          contextRect: session.contextRect,
        }),
    );
  }

  private attachSelectionSignals(session: SelectionSession) {
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
        this.queueSelectionRevalidation(session, { afterDraw: true }),
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
        this.queueSelectionRevalidation(session),
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

  private attachActiveSignals(session: ActiveSession) {
    for (const root of session.scrollRoots) {
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
        this.queueActiveRevalidation(session, { afterDraw: true }),
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
        this.queueActiveRevalidation(session),
      );
      for (const element of session.resizeElements) {
        session.resizeObserver.observe(element);
      }
    }
    const root = session.context.root;
    if (session.context.kind === "modal") {
      const close = () => this.cancelActive("context-closed");
      root.addEventListener("close", close);
      session.cleanup.push(() => root.removeEventListener("close", close));
    } else if (session.context.kind === "popover") {
      const close = (event: Event) => {
        if ((event as ToggleEvent).newState === "closed") {
          this.cancelActive("context-closed");
        }
      };
      root.addEventListener("beforetoggle", close);
      session.cleanup.push(() =>
        root.removeEventListener("beforetoggle", close),
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

  private attachViewportSignals(session: SessionSignals, listener: () => void) {
    window.addEventListener("resize", listener, { passive: true });
    window.addEventListener("scroll", listener, { passive: true });
    session.cleanup.push(() => {
      window.removeEventListener("resize", listener);
      window.removeEventListener("scroll", listener);
    });
    const visual = window.visualViewport;
    if (visual) {
      visual.addEventListener("resize", listener, { passive: true });
      visual.addEventListener("scroll", listener, { passive: true });
      session.cleanup.push(() => {
        visual.removeEventListener("resize", listener);
        visual.removeEventListener("scroll", listener);
      });
    }
  }

  private attachOwnershipSignals(
    session: SessionSignals,
    revalidate: SignalRevalidation,
  ) {
    if (typeof MutationObserver === "function" && document.documentElement) {
      session.ownershipObserver = new MutationObserver(() => revalidate());
      session.ownershipObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["open"],
        subtree: true,
      });
    }
    const handleBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "open") {
        revalidate({ opening: true, owner: event.target });
      }
    };
    document.addEventListener("beforetoggle", handleBeforeToggle, true);
    session.cleanup.push(() =>
      document.removeEventListener("beforetoggle", handleBeforeToggle, true),
    );
  }

  private queueSelectionRevalidation(
    session: SelectionSession,
    options?: { afterDraw: boolean },
  ) {
    queueRevalidation(session, options, () => {
      if (
        this.selectionSession === session &&
        !this.selectionSnapshotIsCurrent(session)
      ) {
        this.cancelSelection("snapshot-invalidated");
      }
    });
  }

  private queueActiveRevalidation(
    session: ActiveSession,
    options?: { afterDraw: boolean },
  ) {
    queueRevalidation(session, options, () => {
      if (
        this.activeSession === session &&
        !this.activeBindingIsCurrent(session, { refreshPresentation: true })
      ) {
        this.cancelActive("binding-invalidated");
      }
    });
  }

  private hasHintInteractionOwner(binding: ActionHintBinding | null = null) {
    const context = this.resolveInteractionContext({
      ownedHintDialog: binding?.dialog ?? null,
    });
    return !sameContextOwner(context, binding?.context ?? null);
  }

  private hasUnregisteredInteractionOwner({
    ignoreOwnedSelector = false,
  } = {}) {
    const popovers = openPopovers();
    const modals = openModalDialogs().filter(
      (modal) =>
        !(
          ignoreOwnedSelector &&
          this.selectionSession?.selector.ownsModal(modal)
        ),
    );
    if (!popovers.length && !modals.length) {
      return false;
    }
    return !this.resolveInteractionContext({ ignoreOwnedSelector });
  }

  private restoreFocus(element: Element | null | undefined) {
    if (!focusableTarget(element)) {
      return;
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      // A control can become non-focusable between validation and focus.
    }
  }

  private clearComposition() {
    this.compositionActive = false;
    this.compositionOwner = null;
  }
}

function scrollSurfaceAvailableAxes(
  surface: ContextScrollSurface,
  root: Element,
) {
  try {
    if (
      !(
        surface.scrollport.isConnected &&
        contextContains(root, surface.scrollport) &&
        hasLayoutBox(surface.scrollport)
      )
    ) {
      return null;
    }
    return availableScrollAxes(surface.scrollport, surface.axes);
  } catch {
    return null;
  }
}

function contextContains(root: Element, element: Element) {
  if (root.contains(element)) {
    return true;
  }
  let currentRoot = element.getRootNode();
  while (currentRoot instanceof ShadowRoot) {
    const host = currentRoot.host;
    if (host === root || root.contains(host)) {
      return true;
    }
    currentRoot = host.getRootNode();
  }
  return false;
}

function hasLayoutBox(element: Element | null | undefined) {
  return Boolean(element?.getClientRects().length);
}

function scrollPosition(element: Element) {
  return {
    left: Number(element.scrollLeft ?? 0),
    top: Number(element.scrollTop ?? 0),
  };
}

function sameScrollPosition(
  left: { left: number; top: number },
  right: { left: number; top: number },
) {
  return left.left === right.left && left.top === right.top;
}

function captureViewport(): Viewport {
  const visual = window.visualViewport;
  const left = Number(visual?.offsetLeft ?? 0);
  const top = Number(visual?.offsetTop ?? 0);
  const width = Number(
    visual?.width ?? document.documentElement?.clientWidth ?? window.innerWidth,
  );
  const height = Number(
    visual?.height ??
      document.documentElement?.clientHeight ??
      window.innerHeight,
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

function editableOwner(element: EventTarget | null) {
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

function focusableTarget(
  element: Element | null | undefined,
): element is HTMLElement {
  return Boolean(
    element instanceof HTMLElement &&
      element.isConnected &&
      !element.hidden &&
      !(element as HTMLElement & { disabled?: boolean }).disabled &&
      element.getClientRects().length,
  );
}

function openPopovers() {
  try {
    return [...document.querySelectorAll(":popover-open")];
  } catch {
    return [];
  }
}

function sameContextOwner(
  left: { id: string; kind: string; root: Element } | null | undefined,
  right: { id: string; kind: string; root: Element } | null | undefined,
) {
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

function detachSignals(session: SessionSignals) {
  session.mutationObserver?.disconnect();
  session.ownershipObserver?.disconnect();
  session.resizeObserver?.disconnect();
  for (const cleanup of session.cleanup) {
    cleanup();
  }
  session.cleanup = [];
}

// Revalidates once for each burst of signals. A DOM change waits for the next
// frame, by which Lit has drawn everything it set off however deeply the
// owners nest; a size or scroll change is read at once.
function queueRevalidation(
  session: SessionSignals,
  options: { afterDraw: boolean } | undefined,
  revalidate: () => void,
) {
  if (options?.afterDraw) {
    if (session.revalidationAfterDrawQueued) {
      return;
    }
    session.revalidationAfterDrawQueued = true;
    requestAnimationFrame(() => {
      session.revalidationAfterDrawQueued = false;
      revalidate();
    });
    return;
  }
  if (session.revalidationQueued) {
    return;
  }
  session.revalidationQueued = true;
  queueMicrotask(() => {
    session.revalidationQueued = false;
    revalidate();
  });
}
