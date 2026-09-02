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
} from "../../../../../../action-hints.js";
import {
  CURRENT_PLAN_NODE,
  currentPlanDocumentDisplayPath,
  currentPlanDocumentPaths,
  currentPlanTransitionAllowed,
  normalizeCurrentPlanProjection,
  sameCurrentPlanProjection,
} from "./current-plan/model.js";
import "./current-plan/components/document-dialog.js";

class CaffoldTaskCurrentPlan extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    this.ensureState();
    this.refreshPlanIcon();
    warmIcons();
    if (this.context) {
      this.startResolving();
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
    this.boundIconsReady ??= () => this.refreshPlanIcon();
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
    this.node = CURRENT_PLAN_NODE.INACTIVE;
    this.context = null;
    this.contextGeneration = 0;
    this.requestId = 0;
    this.requestController = null;
    this.liveUpdates = null;
    this.watchPath = "";
    this.watchUnsubscribe = null;
    this.projection = null;
    this.error = null;
    this.render();
    this.addEventListener("click", (event) => this.handleClick(event));
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
      this.startResolving();
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

    this.invalidateRequest();
    this.releaseWatch();
    this.documentDialog().deactivate();
    this.context = next;
    this.contextGeneration += 1;
    this.projection = null;
    this.error = null;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE);
    }
    if (this.isConnected) {
      this.startResolving();
    } else {
      this.patch();
    }
  }

  deactivate() {
    if (!this.initialized) {
      return;
    }
    this.contextGeneration += 1;
    this.invalidateRequest();
    this.releaseWatch();
    this.documentDialog().deactivate();
    this.context = null;
    this.projection = null;
    this.error = null;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE);
    } else {
      this.patch();
    }
  }

  startResolving() {
    if (!this.context || !this.isConnected) {
      return;
    }
    if (!this.transition(CURRENT_PLAN_NODE.RESOLVING, { patch: false })) {
      return;
    }
    void this.refreshProjection();
  }

  async refreshProjection() {
    const context = this.context;
    if (!context || this.node === CURRENT_PLAN_NODE.INACTIVE) {
      return;
    }
    const generation = this.contextGeneration;
    const requestId = ++this.requestId;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const response = await getCurrentPlan(context.cwd, controller.signal);
      if (!this.acceptRequest(generation, requestId, context)) {
        return;
      }
      this.requestController = null;
      const projection = normalizeCurrentPlanProjection(response);
      this.acceptProjection(projection, generation);
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        !this.acceptRequest(generation, requestId, context)
      ) {
        return;
      }
      this.requestController = null;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.transition(CURRENT_PLAN_NODE.DEGRADED);
    }
  }

  acceptRequest(generation, requestId, context) {
    return (
      this.isConnected &&
      generation === this.contextGeneration &&
      requestId === this.requestId &&
      context === this.context
    );
  }

  acceptProjection(projection, generation) {
    if (generation !== this.contextGeneration || !this.context) {
      return;
    }
    const watchChanged = this.watchPath !== projection.watchPath;
    if (watchChanged && this.node === CURRENT_PLAN_NODE.SUBSCRIBED) {
      this.transition(CURRENT_PLAN_NODE.RESOLVING, { patch: false });
    }
    if (watchChanged) {
      this.releaseWatch();
    }
    const changed = !sameCurrentPlanProjection(this.projection, projection);
    const recoveredPresentation = Boolean(this.error);
    this.projection = projection;
    this.error = null;
    this.bindWatch(projection.watchPath, generation);
    this.transition(CURRENT_PLAN_NODE.SUBSCRIBED, {
      patch: changed || recoveredPresentation,
    });
  }

  bindWatch(path, generation) {
    if (this.watchUnsubscribe && this.watchPath === path) {
      return;
    }
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
        if (
          closesRegistrationGap ||
          recovered ||
          this.node === CURRENT_PLAN_NODE.DEGRADED
        ) {
          this.startResolving();
        }
      },
      onRecover: () => {
        if (this.acceptWatch(generation, path)) {
          this.startResolving();
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
          if (this.node === CURRENT_PLAN_NODE.DEGRADED) {
            this.startResolving();
          } else {
            this.transition(CURRENT_PLAN_NODE.SUBSCRIBED, { patch: false });
            void this.refreshProjection();
          }
        }
      },
      onError: (error) => {
        if (!this.acceptWatch(generation, path)) {
          return;
        }
        this.error = error instanceof Error ? error : new Error(`${error}`);
        this.transition(CURRENT_PLAN_NODE.DEGRADED);
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
    if (action === "retry") {
      if (this.node === CURRENT_PLAN_NODE.DEGRADED) {
        this.startResolving();
      } else {
        void this.refreshProjection();
      }
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

  documentDialog() {
    return this.querySelector(":scope > caffold-current-plan-document-dialog");
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const strip = this.querySelector(":scope > .task-current-plan-strip");
    const plan = this.projection?.status === "ready" ? this.projection.plan : null;
    const threadId = `${this.context?.threadId ?? ""}`;
    if (
      !this.isConnected ||
      this.hidden ||
      !threadId ||
      !plan ||
      !strip ||
      strip.hidden
    ) {
      return emptyActionHintScope();
    }
    const generation = this.contextGeneration;
    const targetScopeId = scopeId || `task:${threadId}:current-plan`;
    const targets = [
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
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    return this.documentDialog()?.keyboardNavigationContexts() ?? [];
  }

  patch() {
    if (!this.initialized) {
      return;
    }
    const strip = this.querySelector(":scope > .task-current-plan-strip");
    const plan = this.projection?.status === "ready" ? this.projection.plan : null;
    const problem = this.projection?.status === "problem";
    const degraded =
      this.node === CURRENT_PLAN_NODE.DEGRADED ||
      (this.node === CURRENT_PLAN_NODE.RESOLVING && Boolean(this.error));
    const visible = Boolean(plan || problem || degraded);
    strip.hidden = !visible;
    if (!visible) {
      return;
    }

    const planAction = this.querySelector('[data-current-plan-action="plan"]');
    const checklistAction = this.querySelector(
      '[data-current-plan-action="checklist"]',
    );
    const title = this.querySelector("[data-current-plan-title]");
    const progress = this.querySelector("[data-current-plan-progress]");
    const attention = this.querySelector("[data-current-plan-attention]");
    const notice = this.querySelector("[data-current-plan-notice]");
    strip.dataset.presentation = plan ? "ready" : "attention";
    planAction.hidden = !plan;
    checklistAction.hidden = !plan;
    attention.hidden = Boolean(plan);
    attention.textContent = "Current plan needs attention";
    title.textContent = plan?.title ?? "";
    title.title = plan?.title ?? "";
    if (plan) {
      progress.textContent = plan.total === 0
        ? "No checklist items"
        : `${plan.completed} / ${plan.total}`;
      planAction.setAttribute("aria-label", `Open plan: ${plan.title}`);
      checklistAction.setAttribute(
        "aria-label",
        plan.total === 0
          ? "Open checklist: no items"
          : `Open checklist: ${plan.completed} of ${plan.total} complete`,
      );
      strip.dataset.complete = `${plan.total > 0 && plan.completed === plan.total}`;
    } else {
      strip.removeAttribute("data-complete");
    }

    const problemMessage = this.projection?.problems?.[0]?.message ?? "";
    notice.hidden = !(problem || degraded);
    notice.textContent = degraded
      ? `Plan updates unavailable. ${this.error?.message ?? "Retry to refresh."}`
      : problem
        ? problemMessage || "Both current plan documents must be readable."
        : "";
    this.querySelector('[data-current-plan-action="retry"]').hidden = !(
      problem || degraded
    );
  }

  render() {
    this.innerHTML = `
      <section class="task-current-plan-strip" aria-label="Current plan" hidden>
        <div class="task-current-plan-main">
          <button
            type="button"
            class="task-current-plan-document-action task-current-plan-plan-action"
            data-current-plan-action="plan"
            aria-label="Open plan"
          >
            <span class="task-current-plan-document-icon" data-current-plan-document-icon aria-hidden="true">
              ${renderInlineIcon("FileText", "", "task-current-plan-document-icon-svg")}
            </span>
            <strong class="task-current-plan-title" data-current-plan-title></strong>
          </button>
          <button
            type="button"
            class="task-current-plan-document-action task-current-plan-checklist-action"
            data-current-plan-action="checklist"
            aria-label="Open checklist"
          >
            <span class="task-current-plan-progress" data-current-plan-progress></span>
          </button>
          <strong class="task-current-plan-attention" data-current-plan-attention hidden></strong>
          <button type="button" data-current-plan-action="retry" hidden>Retry</button>
        </div>
        <p class="task-current-plan-notice" data-current-plan-notice hidden></p>
      </section>
      <caffold-current-plan-document-dialog></caffold-current-plan-document-dialog>
    `;
    this.dataset.lifecycle = this.node;
  }

  refreshPlanIcon() {
    const icon = this.querySelector("[data-current-plan-document-icon]");
    if (icon) {
      icon.innerHTML = renderInlineIcon(
        "FileText",
        "",
        "task-current-plan-document-icon-svg",
      );
    }
  }
}

if (!customElements.get("caffold-task-current-plan")) {
  customElements.define("caffold-task-current-plan", CaffoldTaskCurrentPlan);
}
