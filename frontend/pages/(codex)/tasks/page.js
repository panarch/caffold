import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "./components/detail.js";
import "./components/navigator.js";
import "./components/task-new.js";
import {
  taskDetailThreadId,
  taskThreadId,
} from "./task-list-model.js";

const TASK_LIST_DEFAULT_WIDTH = 380;
const TASK_LIST_MIN_WIDTH = 280;
const TASK_LIST_MAX_WIDTH = 520;
const TASK_DETAIL_MIN_WIDTH = 520;
const TASK_LIST_RESIZER_WIDTH = 6;

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
    this.view = "list";
    this.selectedThreadId = "";
    this.taskListWidth = TASK_LIST_DEFAULT_WIDTH;
    this.adoptedThreadId = "";
    this.globalListenersAttached = false;
    this.boundResize = () => {
      this.clampTaskListWidth();
    };
    this.boundIconsReady = () => this.renderHeader();
    this.boundPointerMove = (event) => this.resizeTaskList(event);
    this.boundPointerUp = () => this.stopTaskListResize();
    warmIcons();

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-header-region"></div>
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
    `;

    this.addEventListener("click", (event) => this.handleClick(event));
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
      const detail = event.detail?.detail;
      if (detail?.managed !== false && event.detail?.task) {
        this.taskNavigator()?.upsertCanonicalTask(event.detail.task);
      }
    });
    this.addEventListener("caffold:task-detail-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "continue-thread") {
        void this.taskNavigator()?.continueThread(event.detail.threadId);
      }
    });
    this.addEventListener("caffold:task-detail-view-change", (event) => {
      this.setAttribute(
        "data-task-detail-view",
        event.detail?.view ?? "conversation",
      );
    });
    this.addEventListener("caffold:task-continued", (event) => {
      event.stopPropagation();
      const threadId = taskThreadId(event.detail?.task);
      if (threadId) {
        this.requestRoute({ kind: "tasks", threadId });
      }
    });
    this.addEventListener("caffold:task-continuation-change", (event) => {
      event.stopPropagation();
      if (event.detail?.threadId === this.selectedThreadId) {
        this.taskDetail()?.setContinuationState(
          this.taskNavigator()?.continuationState(this.selectedThreadId),
        );
      }
    });
    this.render();
  }

  attachGlobalListeners() {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    window.addEventListener("resize", this.boundResize);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("resize", this.boundResize);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    const nextView = route?.new
      ? "new"
      : route?.threadId
        ? "detail"
        : "list";
    const nextThreadId = `${route?.threadId ?? ""}`;
    const preserveAdopted =
      nextThreadId &&
      this.adoptedThreadId === nextThreadId &&
      taskDetailThreadId(this.taskDetail()?.currentDetail()) === nextThreadId;
    const preserveLoadedTask =
      Boolean(options.preserveLoadedTask) || preserveAdopted;

    this.view = nextView;
    this.selectedThreadId = nextThreadId;
    this.setAttribute("data-tasks-view", nextView);
    this.taskNavigator()?.setSelectedThreadId(nextThreadId);
    if (nextView !== "detail") {
      this.taskDetail()?.deactivate();
    } else {
      this.taskNew()?.deactivate();
      this.taskDetail()?.prepare(nextThreadId, { preserveLoadedTask });
      this.taskDetail()?.setContinuationState(
        this.taskNavigator()?.continuationState(nextThreadId),
      );
    }
    this.render();
    return { preserveLoadedTask };
  }

  async openRoute(route, options = {}) {
    const prepared = this.prepareRoute(route, options);
    if (route?.new) {
      this.taskNew()?.prepare({
        cwd: route.cwd ?? "",
        defaultCwdPath: options.defaultCwdPath ?? "",
        home: false,
      });
      this.taskNew()?.open({ home: false });
      void this.taskNavigator()?.activate();
      this.render();
      return null;
    }
    if (route?.threadId) {
      this.taskNew()?.deactivate();
      void this.taskNavigator()?.activate();
      const result = await this.taskDetail()?.open(route.threadId, {
        preserveLoadedTask: prepared.preserveLoadedTask,
      });
      if (this.adoptedThreadId === route.threadId) {
        this.adoptedThreadId = "";
      }
      return result;
    }
    this.taskNew()?.prepare({
      defaultCwdPath: options.defaultCwdPath ?? "",
      home: true,
    });
    this.taskNew()?.open({ home: true });
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

  handleClick(event) {
    const action =
      event.target instanceof Element
        ? event.target.closest(
            ".tasks-header-region [data-task-action]",
          )
        : null;
    if (!action || !this.contains(action)) {
      return;
    }
    if (action.dataset.taskAction === "open-list") {
      this.requestRoute({ kind: "tasks" });
    } else if (action.dataset.taskAction === "open-new") {
      this.requestNewTaskRoute();
    } else if (action.dataset.taskAction === "open-settings") {
      this.dispatchEvent(
        new CustomEvent("caffold:open-settings", {
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  requestRoute(route) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: { route: { ...route } },
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
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    const showNew = this.view === "new" || this.view === "list";
    this.taskNew()?.toggleAttribute("hidden", !showNew);
    this.taskDetail()?.toggleAttribute("hidden", this.view !== "detail");
    this.renderHeader();
    this.applyTaskListWidth();
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
  }

  renderHeader() {
    const region = this.querySelector(".tasks-header-region");
    if (!region) {
      return;
    }
    region.innerHTML = `
      <header class="tasks-header">
        <div class="tasks-brand">
          <img
            class="tasks-brand-mark"
            src="/assets/icons/caffold-mark.svg"
            alt=""
          />
          <h1>Caffold</h1>
        </div>
        <div class="tasks-header-actions">
          <button type="button" class="task-icon-button" data-task-action="open-settings" title="Settings">
            ${renderInlineIcon("Settings", "Settings", "task-action-icon")}
          </button>
          ${
            this.view === "detail"
              ? `<button type="button" class="task-icon-button" data-task-action="open-list" title="Open tasks">
                  ${renderInlineIcon("ListTodo", "Open tasks", "task-action-icon")}
                </button>`
              : ""
          }
          ${
            this.view !== "new"
              ? `<button type="button" class="task-primary-button" data-task-action="open-new">
                  ${renderInlineIcon("Plus", "New task", "task-action-icon")}
                  <span class="task-action-label">New Task</span>
                </button>`
              : ""
          }
        </div>
      </header>
    `;
  }

  startTaskListResize(event, separator) {
    if (event.button !== 0 || !window.matchMedia("(min-width: 960px)").matches) {
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
    if (!separator || !window.matchMedia("(min-width: 960px)").matches) {
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
    const available =
      shellWidth - TASK_LIST_RESIZER_WIDTH - TASK_DETAIL_MIN_WIDTH;
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

  applyTaskListWidth() {
    this.style.setProperty("--tasks-list-width", `${this.taskListWidth}px`);
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
