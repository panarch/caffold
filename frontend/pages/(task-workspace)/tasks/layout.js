import { routeDomain, routeTarget } from "../../../navigation-routes.js";
import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexBlocksTaskOperations,
  codexSetupVisible,
  taskStoreBlocksTaskOperations,
  taskStoreRecoveryVisible as taskStoreTakesOver,
} from "../codex-status.js";
import "./components/codex-readiness-recovery.js";
import "./(detail)/layout.js";
import "./recovery/page.js";
import {
  TASK_IMAGE_PREVIEW_EVENT,
} from "./components/image-preview-dialog.js";
import "./new/page.js";
import { TASK_TRANSPORT_STATE } from "./runtime-state.js";
import { taskDetailThreadId } from "./task-list-model.js";

class CaffoldTasksPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.view = "home";
    this.detailView = "conversation";
    this.detailPresentation = "reading";
    this.taskListState = "loading";
    this.selectedThreadId = "";
    this.selectedSectionId = "";
    this.adoptedThreadId = "";
    this.currentRoute = { kind: "tasks" };
    this.currentOpenOptions = {};
    this.codexStatusSnapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
    this.codexRestartStateValue = { state: "idle", message: "" };
    this.lastPublishedTransportTargets = "";
    this.boundTaskNavigatorIntent = (event) => {
      event.stopPropagation();
      if (event.detail?.type === "select-task") {
        this.requestRoute({
          kind: "tasks",
          threadId: event.detail.threadId,
        });
      } else if (event.detail?.type === "select-task-recovery") {
        this.requestRoute({
          kind: "tasks",
          threadId: event.detail.threadId,
          recovery: true,
        });
      } else if (event.detail?.type === "select-section") {
        this.requestRoute({
          kind: "tasks",
          sectionId: event.detail.sectionId,
          sectionSurface: "new",
        });
      } else if (event.detail?.type === "new-task") {
        this.requestNewTaskRoute();
      }
    };
    this.boundTaskNavigatorListState = (event) => {
      event.stopPropagation();
      this.syncTaskListState(event.detail);
      this.publishTransportState();
    };
    this.boundTaskNavigatorTransportChange = (event) => {
      event.stopPropagation();
      this.taskNew()?.setTransportAvailable(event.detail?.available);
      this.taskDetail()?.setTransportAvailable(event.detail?.available);
      this.publishTransportState();
    };
    this.boundTaskDetailTransportChange = (event) => {
      if (event.target !== this.taskDetail()) {
        return;
      }
      event.stopPropagation();
      this.publishTransportState();
    };

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-detail-pane" role="region" aria-label="Task content">
          <caffold-codex-readiness-recovery hidden></caffold-codex-readiness-recovery>
          <caffold-task-new hidden></caffold-task-new>
          <caffold-detail-layout hidden></caffold-detail-layout>
          <caffold-task-recovery hidden></caffold-task-recovery>
        </div>
      </section>
      <caffold-task-image-preview-dialog></caffold-task-image-preview-dialog>
    `;
    this.addEventListener("caffold:task-new-route-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.route) {
        this.requestRoute(event.detail.route);
      }
    });
    this.addEventListener("caffold:task-created", (event) => {
      event.stopPropagation();
      event.detail.adopted = this.adoptCreatedDetail(
        event.detail?.detail,
        event.detail?.submission,
      );
    });
    this.addEventListener("caffold:task-snapshot", (event) => {
      event.stopPropagation();
      if (event.detail?.task) {
        this.taskNavigator()?.upsertCanonicalTask(event.detail.task);
      }
    });
    this.addEventListener("caffold:task-detail-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "task-archived" && event.detail.task) {
        this.taskNavigator()?.acceptArchivedTask(event.detail.task);
        this.requestRoute({ kind: "tasks" }, { replace: true });
      } else if (
        ["review-route", "domain-route"].includes(event.detail?.type) &&
        event.detail.route
      ) {
        this.requestRoute(event.detail.route, {
          replace: event.detail.replace,
        });
      }
    });
    this.addEventListener("caffold:task-recovery-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "rechecked") {
        this.applyRecheckedRecovery(event.detail.recovery);
      } else if (event.detail?.type === "resolved") {
        this.resolveRecovery(event.detail);
      }
    });
    this.addEventListener(
      "caffold:task-detail-transport-change",
      this.boundTaskDetailTransportChange,
    );
    this.addEventListener(TASK_IMAGE_PREVIEW_EVENT, (event) => {
      event.stopPropagation();
      this.imagePreviewDialog()?.openImage(event.detail);
    });
    this.render();
  }

  connectTaskNavigator(navigator) {
    this.ensureRendered();
    if (this.connectedTaskNavigator === navigator) {
      return;
    }
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-intent",
      this.boundTaskNavigatorIntent,
    );
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-list-state",
      this.boundTaskNavigatorListState,
    );
    this.connectedTaskNavigator?.removeEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTaskNavigatorTransportChange,
    );
    this.connectedTaskNavigator = navigator ?? null;
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-intent",
      this.boundTaskNavigatorIntent,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-list-state",
      this.boundTaskNavigatorListState,
    );
    this.connectedTaskNavigator?.addEventListener(
      "caffold:task-navigator-transport-change",
      this.boundTaskNavigatorTransportChange,
    );
    this.syncTaskListState(this.connectedTaskNavigator?.listState());
    this.taskNew()?.setTransportAvailable(
      this.connectedTaskNavigator?.isTransportAvailable?.(),
    );
    this.connectedTaskNavigator?.setSelectedSubject(this.selectedSubject());
    this.publishTransportState();
  }

  deactivate() {
    this.taskNavigator()?.exitReorderMode({ restoreFocus: false });
    this.imagePreviewDialog()?.dismiss();
    if (this.view === "detail") {
      this.taskDetail()?.deactivate({ retainComposerDom: true });
    } else if (this.view === "recovery") {
      this.taskRecovery()?.deactivate();
    } else {
      this.taskNew()?.deactivate();
    }
  }

  suspendForeground() {
    this.taskNavigator()?.suspendForeground();
    this.taskDetail()?.suspendForeground();
  }

  async recoverForeground({
    initialActivation = false,
    isCurrent = () => true,
    progress,
  } = {}) {
    if (initialActivation || !isCurrent()) {
      return { retry: false };
    }
    const recoveries = new Map();
    const listRecovery = this.taskNavigator()?.recoverForeground();
    if (listRecovery) {
      recoveries.set("list", listRecovery);
    }
    if (!this.taskStoreOperationsBlocked() && this.view === "detail") {
      const detailRecovery = this.taskDetail()?.recoverForeground();
      if (detailRecovery) {
        recoveries.set("detail", detailRecovery);
      }
    }
    reportForegroundValidationStage(progress, recoveries.keys());
    const results = await Promise.allSettled(
      [...recoveries].map(([target, recovery]) =>
        Promise.resolve(recovery).then((result) => {
          recoveries.delete(target);
          if (isCurrent()) {
            reportForegroundValidationStage(progress, recoveries.keys());
          }
          return result;
        })
      ),
    );
    if (!isCurrent()) {
      return { stale: true, retry: false };
    }
    const failure = results.find((result) => result.status === "rejected");
    return {
      retry: Boolean(failure),
      error: failure?.reason ?? null,
    };
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.taskNavigator()?.exitReorderMode({ restoreFocus: false });
    this.currentRoute = { ...route };
    this.currentOpenOptions = { ...options };
    const target = routeTarget(route);
    const domain = routeDomain(route);
    const nextView = target === "recovery"
      ? "recovery"
      : route?.threadId || route?.sectionId
      ? "detail"
      : target === "new"
        ? "new"
        : "home";
    const nextDetailView = route?.sectionId
      ? route.sectionSurface ?? "new"
      : domain ||
        (["review", "review-file"].includes(target) ? "review" : "conversation");
    const nextThreadId = `${route?.threadId ?? ""}`;
    const nextSectionId = `${route?.sectionId ?? ""}`;
    if (
      nextView !== this.view ||
      nextThreadId !== this.selectedThreadId ||
      nextSectionId !== this.selectedSectionId
    ) {
      this.imagePreviewDialog()?.dismiss();
    }
    const preserveAdopted =
      nextThreadId &&
      this.adoptedThreadId === nextThreadId &&
      taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId;
    const preserveLoadedTask =
      Boolean(options.preserveLoadedTask) ||
      preserveAdopted ||
      (this.selectedThreadId === nextThreadId &&
        taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId);

    this.view = nextView;
    this.detailView = nextDetailView;
    this.detailPresentation = taskRoutePresentation(route);
    this.selectedThreadId = nextThreadId;
    this.selectedSectionId = nextSectionId;
    this.setAttribute("data-tasks-view", nextView);
    this.taskNavigator()?.setSelectedSubject(this.selectedSubject());
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    }
    if (nextView !== "recovery") {
      this.taskRecovery()?.deactivate();
    }
    if (nextView === "detail") {
      this.taskNew()?.deactivate();
      if (nextThreadId) {
        this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask, route });
      } else {
        const section = this.taskNavigator()?.sectionFor(nextSectionId);
        if (section) {
          this.taskDetail()?.prepareSection(section, route);
        }
      }
    } else if (nextView === "recovery") {
      this.taskNew()?.deactivate();
      this.taskRecovery()?.prepare(options.recovery ?? null);
    }
    this.render();
    return { preserveLoadedTask };
  }

  async openRoute(route, options = {}) {
    const prepared = this.prepareRoute(route, options);
    const navigatorRequest = this.taskNavigator()?.activate();
    const target = routeTarget(route);
    if (target === "new") {
      this.taskNew()?.prepare({
        cwd: route.cwd ?? "",
        defaultCwdPath: options.defaultCwdPath ?? "",
      });
      this.taskNew()?.open();
      this.render();
      return null;
    }
    if (target === "recovery" && route?.threadId) {
      this.taskNew()?.deactivate();
      this.taskDetail()?.deactivate();
      await this.taskNavigator()?.activate({ force: true });
      const recovery = this.taskNavigator()?.recoveryFor(route.threadId);
      if (!recovery) {
        const task = this.taskNavigator()?.taskFor(route.threadId);
        this.requestRoute(
          task
            ? { kind: "tasks", threadId: route.threadId }
            : { kind: "tasks" },
          { replace: true },
        );
        return null;
      }
      this.taskRecovery()?.updateRecovery(recovery);
      this.render();
      return recovery;
    }
    if (route?.sectionId) {
      this.taskNew()?.deactivate();
      await navigatorRequest;
      const section = this.taskNavigator()?.sectionFor(route.sectionId);
      if (!section) {
        this.requestRoute({ kind: "tasks" }, { replace: true });
        return null;
      }
      return await this.taskDetail()?.openSection(section, route);
    }
    if (route?.threadId) {
      this.taskNew()?.deactivate();
      const recovery = this.taskNavigator()?.recoveryFor(route.threadId);
      if (recovery) {
        this.requestRoute(
          { kind: "tasks", threadId: route.threadId, recovery: true },
          { replace: true },
        );
        return null;
      }
      const result = await this.taskDetail()?.open(route.threadId, {
        preserveLoadedTask: prepared.preserveLoadedTask,
        route,
      });
      if (this.adoptedThreadId === route.threadId) {
        this.adoptedThreadId = "";
      }
      return result;
    }
    this.taskNew()?.prepare({
      defaultCwdPath: options.defaultCwdPath ?? "",
    });
    this.taskNew()?.open();
    this.render();
    return await this.taskNavigator()?.activate({ force: true });
  }

  adoptCreatedDetail(detail, submission) {
    const threadId = taskDetailThreadId(detail);
    if (!threadId || !detail?.task) {
      return false;
    }
    this.adoptedThreadId = threadId;
    this.selectedThreadId = threadId;
    const adopted = this.taskDetail()?.adoptCreatedDetail(detail, submission);
    if (!adopted) {
      return false;
    }
    this.taskNavigator()?.placeCanonicalTaskAtTop(
      detail.task,
      detail.activeTopPlacement,
    );
    this.requestRoute({ kind: "tasks", threadId });
    return true;
  }

  applyRecheckedRecovery(recovery) {
    const threadId = taskDetailThreadId({ task: recovery });
    if (!threadId || threadId !== this.selectedThreadId || this.view !== "recovery") {
      return;
    }
    this.taskNavigator()?.upsertCanonicalTask(recovery);
    this.taskRecovery()?.updateRecovery(recovery);
  }

  resolveRecovery(detail) {
    const threadId = detail?.threadId ?? taskDetailThreadId({ task: detail?.task });
    if (detail?.resolution === "restored" && detail.task) {
      this.taskNavigator()?.placeCanonicalTaskAtTop(
        detail.task,
        detail.activeTopPlacement,
      );
      this.requestRoute(
        { kind: "tasks", threadId: detail.task.threadId },
        { replace: true },
      );
    } else if (detail?.resolution === "archived" && detail.task) {
      this.taskNavigator()?.acceptArchivedTask(detail.task);
      this.requestRoute({ kind: "tasks" }, { replace: true });
    } else if (detail?.resolution === "removed") {
      this.taskNavigator()?.removeTask(threadId);
      this.requestRoute({ kind: "tasks" }, { replace: true });
    }
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureRendered();
    const wasTakenOver = this.taskStoreRecoveryVisible();
    this.codexStatusSnapshotValue = snapshot ?? INITIAL_CODEX_STATUS_SNAPSHOT;
    this.taskNew()?.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.taskDetail()?.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.taskNavigator()?.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.codexReadinessRecovery()?.setSnapshot(this.codexStatusSnapshotValue);
    if (this.taskStoreRecoveryVisible()) {
      this.taskDetail()?.deactivate();
    } else if (wasTakenOver && this.view === "detail" && this.selectedThreadId) {
      // The takeover deactivated the open Task; its clearing has to bring
      // the Task back, or the pane it uncovers is blank.
      void this.taskDetail()?.open(this.selectedThreadId, {
        preserveLoadedTask: true,
        route: this.currentRoute,
      });
    }
    this.render();
  }

  setCodexRestartState(state) {
    this.ensureRendered();
    this.codexRestartStateValue = state ?? { state: "idle", message: "" };
    this.codexReadinessRecovery()?.setRestartState(this.codexRestartStateValue);
  }

  codexOperationsBlocked() {
    return codexBlocksTaskOperations(this.codexStatusSnapshotValue.status);
  }

  taskStoreOperationsBlocked() {
    return taskStoreBlocksTaskOperations(this.codexStatusSnapshotValue.status);
  }

  taskStoreRecoveryVisible() {
    return taskStoreTakesOver(this.codexStatusSnapshotValue);
  }

  get taskDetailView() {
    return this.view === "detail" ? this.detailView : "conversation";
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.view === "detail"
      ? this.taskDetail()?.selectedTaskContextPath() ?? ""
      : this.taskNew()?.selectedContextPath() ?? "";
  }

  newTaskContextPath() {
    this.ensureRendered();
    return this.view === "detail"
      ? this.taskDetail()?.newTaskContextPath() ?? ""
      : this.taskNew()?.selectedContextPath() ?? "";
  }

  taskNavigator() {
    return this.connectedTaskNavigator ?? null;
  }

  taskNew() {
    return this.querySelector(":scope > .tasks-surface caffold-task-new");
  }

  taskDetail() {
    return this.querySelector(":scope > .tasks-surface caffold-detail-layout");
  }

  taskRecovery() {
    return this.querySelector(":scope > .tasks-surface caffold-task-recovery");
  }

  codexReadinessRecovery() {
    return this.querySelector(
      ":scope > .tasks-surface caffold-codex-readiness-recovery",
    );
  }

  imagePreviewDialog() {
    return this.querySelector(
      ":scope > caffold-task-image-preview-dialog",
    );
  }

  syncTaskListState(state = {}) {
    this.reconcileSelectedTask(state);
    this.reconcileSelectedSection(state);
    const count = Number(state.count ?? 0);
    const nextState = state.loaded
      ? count > 0
        ? "available"
        : "empty"
      : state.error
        ? "error"
        : count > 0
          ? "available"
          : "loading";
    if (this.taskListState === nextState) {
      return;
    }
    this.taskListState = nextState;
    this.render();
  }

  reconcileSelectedTask(state = {}) {
    if (!this.selectedThreadId || !state.loaded) {
      return;
    }
    const recovery = this.taskNavigator()?.recoveryFor(this.selectedThreadId);
    if (!recovery) {
      return;
    }
    if (this.view === "recovery") {
      if (!sameRecoveryPresentation(this.taskRecovery()?.recovery, recovery)) {
        this.taskRecovery()?.updateRecovery(recovery);
      }
      return;
    }
    if (this.view === "detail") {
      this.requestRoute(
        { kind: "tasks", threadId: this.selectedThreadId, recovery: true },
        { replace: true },
      );
    }
  }

  reconcileSelectedSection(state = {}) {
    if (
      !this.selectedSectionId ||
      this.view !== "detail" ||
      this.taskDetail()?.subjectKind !== "section"
    ) {
      return;
    }
    const section = state.selectedSection ?? null;
    if (!section) {
      if (state.loaded) {
        this.requestRoute({ kind: "tasks" }, { replace: true });
      }
      return;
    }
    if (!this.taskDetail()?.sectionContextMatches(section)) {
      void this.taskDetail()?.openSection(section, this.currentRoute);
    } else {
      this.taskDetail()?.updateSection(section);
    }
  }

  selectedSubject() {
    if (this.selectedThreadId) {
      return { kind: "task", id: this.selectedThreadId };
    }
    if (this.selectedSectionId) {
      return { kind: "section", id: this.selectedSectionId };
    }
    return null;
  }

  requestRoute(route, options = {}) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: { ...route },
          replace: Boolean(options.replace),
        },
      }),
    );
  }

  requestNewTaskRoute() {
    const cwd = this.newTaskContextPath();
    this.requestRoute({
      kind: "tasks",
      new: true,
      ...(cwd && cwd !== "." ? { cwd } : {}),
    });
  }

  publishTransportState() {
    const navigator = this.taskNavigator();
    const listState = navigator?.listState?.();
    const detailActive = this.view === "detail";
    const listTransport = listState?.activeCount > 0 && listState.activeError
      ? TASK_TRANSPORT_STATE.UNAVAILABLE
      : navigator?.streamState ?? TASK_TRANSPORT_STATE.IDLE;
    const targets = {
      list: {
        active: Boolean(navigator),
        content: listState?.loaded || listState?.count > 0
          ? "present"
          : "absent",
        transport: listTransport,
      },
      detail: {
        active: detailActive,
        content: detailActive && this.taskDetail()?.hasSelectedDetail()
          ? "present"
          : "absent",
        transport: detailActive
          ? this.taskDetail()?.streamState ?? TASK_TRANSPORT_STATE.IDLE
          : "inactive",
      },
    };
    const publicationKey = JSON.stringify(targets);
    if (publicationKey === this.lastPublishedTransportTargets) {
      return;
    }
    this.lastPublishedTransportTargets = publicationKey;
    this.dispatchEvent(
      new CustomEvent("caffold:task-transport-status", {
        bubbles: true,
        composed: true,
        detail: {
          targets,
        },
      }),
    );
  }

  render() {
    this.ensureRendered();
    this.setAttribute("data-tasks-view", this.view);
    this.setAttribute("data-task-list-state", this.taskListState);
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.setAttribute(
      "data-task-detail-presentation",
      this.detailPresentation,
    );
    const showNew = this.view === "new" || this.view === "home";
    // Only the store may take the Task surface over — it gates every agent.
    // Codex setup shows beside the surface on the home views, never over an
    // open Task: a Claude Task is not held hostage by Codex being unready.
    const takeover = this.taskStoreRecoveryVisible();
    const setupBeside =
      !takeover && showNew && codexSetupVisible(this.codexStatusSnapshotValue);
    const setup = this.codexReadinessRecovery();
    setup?.toggleAttribute("hidden", !(takeover || setupBeside));
    if (setup) {
      setup.dataset.presentation = setupBeside ? "beside" : "takeover";
    }
    this.taskNew()?.toggleAttribute("hidden", takeover || !showNew);
    this.taskDetail()?.toggleAttribute(
      "hidden",
      takeover || this.view !== "detail",
    );
    this.taskRecovery()?.toggleAttribute(
      "hidden",
      takeover || this.view !== "recovery",
    );
    this.taskNavigator()?.setSelectedSubject(this.selectedSubject());
    this.dispatchEvent(
      new CustomEvent("caffold:tasks-presentation-change", { bubbles: true }),
    );
    this.publishTransportState();
  }

}

function reportForegroundValidationStage(progress, targets) {
  const pending = new Set(targets);
  progress?.validatingTransports({
    detail: pending.has("detail"),
    list: pending.has("list"),
  });
}

function taskRoutePresentation(route) {
  const domain = routeDomain(route);
  const target = routeTarget(route);
  if (domain === "git") {
    return route.kind === "compare" || target !== "list" ? "code" : "reading";
  }
  if (domain === "github") {
    return target === "files" || target === "file" ? "code" : "reading";
  }
  return target === "review" || target === "review-file" ? "code" : "reading";
}

function sameRecoveryPresentation(left, right) {
  const leftActions = left?.recovery?.actions ?? [];
  const rightActions = right?.recovery?.actions ?? [];
  return (
    taskDetailThreadId({ task: left }) === taskDetailThreadId({ task: right }) &&
    left?.title === right?.title &&
    left?.recovery?.reason === right?.recovery?.reason &&
    leftActions.length === rightActions.length &&
    leftActions.every((action, index) => action === rightActions[index])
  );
}

if (!customElements.get("caffold-tasks-page")) {
  customElements.define("caffold-tasks-page", CaffoldTasksPage);
}
