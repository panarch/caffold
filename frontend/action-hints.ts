import {
  type ActionHintScope,
  type ActionHintTarget,
  buttonActionHintTarget,
  captureLinkActionHintBinding,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
  radioActionHintTarget,
  rangeActionHintTarget,
  reorderHandleActionHintTarget,
  selectActionHintTarget,
  separatorActionHintTarget,
  switchActionHintTarget,
  textboxActionHintTarget,
  withActionHintOcclusionRoots,
} from "./action-hint-scope.ts";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "./action-hints/control.ts";
import {
  ACTION_HINT_ACTION,
  type ActionHintViewport,
  advanceHintBuffer,
  allocateActionHintCodes,
  clampBadgePosition,
  type HintProgress,
  intersectRects,
  isEditableElement,
  matchesActionHintPolicy,
  normalizeActionHintKey,
  normalizeRect,
  type Rect,
  reconcileActionHintTargets,
  rectsEqual,
  sameActionHintTargetBinding,
  sameActionHintViewport,
  sortByVisualOrder,
  TASK_HINT_ALPHABET,
  taskHintSuffix,
  visibleTargetRect,
} from "./action-hints/model.ts";

export {
  type ActionHintDeclaration,
  type ActionHintPull,
  ActionHints,
} from "./action-hints/declarations.ts";
export type {
  ActionFor,
  ActionHintAction,
  HintProgress,
  Rect,
} from "./action-hints/model.ts";

export {
  ACTION_HINT_ACTION,
  advanceHintBuffer,
  buttonActionHintTarget,
  captureLinkActionHintBinding,
  clampBadgePosition,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  intersectRects,
  isEditableElement,
  linkActionHintLabel,
  linkActionHintTarget,
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
  selectActionHintTarget,
  separatorActionHintTarget,
  sortByVisualOrder,
  switchActionHintTarget,
  TASK_HINT_ALPHABET,
  taskHintSuffix,
  textboxActionHintTarget,
  withActionHintOcclusionRoots,
};

// The dialog a context draws its Action Hint badges in.
export interface ActionHintPresentation extends HTMLElement {
  open(
    targets: readonly ActionHintSessionTarget[],
    viewportRect: Rect | null,
  ): void;
  close(): void;
  allowsNativeActivation(event: KeyboardEvent): boolean;
  ownsModal(element: Element): boolean;
  updateInput(progress: HintProgress): void;
  reconcileTargets(
    targets: readonly ActionHintSessionTarget[],
    viewportRect: Rect | null,
  ): boolean;
}

// A target as the controller measured it at capture or revalidation.
interface DescriptorState extends ActionHintTarget {
  activationKey: string;
  occlusionRoots: Element[];
  actionable: boolean;
  visibleRect: Rect | null;
}

// A target in a session: visible when captured, with the code it was given.
export interface ActionHintSessionTarget extends DescriptorState {
  visibleRect: Rect;
  code: string;
}

// The context a session belongs to, as far as the controller compares it.
interface ActionHintBindingContext {
  id: string;
  kind: string;
  root: Element;
  sessionBound: boolean;
}

export interface ActionHintBinding {
  context: ActionHintBindingContext | null;
  dialog: ActionHintPresentation;
  scope: ActionHintScope;
  reservedCodes?: string[];
}

interface ActionHintSnapshot {
  targets: ActionHintSessionTarget[];
  viewport: ActionHintViewport;
  mutationRoots: Node[];
  scrollRoots: Element[];
  resizeElements: Element[];
  binding?: ActionHintBinding | null;
}

interface ActionHintSession extends ActionHintSnapshot {
  binding: ActionHintBinding;
  dialog: ActionHintPresentation;
  opener: HTMLElement | null;
  buffer: string;
  cleanup: Array<() => void>;
  mutationObserver: MutationObserver | null;
  observedMutationRoots: Node[];
  observedResizeElements: Element[];
  observedScrollRoots: Element[];
  ownershipObserver: MutationObserver | null;
  revalidationQueued: boolean;
  resizeObserver: ResizeObserver | null;
  scrollCleanup: Array<() => void>;
}

// How a session ended, for its owner.
export interface ActionHintSessionExit {
  activated: boolean;
  reason?: string;
  target?: ActionHintSessionTarget;
  context: ActionHintBindingContext | null;
}

