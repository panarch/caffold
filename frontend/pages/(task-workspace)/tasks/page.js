import { routeDomain, routeTarget } from "../../../navigation-routes.js";
import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexBlocksTaskOperations,
  codexTaskRecoveryVisible,
} from "../codex-status.js";
import "./components/codex-readiness-recovery.js";
import "./components/detail.js";
import "./components/recovery.js";
import {
  TASK_IMAGE_PREVIEW_EVENT,
} from "./components/image-preview-dialog.js";
import "./components/task-new.js";
import {
  TASK_TRANSPORT_RETRY_EVENT,
} from "./components/task-transport-overlay.js";
import { retryStaleTaskTransports } from "./runtime-state.js";
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
    this.adoptedThreadId = "";
    this.currentRoute = { kind: "tasks" };
    this.currentOpenOptions = {};
    this.codexStatusSnapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
    this.codexRestartStateValue = { state: "idle", message: "" };
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
      } else if (event.detail?.type === "new-task") {
        this.requestNewTaskRoute();
      }
    };
    this.boundTaskNavigatorListState = (event) => {
      event.stopPropagation();
      this.syncTaskListState(event.detail);
    };
    this.boundTaskNavigatorTransportChange = (event) => {
      event.stopPropagation();
      this.taskNew()?.setTransportAvailable(event.detail?.available);
    };
    this.boundTaskTransportRetry = (event) => {
      event.stopPropagation();
      this.retryTaskTransports();
    };

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-detail-pane" role="region" aria-label="Task content">
          <caffold-codex-readiness-recovery hidden></caffold-codex-readiness-recovery>
          <caffold-task-new hidden></caffold-task-new>
          <caffold-task-detail hidden></caffold-task-detail>
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
      this.adoptCreatedDetail(event.detail?.detail);
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
      if (event.detail?.type === "recheck") {
        void this.recheckRecovery();
      } else if (event.detail?.type === "resolved") {
        this.resolveRecovery(event.detail);
      }
    });
    this.addEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
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
    this.connectedTaskNavigator?.removeEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
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
    this.connectedTaskNavigator?.addEventListener(
      TASK_TRANSPORT_RETRY_EVENT,
      this.boundTaskTransportRetry,
    );
    this.syncTaskListState(this.connectedTaskNavigator?.listState());
    this.taskNew()?.setTransportAvailable(
      this.connectedTaskNavigator?.isTransportAvailable?.(),
    );
    this.connectedTaskNavigator?.setSelectedThreadId(this.selectedThreadId);
  }

  deactivate() {
    this.imagePreviewDialog()?.dismiss();
    if (this.view === "detail") {
      this.taskDetail()?.deactivate({ retainComposerDom: true });
    } else if (this.view === "recovery") {
      this.taskRecovery()?.deactivate();
    } else {
      this.taskNew()?.deactivate();
    }
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.currentRoute = { ...route };
    this.currentOpenOptions = { ...options };
    const target = routeTarget(route);
    const domain = routeDomain(route);
    const nextView = target === "recovery"
      ? "recovery"
      : route?.threadId
      ? "detail"
      : target === "new"
        ? "new"
        : "home";
    const nextDetailView = domain ||
      (["review", "review-file"].includes(target) ? "review" : "conversation");
    const nextThreadId = `${route?.threadId ?? ""}`;
    if (nextView !== this.view || nextThreadId !== this.selectedThreadId) {
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
    this.setAttribute("data-tasks-view", nextView);
    this.taskNavigator()?.setSelectedThreadId(nextThreadId);
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    }
    if (nextView !== "recovery") {
      this.taskRecovery()?.deactivate();
    }
    if (nextView === "detail") {
      this.taskNew()?.deactivate();
      this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask, route });
    } else if (nextView === "recovery") {
      this.taskNew()?.deactivate();
      this.taskRecovery()?.prepare(options.recovery ?? null);
    }
    this.render();
    return { preserveLoadedTask };
  }

  async openRoute(route, options = {}) {
    const prepared = this.prepareRoute(route, options);
    if (this.codexOperationsBlocked()) {
      this.render();
      return null;
    }
    const target = routeTarget(route);
    if (target === "new") {
      this.taskNew()?.prepare({
        cwd: route.cwd ?? "",
        defaultCwdPath: options.defaultCwdPath ?? "",
      });
      this.taskNew()?.open();
      void this.taskNavigator()?.activate();
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
    if (route?.threadId) {
      this.taskNew()?.deactivate();
      void this.taskNavigator()?.activate();
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

  adoptCreatedDetail(detail) {
    const threadId = taskDetailThreadId(detail);
    if (!threadId || !detail?.task) {
      return;
    }
    this.adoptedThreadId = threadId;
    this.selectedThreadId = threadId;
    this.taskDetail()?.adoptCreatedDetail(detail);
    this.taskNavigator()?.placeCanonicalTaskAtTop(
      detail.task,
      detail.activeTopPlacement,
    );
    this.requestRoute({ kind: "tasks", threadId });
  }

  async recheckRecovery() {
    const threadId = this.selectedThreadId;
    if (!threadId || this.view !== "recovery") {
      return null;
    }
    await this.taskNavigator()?.activate({ force: true });
    const recovery = this.taskNavigator()?.recoveryFor(threadId);
    if (recovery) {
      this.taskRecovery()?.updateRecovery(recovery);
      return recovery;
    }
    const task = this.taskNavigator()?.taskFor(threadId);
    this.requestRoute(
      task ? { kind: "tasks", threadId } : { kind: "tasks" },
      { replace: true },
    );
    return null;
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
    const wasBlocked = this.codexOperationsBlocked();
    this.codexStatusSnapshotValue = snapshot ?? INITIAL_CODEX_STATUS_SNAPSHOT;
    const blocked = this.codexOperationsBlocked();
    this.taskNew()?.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.taskNavigator()?.setCodexStatusSnapshot(this.codexStatusSnapshotValue);
    this.codexReadinessRecovery()?.setSnapshot(this.codexStatusSnapshotValue);
    if (this.codexRecoveryVisible()) {
      this.taskDetail()?.deactivate();
    }
    this.render();
    return wasBlocked && !blocked;
  }

  setCodexRestartState(state) {
    this.ensureRendered();
    this.codexRestartStateValue = state ?? { state: "idle", message: "" };
    this.codexReadinessRecovery()?.setRestartState(this.codexRestartStateValue);
  }

  codexOperationsBlocked() {
    return codexBlocksTaskOperations(this.codexStatusSnapshotValue.status);
  }

  codexRecoveryVisible() {
    return codexTaskRecoveryVisible(this.codexStatusSnapshotValue);
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
    return this.querySelector(":scope > .tasks-surface caffold-task-detail");
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

  retryTaskTransports() {
    const navigator = this.taskNavigator();
    const detail = this.taskDetail();
    return retryStaleTaskTransports([
      navigator
        ? {
            state: navigator.streamState,
            retry: () => navigator.retryStream(),
          }
        : null,
      detail
        ? {
            state: detail.streamState,
            retry: () => detail.retryStream(),
          }
        : null,
    ]);
  }

  syncTaskListState(state = {}) {
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
    const recoveryVisible = this.codexRecoveryVisible();
    this.codexReadinessRecovery()?.toggleAttribute("hidden", !recoveryVisible);
    this.taskNew()?.toggleAttribute("hidden", recoveryVisible || !showNew);
    this.taskDetail()?.toggleAttribute(
      "hidden",
      recoveryVisible || this.view !== "detail",
    );
    this.taskRecovery()?.toggleAttribute(
      "hidden",
      recoveryVisible || this.view !== "recovery",
    );
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
    this.dispatchEvent(
      new CustomEvent("caffold:tasks-presentation-change", { bubbles: true }),
    );
  }

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

if (!customElements.get("caffold-tasks-page")) {
  customElements.define("caffold-tasks-page", CaffoldTasksPage);
}
