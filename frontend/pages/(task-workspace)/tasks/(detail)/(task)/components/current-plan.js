import { getCurrentPlan } from "../../../../../../api.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import { subscribeToWatch, watchChangeAffectsPath } from "../../../../../../watch.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../../../action-hints.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
  popoverScrollSurfaceScope,
} from "../../../../../../keyboard-navigation.js";
import "../../../../../../keyboard-navigation/components/presentation.js";
import {
  CURRENT_PLAN_NODE,
  currentPlanDocumentDisplayPath,
  currentPlanDocumentPaths,
  currentPlanPresentation,
  currentPlanTransitionAllowed,
  normalizeCurrentPlanProjection,
} from "./current-plan/model.js";
import "./current-plan/components/document-dialog.js";

let currentPlanInstanceId = 0;

class CaffoldTaskCurrentPlan extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    this.ensureState();
    this.refreshIcons();
    warmIcons();
    if (this.context) {
      this.requestRead();
    }
  }

  disconnectedCallback() {
    this.deactivate();
    if (this.iconsReadyListening) {
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
      this.iconsReadyListening = false;
    }
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.refreshIcons();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  ensureState() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    currentPlanInstanceId += 1;
    this.statusPopoverId = `task-current-plan-status-${currentPlanInstanceId}`;
    this.node = CURRENT_PLAN_NODE.INACTIVE;
    this.context = null;
    this.contextGeneration = 0;
    this.requestId = 0;
    this.requestController = null;
    this.liveUpdates = null;
    this.watchPath = "";
    this.watchUnsubscribe = null;
    this.projection = null;
    this.readError = null;
    this.watchError = null;
    this.renderedIssuesKey = "";
    this.render();
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener(
      KEYBOARD_SESSION_DISMISS_EVENT,
      (event) => this.handleDismiss(event),
    );
  }

  setLiveUpdates(liveUpdates) {
    this.ensureState();
    const next = liveUpdates ?? null;
    if (this.liveUpdates === next) {
      return;
    }
    this.liveUpdates = next;
    this.releaseWatch();
    if (this.context && this.isConnected) {
      this.requestRead();
    }
  }

  setContext({ threadId, cwd, rootPath } = {}) {
    this.ensureState();
    const next = {
      threadId: `${threadId ?? ""}`.trim(),
      cwd: `${cwd ?? ""}`.trim(),
      rootPath: `${rootPath ?? cwd ?? ""}`.trim(),
    };
    if (!next.threadId || !next.cwd) {
      this.deactivate();
      return;
    }
    if (
      this.context?.threadId === next.threadId &&
      this.context?.cwd === next.cwd &&
      this.context?.rootPath === next.rootPath
    ) {
      return;
    }

    this.clearActivation();
    this.context = next;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE, { patch: false });
    }
    if (this.isConnected) {
      this.requestRead();
    } else {
      this.patch();
    }
  }

  deactivate() {
    if (!this.initialized) {
      return;
    }
    this.clearActivation();
    this.context = null;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE);
    } else {
      this.patch();
    }
  }

  clearActivation() {
    this.contextGeneration += 1;
    this.invalidateRequest();
    this.releaseWatch();
    this.documentDialog().deactivate();
    this.hideStatusPopover();
    this.projection = null;
    this.readError = null;
    this.watchError = null;
  }

  requestRead() {
    if (!this.context || !this.isConnected) {
      return;
    }
    if (this.transition(CURRENT_PLAN_NODE.READING)) {
      void this.readProjection();
    }
  }

  async readProjection() {
    const context = this.context;
    const generation = this.contextGeneration;
    const requestId = ++this.requestId;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    let projection = null;
    let readError = null;
    try {
      projection = normalizeCurrentPlanProjection(
        await getCurrentPlan(context.cwd, controller.signal),
      );
    } catch (error) {
      if (error?.name === "AbortError") {
        return;
      }
      readError = error instanceof Error ? error : new Error(`${error}`);
    }
    if (!this.acceptRead(generation, requestId, context)) {
      return;
    }
    this.requestController = null;
    if (readError) {
      this.readError = readError;
      // Without a subscribed Watch, the Task cwd supplies the ready, reconnect,
      // and change events that retry a failed read.
      if (!this.watchUnsubscribe) {
        this.bindWatch(context.cwd, generation);
      }
    } else {
      this.projection = projection;
      this.readError = null;
      this.bindWatch(projection.watchPath, generation);
    }
    this.transition(CURRENT_PLAN_NODE.SETTLED);
  }

  acceptRead(generation, requestId, context) {
    return (
      this.isConnected &&
      this.node === CURRENT_PLAN_NODE.READING &&
      generation === this.contextGeneration &&
      requestId === this.requestId &&
      context === this.context
    );
  }

  bindWatch(path, generation) {
    if (this.watchUnsubscribe && this.watchPath === path) {
      return;
    }
    // A reported interruption stays until the replacement Watch is ready.
    this.releaseWatch();
    this.watchPath = path;
    let readyObserved = false;
    this.watchUnsubscribe = subscribeToWatch(this.liveUpdates, path, {
      onReady: ({ recovered }) => {
        if (!this.acceptWatch(generation, path)) {
          return;
        }
        const closesRegistrationGap = !readyObserved;
        readyObserved = true;
        const interrupted = Boolean(this.watchError);
        this.watchError = null;
        if (closesRegistrationGap || recovered || interrupted || this.readError) {
          this.requestRead();
        }
      },
      onRecover: () => {
        if (this.acceptWatch(generation, path)) {
          this.requestRead();
        }
      },
      onChange: (change) => {
        if (!this.acceptWatch(generation, path)) {
          return;
        }
        const documents = currentPlanDocumentPaths(this.projection);
        if (
          documents.length === 0 ||
          documents.some((document) => watchChangeAffectsPath(change, document))
        ) {
          this.documentDialog().refreshOpenDocument();
          this.requestRead();
        }
      },
      onError: (error) => {
        if (!this.acceptWatch(generation, path)) {
          return;
        }
        this.watchError = error instanceof Error ? error : new Error(`${error}`);
        this.patch();
      },
    });
  }

  acceptWatch(generation, path) {
    return (
      this.isConnected &&
      generation === this.contextGeneration &&
      this.watchPath === path
    );
  }

  releaseWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
  }

  invalidateRequest() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
  }

  transition(next, { patch = true } = {}) {
    if (!currentPlanTransitionAllowed(this.node, next)) {
      return false;
    }
    this.node = next;
    this.dataset.lifecycle = next;
    if (patch) {
      this.patch();
    }
    return true;
  }

  handleClick(event) {
    const button = event.target.closest?.("[data-current-plan-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.currentPlanAction;
    if (action === "refresh") {
      this.requestRead();
      return;
    }
    const plan = this.projection?.plan;
    const document = action === "plan"
      ? plan?.planDocument
      : action === "checklist"
        ? plan?.checklistDocument
        : null;
    if (document) {
      this.documentDialog().openDocument({
        label: action === "plan" ? "Plan" : "Checklist",
        document,
        displayPath: currentPlanDocumentDisplayPath(
          document.path,
          this.context?.rootPath,
        ),
        opener: button,
      });
    }
  }

  handleDismiss(event) {
    if (event.target === this.statusPopover()) {
      this.hideStatusPopover();
    }
  }

  hideStatusPopover() {
    const popover = this.statusPopover();
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  documentDialog() {
    return this.querySelector(":scope > caffold-current-plan-document-dialog");
  }

  statusPopover() {
    return this.querySelector(":scope > .task-current-plan-popover");
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const strip = this.querySelector(":scope > .task-current-plan-strip");
    const threadId = `${this.context?.threadId ?? ""}`;
    if (!this.isConnected || this.hidden || !threadId || !strip || strip.hidden) {
      return emptyActionHintScope();
    }
    const generation = this.contextGeneration;
    const targetScopeId = scopeId || `task:${threadId}:current-plan`;
    const plan = this.projection?.status === "ready" ? this.projection.plan : null;
    const documentTargets = !plan ? [] : [
      ["plan", plan.planDocument],
      ["checklist", plan.checklistDocument],
    ].flatMap(([action, document]) => {
      const control = this.querySelector(
        `:scope > .task-current-plan-strip [data-current-plan-action="${action}"]`,
      );
      const documentPath = `${document?.path ?? ""}`;
      if (
        !documentPath ||
        !control ||
        control.hidden ||
        control.disabled
      ) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${targetScopeId}:${action}`,
        actionId: ACTION_HINT_ACTION.CURRENT_PLAN_DOCUMENT_OPEN,
        label: control.getAttribute("aria-label") ||
          `Open ${action === "plan" ? "plan" : "checklist"}`,
        control,
        clipRoots: [this, strip, ...clipRoots],
        isActionable: () => {
          const currentPlan = this.projection?.status === "ready"
            ? this.projection.plan
            : null;
          const currentDocument = action === "plan"
            ? currentPlan?.planDocument
            : currentPlan?.checklistDocument;
          return (
            this.isConnected &&
            !this.hidden &&
            this.contextGeneration === generation &&
            this.context?.threadId === threadId &&
            !strip.hidden &&
            this.querySelector(
              `:scope > .task-current-plan-strip [data-current-plan-action="${action}"]`,
            ) === control &&
            !control.hidden &&
            !control.disabled &&
            currentDocument?.path === documentPath
          );
        },
      })];
    });
    const status = this.querySelector(
      ':scope > .task-current-plan-strip [data-current-plan-action="status"]',
    );
    const popover = this.statusPopover();
    const statusTargets = !status || status.hidden || !popover ? [] : [
      buttonActionHintTarget({
        invalidationOwner: this,
        id: `${targetScopeId}:status`,
        actionId: ACTION_HINT_ACTION.CURRENT_PLAN_STATUS_OPEN,
        label: status.getAttribute("aria-label") || "Plan status",
        control: status,
        clipRoots: [this, strip, ...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.contextGeneration === generation &&
          !strip.hidden &&
          this.querySelector(
            ':scope > .task-current-plan-strip [data-current-plan-action="status"]',
          ) === status &&
          !status.hidden &&
          this.statusPopover() === popover &&
          status.getAttribute("popovertarget") === popover.id &&
          !popover.matches(":popover-open"),
      }),
    ];
    return {
      blocked: false,
      targets: [...documentTargets, ...statusTargets],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    return mergeKeyboardNavigationContexts(
      this.statusKeyboardNavigationContexts(),
      this.documentDialog()?.keyboardNavigationContexts() ?? [],
    );
  }

  statusKeyboardNavigationContexts() {
    const threadId = `${this.context?.threadId ?? ""}`;
    const popover = this.statusPopover();
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!threadId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const generation = this.contextGeneration;
    const contextId = `task:${threadId}:current-plan:status`;
    const isCurrent = () =>
      this.isConnected &&
      this.contextGeneration === generation &&
      this.statusPopover() === popover;
    const refreshSelector = '[data-current-plan-action="refresh"]';
    const refresh = popover.querySelector(refreshSelector);
    const refreshTargets = !refresh || !hasActionHintLayoutBox(refresh)
      ? []
      : [buttonActionHintTarget({
          invalidationOwner: this,
          id: `${contextId}:refresh`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: refresh.textContent?.trim() || "Refresh",
          control: refresh,
          clipRoots: [popover],
          badgeAtEnd: true,
          isActionable: () =>
            isCurrent() &&
            popover.querySelector(refreshSelector) === refresh &&
            hasActionHintLayoutBox(refresh),
        })];
    return [keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: refreshTargets.length === 0
        ? { dialog, scope: emptyActionHintScope() }
        : {
            dialog,
            scope: {
              blocked: false,
              targets: refreshTargets,
              mutationRoots: [popover],
              scrollRoots: [popover],
            },
            sessionBound: true,
          },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label: "Plan status",
          popover,
          isCurrent,
        }),
      },
    })];
  }

  patch() {
    if (!this.initialized) {
      return;
    }
    const strip = this.querySelector(":scope > .task-current-plan-strip");
    const presentation = currentPlanPresentation({
      projection: this.projection,
      readError: this.readError,
      watchError: this.watchError,
    });
    strip.hidden = !presentation.visible;
    if (!presentation.visible) {
      this.hideStatusPopover();
      return;
    }

    const plan = presentation.presentation === "ready" ? this.projection.plan : null;
    const planAction = this.querySelector('[data-current-plan-action="plan"]');
    const checklistAction = this.querySelector(
      '[data-current-plan-action="checklist"]',
    );
    const title = this.querySelector("[data-current-plan-title]");
    const progress = this.querySelector("[data-current-plan-progress]");
    strip.dataset.presentation = presentation.presentation;
    planAction.hidden = !plan;
    checklistAction.hidden = !plan;
    setText(title, plan?.title ?? "");
    setAttribute(title, "title", plan?.title ?? "");
    if (plan) {
      setText(
        progress,
        plan.total === 0 ? "No checklist items" : `${plan.completed} / ${plan.total}`,
      );
      setAttribute(planAction, "aria-label", `Open plan: ${plan.title}`);
      setAttribute(
        checklistAction,
        "aria-label",
        plan.total === 0
          ? "Open checklist: no items"
          : `Open checklist: ${plan.completed} of ${plan.total} complete`,
      );
      strip.dataset.complete = `${plan.total > 0 && plan.completed === plan.total}`;
    } else {
      strip.removeAttribute("data-complete");
    }

    const status = this.querySelector('[data-current-plan-action="status"]');
    const statusLabel = this.querySelector("[data-current-plan-status-label]");
    const attention = presentation.issues.length > 0;
    if (attention) {
      setAttribute(status, "aria-label", `Plan status: ${presentation.label}`);
      setAttribute(status, "title", presentation.label);
    } else {
      // Only a ready plan has no issues, so its title segment is visible to
      // take focus from the status controls that are about to disappear.
      const focused = document.activeElement;
      if (focused === status || this.statusPopover().contains(focused)) {
        planAction.focus({ preventScroll: true });
      }
      this.hideStatusPopover();
    }
    status.hidden = !attention;
    statusLabel.hidden = Boolean(plan);
    setText(statusLabel, presentation.label);
    this.patchStatusPopover(presentation);
  }

  patchStatusPopover({ issues, refreshAvailable }) {
    const popover = this.statusPopover();
    const issuesKey = JSON.stringify(issues);
    if (issuesKey !== this.renderedIssuesKey) {
      popover.querySelector("[data-current-plan-issues]").replaceChildren(
        ...issues.map(({ label, detail }) => {
          const row = document.createElement("div");
          const term = document.createElement("dt");
          const description = document.createElement("dd");
          term.textContent = label;
          description.textContent = detail;
          row.append(term, description);
          return row;
        }),
      );
      this.renderedIssuesKey = issuesKey;
    }
    popover.querySelector("[data-current-plan-refresh]").hidden = !refreshAvailable;
    setText(
      popover.querySelector('[data-current-plan-action="refresh"]'),
      this.node === CURRENT_PLAN_NODE.READING ? "Refreshing..." : "Refresh",
    );
  }

  render() {
    this.innerHTML = `
      <section class="task-current-plan-strip" aria-label="Current plan" hidden>
        <div class="task-current-plan-main">
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-plan-action"
            data-current-plan-action="plan"
            aria-label="Open plan"
          >
            <span class="task-current-plan-segment-icon" data-current-plan-document-icon aria-hidden="true">
              ${renderInlineIcon("FileText", "", "task-current-plan-segment-icon-svg")}
            </span>
            <strong class="task-current-plan-title" data-current-plan-title></strong>
          </button>
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-checklist-action"
            data-current-plan-action="checklist"
            aria-label="Open checklist"
          >
            <span class="task-current-plan-progress" data-current-plan-progress></span>
          </button>
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-status-action"
            data-current-plan-action="status"
            popovertarget="${this.statusPopoverId}"
            hidden
          >
            <span class="task-current-plan-segment-icon task-current-plan-status-icon" data-current-plan-status-icon aria-hidden="true">
              ${renderInlineIcon("TriangleAlert", "", "task-current-plan-segment-icon-svg")}
            </span>
            <span class="task-current-plan-status-label" data-current-plan-status-label></span>
          </button>
        </div>
      </section>
      <div
        id="${this.statusPopoverId}"
        class="task-current-plan-popover"
        popover="auto"
        aria-label="Plan status"
      >
        <dl data-current-plan-issues></dl>
        <div class="task-current-plan-refresh" data-current-plan-refresh hidden>
          <button type="button" class="task-secondary-button" data-current-plan-action="refresh">Refresh</button>
        </div>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </div>
      <caffold-current-plan-document-dialog></caffold-current-plan-document-dialog>
    `;
    this.dataset.lifecycle = this.node;
  }

  refreshIcons() {
    for (const [selector, name] of [
      ["[data-current-plan-document-icon]", "FileText"],
      ["[data-current-plan-status-icon]", "TriangleAlert"],
    ]) {
      const icon = this.querySelector(selector);
      if (icon) {
        icon.innerHTML = renderInlineIcon(
          name,
          "",
          "task-current-plan-segment-icon-svg",
        );
      }
    }
  }
}

if (!customElements.get("caffold-task-current-plan")) {
  customElements.define("caffold-task-current-plan", CaffoldTaskCurrentPlan);
}

function setText(element, value) {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
