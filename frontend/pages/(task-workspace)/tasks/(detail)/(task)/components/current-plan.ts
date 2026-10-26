import { html, LitElement, nothing } from "lit";
import type {
  ActionHintScope,
  ActionHintTarget,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import { getCurrentPlan } from "#app/api.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
  popoverScrollSurfaceScope,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import type { WorkspaceLiveUpdates } from "#app/pages/(task-workspace)/live-updates.ts";
import { subscribeToWatch, watchChangeAffectsPath } from "#app/watch.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "./current-plan/components/document-dialog.ts";
import type { CaffoldCurrentPlanDocumentDialog } from "./current-plan/components/document-dialog.ts";
import {
  CURRENT_PLAN_NODE,
  type CurrentPlanNode,
  type CurrentPlanProjection,
  currentPlanDocumentDisplayPath,
  currentPlanDocumentPaths,
  currentPlanPresentation,
  currentPlanTransitionAllowed,
  normalizeCurrentPlanProjection,
} from "./current-plan/model.ts";

// The Task the plan belongs to: its thread, the folder its plan files are
// read from, and the root its document paths are shown from.
export interface CurrentPlanContext {
  threadId: string;
  cwd: string;
  rootPath: string;
}

let currentPlanInstanceId = 0;

/**
 * A Task's current plan above its Composer: the plan's title and checklist
 * progress, each opening its file, and a status that explains a plan that
 * cannot be read. It reads the plan again whenever its files change.
 */
export class CaffoldTaskCurrentPlan extends LitElement {
  private readonly statusPopoverId =
    `task-current-plan-status-${++currentPlanInstanceId}`;
  private node: CurrentPlanNode = CURRENT_PLAN_NODE.INACTIVE;
  private context: CurrentPlanContext | null = null;
  private contextGeneration = 0;
  private requestId = 0;
  private requestController: AbortController | null = null;
  private liveUpdates: WorkspaceLiveUpdates | null = null;
  private watchPath = "";
  private watchUnsubscribe: (() => void) | null = null;
  private projection: CurrentPlanProjection | null = null;
  private readError: Error | null = null;
  private watchError: Error | null = null;
  // Whether focus sat on the status controls before a drawing hid them.
  private statusHadFocus = false;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.performUpdate();
    if (this.context) {
      this.requestRead();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.deactivate();
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null) {
    if (this.liveUpdates === liveUpdates) {
      return;
    }
    this.liveUpdates = liveUpdates;
    this.releaseWatch();
    if (this.context && this.isConnected) {
      this.requestRead();
    }
  }

  setContext({ threadId, cwd, rootPath }: CurrentPlanContext) {
    const next = {
      threadId: threadId.trim(),
      cwd: cwd.trim(),
      rootPath: (rootPath || cwd).trim(),
    };
    if (!next.threadId || !next.cwd) {
      this.deactivate();
      return;
    }
    if (
      this.context?.threadId === next.threadId &&
      this.context.cwd === next.cwd &&
      this.context.rootPath === next.rootPath
    ) {
      return;
    }

    this.clearActivation();
    this.context = next;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE, { draw: false });
    }
    if (this.isConnected) {
      this.requestRead();
    } else {
      this.draw();
    }
  }

  deactivate() {
    this.clearActivation();
    this.context = null;
    if (this.node !== CURRENT_PLAN_NODE.INACTIVE) {
      this.transition(CURRENT_PLAN_NODE.INACTIVE);
    } else {
      this.draw();
    }
  }

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: {
    scopeId?: string;
    clipRoots?: Element[];
  } = {}): ActionHintScope {
    const strip = this.strip;
    const threadId = this.context?.threadId ?? "";
    if (
      !this.isConnected ||
      this.hidden ||
      !threadId ||
      !strip ||
      strip.hidden
    ) {
      return emptyActionHintScope();
    }
    const generation = this.contextGeneration;
    const targetScopeId = scopeId || `task:${threadId}:current-plan`;
    const plan =
      this.projection?.status === "ready" ? this.projection.plan : null;
    const documentTargets = !plan
      ? []
      : (["plan", "checklist"] as const).flatMap((action) => {
          const documentPath =
            (action === "plan" ? plan.planDocument : plan.checklistDocument)
              ?.path ?? "";
          const control = this.stripAction(action);
          if (!documentPath || !control || control.hidden || control.disabled) {
            return [];
          }
          return [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: `${targetScopeId}:${action}`,
              actionId: ACTION_HINT_ACTION.CURRENT_PLAN_DOCUMENT_OPEN,
              label: control.getAttribute("aria-label") || `Open ${action}`,
              control,
              clipRoots: [this, strip, ...clipRoots],
              isActionable: () => {
                const currentPlan =
                  this.projection?.status === "ready"
                    ? this.projection.plan
                    : null;
                const currentDocument =
                  action === "plan"
                    ? currentPlan?.planDocument
                    : currentPlan?.checklistDocument;
                return (
                  this.isConnected &&
                  !this.hidden &&
                  this.contextGeneration === generation &&
                  this.context?.threadId === threadId &&
                  !strip.hidden &&
                  this.stripAction(action) === control &&
                  !control.hidden &&
                  !control.disabled &&
                  currentDocument?.path === documentPath
                );
              },
            }),
          ];
        });
    const status = this.stripAction("status");
    const popover = this.statusPopover;
    const statusTargets: ActionHintTarget[] =
      !status || status.hidden || !popover
        ? []
        : [
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
                this.stripAction("status") === status &&
                !status.hidden &&
                this.statusPopover === popover &&
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
      this.documentDialog?.keyboardNavigationContexts() ?? [],
    );
  }

  render() {
    const presentation = currentPlanPresentation({
      projection: this.projection,
      readError: this.readError,
      watchError: this.watchError,
    });
    const plan =
      presentation.presentation === "ready" ? this.projection?.plan : null;
    const attention = presentation.issues.length > 0;
    const popoverId = this.statusPopoverId;
    const documentIcon = inlineIcon(
      "FileText",
      "",
      "task-current-plan-segment-icon-svg",
    );
    const statusIcon = inlineIcon(
      "TriangleAlert",
      "",
      "task-current-plan-segment-icon-svg",
    );
    const checklistLabel = !plan
      ? "Open checklist"
      : plan.total === 0
        ? "Open checklist: no items"
        : `Open checklist: ${plan.completed} of ${plan.total} complete`;
    return html`
      <section
        class="task-current-plan-strip"
        aria-label="Current plan"
        data-presentation=${presentation.presentation || nothing}
        data-complete=${
          plan ? `${plan.total > 0 && plan.completed === plan.total}` : nothing
        }
        ?hidden=${!presentation.visible}
      >
        <div class="task-current-plan-main">
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-plan-action"
            data-current-plan-action="plan"
            aria-label=${plan ? `Open plan: ${plan.title}` : "Open plan"}
            ?hidden=${!plan}
            @click=${this.openPlan}
          >
            <span
              class="task-current-plan-segment-icon"
              data-current-plan-document-icon
              aria-hidden="true"
            >${documentIcon}</span>
            <strong
              class="task-current-plan-title"
              data-current-plan-title
              title=${plan?.title ?? ""}
            >${plan?.title ?? ""}</strong>
          </button>
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-checklist-action"
            data-current-plan-action="checklist"
            aria-label=${checklistLabel}
            ?hidden=${!plan}
            @click=${this.openChecklist}
          >
            <span class="task-current-plan-progress" data-current-plan-progress
              >${progressText(plan)}</span
            >
          </button>
          <button
            type="button"
            class="task-current-plan-segment task-current-plan-status-action"
            data-current-plan-action="status"
            popovertarget=${popoverId}
            aria-label=${
              attention ? `Plan status: ${presentation.label}` : nothing
            }
            title=${attention ? presentation.label : nothing}
            ?hidden=${!attention}
          >
            <span
              class="task-current-plan-segment-icon
                task-current-plan-status-icon"
              data-current-plan-status-icon
              aria-hidden="true"
            >${statusIcon}</span>
            <span
              class="task-current-plan-status-label"
              data-current-plan-status-label
              ?hidden=${Boolean(plan)}
            >${presentation.label}</span>
          </button>
        </div>
      </section>
      <div
        id=${popoverId}
        class="task-current-plan-popover"
        popover="auto"
        aria-label="Plan status"
      >
        <dl data-current-plan-issues>${presentation.issues.map(
          ({ label, detail }) =>
            html`<div><dt>${label}</dt><dd>${detail}</dd></div>`,
        )}</dl>
        <div
          class="task-current-plan-refresh"
          data-current-plan-refresh
          ?hidden=${!presentation.refreshAvailable}
        >
          <button
            type="button"
            class="task-secondary-button"
            data-current-plan-action="refresh"
            @click=${this.requestRead}
          >${
            this.node === CURRENT_PLAN_NODE.READING
              ? "Refreshing..."
              : "Refresh"
          }</button>
        </div>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </div>
      <caffold-current-plan-document-dialog
      ></caffold-current-plan-document-dialog>
    `;
  }

  willUpdate() {
    const focused = document.activeElement;
    this.statusHadFocus = Boolean(
      focused &&
        (focused === this.stripAction("status") ||
          this.statusPopover?.contains(focused)),
    );
  }

  // A plan with nothing to explain closes its status. Only a ready plan has
  // no issues, so its title segment takes focus from the status controls the
  // drawing just hid.
  updated() {
    if (this.dataset.lifecycle !== this.node) {
      this.dataset.lifecycle = this.node;
    }
    const strip = this.strip;
    const status = this.stripAction("status");
    if (!strip.hidden && status?.hidden && this.statusHadFocus) {
      this.stripAction("plan")?.focus({ preventScroll: true });
    }
    if (strip.hidden || status?.hidden) {
      this.hideStatusPopover();
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private clearActivation() {
    this.contextGeneration += 1;
    this.invalidateRequest();
    this.releaseWatch();
    this.documentDialog?.deactivate();
    this.hideStatusPopover();
    this.projection = null;
    this.readError = null;
    this.watchError = null;
  }

  private requestRead() {
    if (!this.context || !this.isConnected) {
      return;
    }
    if (this.transition(CURRENT_PLAN_NODE.READING)) {
      void this.readProjection();
    }
  }

  private async readProjection() {
    const context = this.context;
    if (!context) {
      return;
    }
    const generation = this.contextGeneration;
    const requestId = ++this.requestId;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    let projection: CurrentPlanProjection | null = null;
    let readError: Error | null = null;
    try {
      projection = normalizeCurrentPlanProjection(
        await getCurrentPlan(context.cwd, controller.signal),
      );
    } catch (error) {
      if ((error as Error | null)?.name === "AbortError") {
        return;
      }
      readError = error instanceof Error ? error : new Error(`${error}`);
    }
    if (!this.acceptRead(generation, requestId, context)) {
      return;
    }
    this.requestController = null;
    if (readError || !projection) {
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

  private acceptRead(
    generation: number,
    requestId: number,
    context: CurrentPlanContext,
  ) {
    return (
      this.isConnected &&
      this.node === CURRENT_PLAN_NODE.READING &&
      generation === this.contextGeneration &&
      requestId === this.requestId &&
      context === this.context
    );
  }

  private bindWatch(path: string, generation: number) {
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
        if (
          closesRegistrationGap ||
          recovered ||
          interrupted ||
          this.readError
        ) {
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
          this.documentDialog?.refreshOpenDocument();
          this.requestRead();
        }
      },
      onError: (error) => {
        if (!this.acceptWatch(generation, path)) {
          return;
        }
        this.watchError =
          error instanceof Error ? error : new Error(`${error}`);
        this.draw();
      },
    });
  }

  private acceptWatch(generation: number, path: string) {
    return (
      this.isConnected &&
      generation === this.contextGeneration &&
      this.watchPath === path
    );
  }

  private releaseWatch() {
    this.watchUnsubscribe?.();
    this.watchUnsubscribe = null;
    this.watchPath = "";
  }

  private invalidateRequest() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
  }

  private transition(next: CurrentPlanNode, { draw = true } = {}) {
    if (!currentPlanTransitionAllowed(this.node, next)) {
      return false;
    }
    this.node = next;
    if (draw) {
      this.draw();
    }
    return true;
  }

  private openPlan(event: Event) {
    this.openDocument("plan", event.currentTarget as HTMLElement);
  }

  private openChecklist(event: Event) {
    this.openDocument("checklist", event.currentTarget as HTMLElement);
  }

  private openDocument(kind: "plan" | "checklist", opener: HTMLElement) {
    const plan = this.projection?.plan;
    const document =
      kind === "plan" ? plan?.planDocument : plan?.checklistDocument;
    if (!document) {
      return;
    }
    const rootPath = this.context?.rootPath ?? "";
    this.documentDialog?.openDocument({
      label: kind === "plan" ? "Plan" : "Checklist",
      document,
      displayPath: currentPlanDocumentDisplayPath(document.path, rootPath),
      rootPath,
      opener,
    });
  }

  private statusKeyboardNavigationContexts() {
    const threadId = this.context?.threadId ?? "";
    const popover = this.statusPopover;
    const presentation =
      popover?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!threadId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const generation = this.contextGeneration;
    const contextId = `task:${threadId}:current-plan:status`;
    const isCurrent = () =>
      this.isConnected &&
      this.contextGeneration === generation &&
      this.statusPopover === popover;
    const refreshSelector = '[data-current-plan-action="refresh"]';
    const refresh = popover.querySelector<HTMLButtonElement>(refreshSelector);
    const refreshTargets =
      !refresh || !hasActionHintLayoutBox(refresh)
        ? []
        : [
            buttonActionHintTarget({
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
            }),
          ];
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints:
          refreshTargets.length === 0
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
      }),
    ];
  }

  private handleDismiss(event: Event) {
    if (event.target === this.statusPopover) {
      this.hideStatusPopover();
    }
  }

  private hideStatusPopover() {
    const popover = this.statusPopover;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  private stripAction(action: "plan" | "checklist" | "status") {
    return this.querySelector<HTMLButtonElement>(
      `:scope > .task-current-plan-strip [data-current-plan-action="${action}"]`,
    );
  }

  private get strip() {
    return this.querySelector(
      ":scope > .task-current-plan-strip",
    ) as HTMLElement;
  }

  private get statusPopover() {
    return this.querySelector<HTMLElement>(
      ":scope > .task-current-plan-popover",
    );
  }

  private get documentDialog() {
    return this.querySelector<CaffoldCurrentPlanDocumentDialog>(
      ":scope > caffold-current-plan-document-dialog",
    );
  }
}

function progressText(
  plan: { completed: number; total: number } | null | undefined,
) {
  if (!plan) {
    return "";
  }
  return plan.total === 0
    ? "No checklist items"
    : `${plan.completed} / ${plan.total}`;
}

customElements.define("caffold-task-current-plan", CaffoldTaskCurrentPlan);
