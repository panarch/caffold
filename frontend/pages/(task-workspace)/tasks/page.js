import { routeTarget } from "../../../navigation-routes.js";
import "./components/detail.js";
import {
  TASK_IMAGE_PREVIEW_EVENT,
} from "./components/image-preview-dialog.js";
import "./components/navigator.js";
import "./components/task-new.js";
import { taskDetailThreadId } from "./task-list-model.js";

const TASK_LIST_DEFAULT_WIDTH = 380;
const TASK_LIST_MIN_WIDTH = 280;
const TASK_LIST_MAX_WIDTH = 520;
const TASK_DETAIL_MIN_WIDTH = 520;
const TASKS_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";

class CaffoldTasksPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachGlobalListeners();
  }

  disconnectedCallback() {
    this.stopTaskListResize();
    this.detachGlobalListeners();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.view = "home";
    this.taskListState = "loading";
    this.selectedThreadId = "";
    this.taskListWidth = TASK_LIST_DEFAULT_WIDTH;
    this.adoptedThreadId = "";
    this.globalListenersAttached = false;
    this.boundResize = () => this.syncTaskListWidth();
    this.boundPointerMove = (event) => this.resizeTaskList(event);
    this.boundPointerUp = () => this.stopTaskListResize();

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-master-detail">
          <aside class="tasks-list-pane" aria-label="Tasks list">
            <caffold-task-navigator class="tasks-list-region"></caffold-task-navigator>
          </aside>
          <div
            class="tasks-master-resizer"
            role="separator"
            tabindex="0"
            aria-label="Resize tasks list"
            aria-orientation="vertical"
            aria-valuemin="${TASK_LIST_MIN_WIDTH}"
            aria-valuemax="${TASK_LIST_MAX_WIDTH}"
            aria-valuenow="${this.taskListWidth}"
          ></div>
          <main class="tasks-detail-pane" aria-label="Task content">
            <caffold-task-new hidden></caffold-task-new>
            <caffold-task-detail hidden></caffold-task-detail>
          </main>
        </div>
      </section>
      <caffold-task-image-preview-dialog></caffold-task-image-preview-dialog>
    `;

    this.addEventListener("pointerdown", (event) => {
      const separator =
        event.target instanceof Element
          ? event.target.closest(".tasks-master-resizer")
          : null;
      if (separator) {
        this.startTaskListResize(event, separator);
      }
    });
    this.addEventListener("keydown", (event) => {
      if (this.handleTaskListResizeKeydown(event)) {
        event.stopPropagation();
      }
    });
    this.addEventListener("caffold:task-navigator-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "select-task") {
        this.requestRoute({
          kind: "tasks",
          threadId: event.detail.threadId,
        });
      } else if (event.detail?.type === "new-task") {
        this.requestNewTaskRoute();
      }
    });
    this.addEventListener("caffold:task-navigator-list-state", (event) => {
      event.stopPropagation();
      this.syncTaskListState(event.detail);
    });
    this.addEventListener("caffold:task-navigator-transport-change", (event) => {
      event.stopPropagation();
      this.taskNew()?.setTransportAvailable(event.detail?.available);
    });
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
      } else if (event.detail?.type === "review-route" && event.detail.route) {
        this.requestRoute(event.detail.route, {
          replace: event.detail.replace,
        });
      }
    });
    this.addEventListener(TASK_IMAGE_PREVIEW_EVENT, (event) => {
      event.stopPropagation();
      this.imagePreviewDialog()?.openImage(event.detail);
    });
    this.syncTaskListState(this.taskNavigator()?.listState());
    this.render();
  }

  attachGlobalListeners() {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    window.addEventListener("resize", this.boundResize);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("resize", this.boundResize);
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    const target = routeTarget(route);
    const nextView =
      target === "new" ? "new" : target === "home" ? "home" : "detail";
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
    this.selectedThreadId = nextThreadId;
    this.setAttribute("data-tasks-view", nextView);
    this.taskNavigator()?.setSelectedThreadId(nextThreadId);
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    } else {
      this.taskNew()?.deactivate();
      this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask, route });
    }
    this.render();
    return { preserveLoadedTask };
  }

  async openRoute(route, options = {}) {
    const prepared = this.prepareRoute(route, options);
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
    if (["detail", "review", "review-file"].includes(target)) {
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
    this.taskNavigator()?.upsertCanonicalTask(detail.task);
    this.requestRoute({ kind: "tasks", threadId });
  }

  get taskDetailView() {
    return this.taskDetail()?.taskDetailView ?? "conversation";
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.view === "detail"
      ? this.taskDetail()?.selectedTaskContextPath() ?? ""
      : this.taskNew()?.selectedContextPath() ?? "";
  }

  closeActiveSubview() {
    return this.taskDetail()?.closeActiveSubview() ?? false;
  }

  taskNavigator() {
    return this.querySelector(":scope > .tasks-surface caffold-task-navigator");
  }

  taskNew() {
    return this.querySelector(":scope > .tasks-surface caffold-task-new");
  }

  taskDetail() {
    return this.querySelector(":scope > .tasks-surface caffold-task-detail");
  }

  imagePreviewDialog() {
    return this.querySelector(
      ":scope > caffold-task-image-preview-dialog",
    );
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
    const cwd = this.selectedTaskContextPath();
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
    const showNew = this.view === "new" || this.view === "home";
    this.taskNew()?.toggleAttribute("hidden", !showNew);
    this.taskDetail()?.toggleAttribute("hidden", this.view !== "detail");
    this.syncTaskListWidth();
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
  }

  startTaskListResize(event, separator) {
    if (
      event.button !== 0 ||
      !window.matchMedia(TASKS_MASTER_DETAIL_MEDIA_QUERY).matches
    ) {
      return;
    }
    event.preventDefault();
    this.taskListResizeStart = {
      pointerX: event.clientX,
      width: this.taskListWidth,
    };
    this.classList.add("is-resizing-task-list");
    separator.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", this.boundPointerMove);
    window.addEventListener("pointerup", this.boundPointerUp, { once: true });
    window.addEventListener("pointercancel", this.boundPointerUp, { once: true });
  }

  resizeTaskList(event) {
    if (!this.taskListResizeStart) {
      return;
    }
    this.setTaskListWidth(
      this.taskListResizeStart.width +
        event.clientX -
        this.taskListResizeStart.pointerX,
    );
  }

  stopTaskListResize() {
    this.taskListResizeStart = null;
    this.classList.remove("is-resizing-task-list");
    window.removeEventListener("pointermove", this.boundPointerMove);
    window.removeEventListener("pointerup", this.boundPointerUp);
    window.removeEventListener("pointercancel", this.boundPointerUp);
  }

  handleTaskListResizeKeydown(event) {
    const separator =
      event.target instanceof Element
        ? event.target.closest(".tasks-master-resizer")
        : null;
    if (
      !separator ||
      !window.matchMedia(TASKS_MASTER_DETAIL_MEDIA_QUERY).matches
    ) {
      return false;
    }
    let nextWidth = this.taskListWidth;
    if (event.key === "ArrowLeft") {
      nextWidth -= event.shiftKey ? 40 : 16;
    } else if (event.key === "ArrowRight") {
      nextWidth += event.shiftKey ? 40 : 16;
    } else if (event.key === "Home") {
      nextWidth = TASK_LIST_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = this.taskListMaximumWidth();
    } else {
      return false;
    }
    event.preventDefault();
    this.setTaskListWidth(nextWidth);
    return true;
  }

  taskListMaximumWidth() {
    const shellWidth = this.querySelector(".tasks-master-detail")?.clientWidth ?? 0;
    const available = shellWidth - TASK_DETAIL_MIN_WIDTH;
    return Math.max(
      TASK_LIST_MIN_WIDTH,
      Math.min(TASK_LIST_MAX_WIDTH, available),
    );
  }

  setTaskListWidth(width) {
    const maximum = this.taskListMaximumWidth();
    this.taskListWidth = Math.max(
      TASK_LIST_MIN_WIDTH,
      Math.min(maximum, width),
    );
    this.applyTaskListWidth();
  }

  clampTaskListWidth() {
    this.setTaskListWidth(this.taskListWidth);
  }

  syncTaskListWidth() {
    const shellWidth =
      this.querySelector(".tasks-master-detail")?.clientWidth ?? 0;
    if (
      !window.matchMedia(TASKS_MASTER_DETAIL_MEDIA_QUERY).matches ||
      shellWidth <= 0
    ) {
      this.applyTaskListWidth();
      return;
    }
    this.clampTaskListWidth();
  }

  applyTaskListWidth() {
    const workspace = this.closest("caffold-task-workspace");
    (workspace ?? this).style.setProperty(
      "--tasks-list-width",
      `${this.taskListWidth}px`,
    );
    const separator = this.querySelector(".tasks-master-resizer");
    if (!separator) {
      return;
    }
    separator.setAttribute(
      "aria-valuemax",
      `${this.taskListMaximumWidth()}`,
    );
    separator.setAttribute("aria-valuenow", `${Math.round(this.taskListWidth)}`);
  }
}

if (!customElements.get("caffold-tasks-page")) {
  customElements.define("caffold-tasks-page", CaffoldTasksPage);
}