export interface ActionHintControllerOptions {
  workspace: HTMLElement;
  dialog?: ActionHintPresentation | null;
  collectScope?: () => ActionHintScope | null;
  collectBinding?: (() => ActionHintBinding | null) | null;
  afterActivation?: (
    target: ActionHintSessionTarget,
    activation: { context: ActionHintBindingContext | null },
  ) => void;
  hasOtherInteractionOwner?: (binding: ActionHintBinding | null) => boolean;
  isCompositionActive?: () => boolean;
  onSessionExit?: (exit: ActionHintSessionExit) => void;
}

type CancelDetail = {
  reason?: string;
  originalEvent?: Event & { isComposing?: boolean };
};

export class ActionHintController {
  private readonly workspace: HTMLElement;
  private readonly dialog: ActionHintPresentation | null;
  private readonly collectScope: () => ActionHintScope | null;
  private readonly collectBinding: (() => ActionHintBinding | null) | null;
  private readonly afterActivation: NonNullable<
    ActionHintControllerOptions["afterActivation"]
  >;
  private readonly hasOtherInteractionOwner: (
    binding: ActionHintBinding | null,
  ) => boolean;
  private readonly isCompositionActive: () => boolean;
  private readonly onSessionExit: (exit: ActionHintSessionExit) => void;
  private connected: boolean;
  session: ActionHintSession | null;
  private readonly boundActivate: (event: Event) => void;
  private readonly boundCancel: (event: Event) => void;

  constructor({
    workspace,
    dialog = null,
    collectScope = () => null,
    collectBinding = null,
    afterActivation = () => {},
    hasOtherInteractionOwner = () => false,
    isCompositionActive = () => false,
    onSessionExit = () => {},
  }: ActionHintControllerOptions) {
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
      this.activate(
        `${(event as CustomEvent<{ code?: string }>).detail?.code ?? ""}`,
      );
    };
    this.boundCancel = (event) => {
      event.stopPropagation();
      const detail = (event as CustomEvent<CancelDetail>).detail;
      if (
        detail?.reason === "escape" &&
        (this.isCompositionActive() || detail?.originalEvent?.isComposing)
      ) {
        return;
      }
      this.cancel(detail?.reason ?? "dialog");
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

  prepareSnapshot(): ActionHintSnapshot | null {
    const binding = this.safeCollectBinding();
    const scope = binding?.scope;
    if (!scope || scope.blocked) {
      return null;
    }
    const snapshot = this.captureSnapshot(scope, binding ?? {});
    return snapshot?.targets.length ? { ...snapshot, binding } : null;
  }

  handleHintKeydown(
    event: KeyboardEvent,
    { compositionActive = false }: { compositionActive?: boolean } = {},
  ) {
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

  private applyInput(key: string) {
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

  startSession(snapshot: ActionHintSnapshot | null) {
    if (this.session || !snapshot?.targets?.length) {
      return false;
    }
    const dialog = snapshot.binding?.dialog ?? this.dialog;
    if (!dialog) {
      return false;
    }
    const binding: ActionHintBinding = snapshot.binding ?? {
      context: null,
      dialog,
      scope: emptyActionHintScope(),
    };
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const session: ActionHintSession = {
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
        this.onSessionExit({
          activated: false,
          reason: "open-failed",
          context: session.binding.context,
        });
      }
      return false;
    }
  }

  cancel(
    reason = "cancel",
    { restoreFocus = true }: { restoreFocus?: boolean } = {},
  ) {
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
    this.onSessionExit({
      activated: false,
      reason,
      context: session.binding.context,
    });
    return true;
  }

  activate(code: string) {
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
    this.onSessionExit({
      activated: true,
      target: requestedTarget,
      context: session.binding.context,
    });
    if (!this.revalidateSnapshot(session)) {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-invalidated";
      return false;
    }
    const target = session.targets.find((candidate) => candidate.code === code);
    if (!target) {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-invalidated";
      return false;
    }
    try {
      target.activate();
      this.afterActivation(target, { context: session.binding.context });
      this.workspace.dataset.actionHintLastExit = `activated:${target.code}`;
      return true;
    } catch {
      this.restoreFocus(session.opener);
      this.workspace.dataset.actionHintLastExit = "activation-failed";
      return false;
    }
  }

  private restoreFocus(element: HTMLElement | null) {
    if (!element || !focusableTarget(element)) {
      return;
    }
    try {
      element.focus({ preventScroll: true });
    } catch {
      // A control can become non-focusable between validation and focus.
    }
  }

  private closeSession(session: ActionHintSession) {
    if (this.session !== session) {
      return false;
    }
    this.session = null;
    this.detachSessionSignals(session);
    session.dialog.close();
    return true;
  }

  private attachDialogSignals(session: ActionHintSession) {
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

  private attachSessionSignals(session: ActionHintSession) {
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
    const visualViewport = window.visualViewport;
    if (visualViewport) {
      visualViewport.addEventListener("resize", revalidateViewport, {
        passive: true,
      });
      visualViewport.addEventListener("scroll", revalidateViewport, {
        passive: true,
      });
      session.cleanup.push(() => {
        visualViewport.removeEventListener("resize", revalidateViewport);
        visualViewport.removeEventListener("scroll", revalidateViewport);
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
    const handleBeforeToggle = (event: Event) => {
      const toggle = event as ToggleEvent;
      if (
        toggle.newState === "closed" &&
        toggle.target === session.binding?.context?.root
      ) {
        this.cancel("context-closed", { restoreFocus: false });
        return;
      }
      if (
        toggle.newState === "open" &&
        !session.dialog.contains?.(toggle.target as Node | null)
      ) {
        this.cancel("interaction-owner");
      }
    };
    document.addEventListener("beforetoggle", handleBeforeToggle, true);
    session.cleanup.push(() =>
      document.removeEventListener("beforetoggle", handleBeforeToggle, true),
    );
    this.replaceRevalidationSignals(session);
  }

  private detachSessionSignals(session: ActionHintSession) {
    this.detachRevalidationSignals(session);
    session.ownershipObserver?.disconnect();
    session.ownershipObserver = null;
    for (const cleanup of session.cleanup ?? []) {
      cleanup();
    }
    session.cleanup = [];
  }

  private detachRevalidationSignals(session: ActionHintSession) {
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

  private replaceRevalidationSignals(session: ActionHintSession) {
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
    if (
      typeof MutationObserver === "function" &&
      session.mutationRoots.length
    ) {
      session.mutationObserver = new MutationObserver((records) => {
        if (
          records.every((record) => session.dialog.contains?.(record.target))
        ) {
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
        root.removeEventListener("scroll", revalidate),
      );
    }
    session.observedMutationRoots = [...session.mutationRoots];
    session.observedResizeElements = [...session.resizeElements];
    session.observedScrollRoots = [...session.scrollRoots];
  }

  private queueRevalidation(session: ActionHintSession) {
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

  private revalidateSnapshot(
    snapshot: ActionHintSnapshot & { buffer?: string },
    { refreshPresentation = false }: { refreshPresentation?: boolean } = {},
  ) {
    try {
      return this.reconcileSnapshot(snapshot, { refreshPresentation });
    } catch {
      return false;
    }
  }

  private reconcileSnapshot(
    snapshot: ActionHintSnapshot & { buffer?: string },
    { refreshPresentation = false }: { refreshPresentation?: boolean } = {},
  ) {
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
      reconciliation.targets.flatMap(
        ({ anchor, clipRoots, occlusionRoots }) => [
          anchor,
          ...clipRoots,
          ...(occlusionRoots ?? []),
        ],
      ),
    );
    if (this.session === snapshot) {
      this.replaceRevalidationSignals(this.session);
    }
    if (refreshPresentation) {
      const dialog = snapshot.binding?.dialog ?? this.dialog;
      if (!dialog?.reconcileTargets(snapshot.targets, snapshot.viewport.rect)) {
        return false;
      }
      dialog.updateInput(presentation);
    }
    return true;
  }

  private captureSnapshot(
    scope: ActionHintScope,
    { reservedCodes = [] }: { reservedCodes?: string[] } = {},
  ): ActionHintSnapshot | null {
    let state: ReturnType<ActionHintController["captureScopeState"]>;
    try {
      state = this.captureScopeState(scope);
    } catch {
      return null;
    }
    if (!state) {
      return null;
    }
    const { descriptorStates, ...snapshot } = state;
    let targets: ActionHintSessionTarget[];
    try {
      targets = allocateActionHintCodes(
        sortByVisualOrder(
          descriptorStates.filter(
            (
              descriptor,
            ): descriptor is DescriptorState & { visibleRect: Rect } =>
              descriptor.actionable && descriptor.visibleRect !== null,
          ),
        ),
        { reserved: reservedCodes },
      );
    } catch {
      return null;
    }
    return { ...snapshot, targets };
  }

  private captureScopeState(scope: ActionHintScope) {
    const descriptors = normalizeDescriptors(scope.targets);
    const mutationRoots = normalizeMutationRootList(scope.mutationRoots ?? []);
    const scrollRoots = normalizeElementList(scope.scrollRoots ?? []);
    if (!descriptors || !mutationRoots || !scrollRoots) {
      return null;
    }
    const viewport = captureViewport();
    const descriptorStates = descriptors.map((descriptor): DescriptorState => {
      const actionable = descriptorIsActionable(descriptor);
      const anchorRect = actionable
        ? normalizeRect(descriptor.anchor.getBoundingClientRect())
        : null;
      const clipRects = actionable
        ? descriptor.clipRoots.map((root) => root.getBoundingClientRect())
        : [];
      const occlusionRects = actionable
        ? descriptor.occlusionRoots.map((root) => root.getBoundingClientRect())
        : [];
      return {
        ...descriptor,
        actionable,
        visibleRect: actionable
          ? visibleTargetRect(
              anchorRect,
              clipRects,
              viewport.rect,
              occlusionRects,
            )
          : null,
      };
    });
    const dependencyElements = uniqueElements(
      descriptors.flatMap(({ clipRoots, occlusionRoots }) => [
        ...clipRoots,
        ...occlusionRoots,
      ]),
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

  private safeCollectScope() {
    try {
      return this.collectScope() ?? null;
    } catch {
      return null;
    }
  }

  private safeCollectBinding(): ActionHintBinding | null {
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

function normalizeMutationRootList(roots: unknown): Node[] | null {
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
  return uniqueValues(roots as Node[]);
}

function sameActionHintBinding(
  left: ActionHintBinding | null | undefined,
  right: ActionHintBinding | null | undefined,
) {
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

function normalizeDescriptors(targets: unknown) {
  if (!Array.isArray(targets)) {
    return null;
  }
  const ids = new Set<string>();
  const descriptors: Array<
    ActionHintTarget & { activationKey: string; occlusionRoots: Element[] }
  > = [];
  for (const target of targets) {
    const id = `${target?.id ?? ""}`;
    const actionId = `${target?.actionId ?? ""}`;
    const label = `${target?.label ?? ""}`;
    const activationKey =
      target?.activationKey == null ? "" : `${target.activationKey}`;
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
      typeof target?.activate !== "function"
    ) {
      return null;
    }
    const clipRoots = normalizeElementList(target.clipRoots ?? []);
    const occlusionRoots = normalizeElementList(target.occlusionRoots ?? []);
    if (!clipRoots || !occlusionRoots) {
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
      occlusionRoots,
      badgeAtEnd: Boolean(target.badgeAtEnd),
    });
  }
  return descriptors;
}

function descriptorIsActionable(descriptor: ActionHintTarget) {
  try {
    return Boolean(
      descriptor.invalidationOwner.isConnected &&
        descriptor.control.isConnected &&
        descriptor.anchor.isConnected &&
        !(descriptor.control as HTMLElement & { disabled?: boolean }).disabled,
    );
  } catch {
    return false;
  }
}

function captureViewport(): ActionHintViewport {
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

function uniqueElements(elements: Array<Element | null | undefined>) {
  const unique: Element[] = [];
  const seen = new Set<Element>();
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

function uniqueValues<Value>(values: Value[]) {
  const unique: Value[] = [];
  const seen = new Set<Value>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}

function sameElementCollection(left: unknown, right: unknown[]) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  return (
    left.length === right.length &&
    left.every((element) => right.includes(element))
  );
}

function normalizeElementList(elements: unknown): Element[] | null {
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
  return uniqueElements(elements as Element[]);
}

function focusableTarget(element: HTMLElement) {
  return Boolean(
    element instanceof HTMLElement &&
      element.isConnected &&
      !element.hidden &&
      !(element as HTMLElement & { disabled?: boolean }).disabled &&
      element.getClientRects().length,
  );
}
