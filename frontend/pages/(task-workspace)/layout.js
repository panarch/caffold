import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import { routeTarget } from "../../navigation-routes.js";
import "./components/navigation.js";
import "./tasks/components/navigator.js";
import "./tasks/page.js";
import "./settings/navigator.js";
import "./settings/layout.js";

const TASK_LIST_DEFAULT_WIDTH = 380;
const TASK_LIST_MIN_WIDTH = 280;
const TASK_LIST_MAX_WIDTH = 520;
const TASK_DETAIL_MIN_WIDTH = 520;
const TASKS_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";

class CaffoldTaskWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderIcons();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
    this.attachGlobalListeners();
    void warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.stopTaskListResize();
    this.detachGlobalListeners();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.mode = "tasks";
    this.route = { kind: "tasks" };
    this.lastTaskRoute = { kind: "tasks" };
    this.taskListWidth = TASK_LIST_DEFAULT_WIDTH;
    this.globalListenersAttached = false;
    this.boundResize = () => this.syncTaskListWidth();
    this.boundPointerMove = (event) => this.resizeTaskList(event);
    this.boundPointerUp = () => this.stopTaskListResize();
    this.innerHTML = `
      <button
        type="button"
        class="task-workspace-route-control task-workspace-back"
        aria-label="Back to tasks"
        title="Back to tasks"
        hidden
      >
        ${renderInlineIcon("ArrowLeft", "Back to tasks", "task-workspace-route-control-icon")}
      </button>
      <button
        type="button"
        class="task-workspace-route-control task-workspace-close"
        aria-label="Close new task"
        title="Close new task"
        hidden
      >
        ${renderInlineIcon("X", "Close new task", "task-workspace-route-control-icon")}
      </button>
      <section class="task-workspace-surface">
        <div class="task-workspace-master-detail">
          <aside class="task-workspace-master-pane" aria-label="Workspace navigation">
            <caffold-task-navigator class="tasks-list-region"></caffold-task-navigator>
            <caffold-settings-navigator hidden></caffold-settings-navigator>
            <caffold-task-workspace-navigation></caffold-task-workspace-navigation>
          </aside>
          <div
            class="task-workspace-master-resizer"
            role="separator"
            tabindex="0"
            aria-label="Resize tasks list"
            aria-orientation="vertical"
            aria-valuemin="${TASK_LIST_MIN_WIDTH}"
            aria-valuemax="${TASK_LIST_MAX_WIDTH}"
            aria-valuenow="${this.taskListWidth}"
          ></div>
          <main class="task-workspace-detail-pane" aria-label="Workspace content">
            <caffold-tasks-page></caffold-tasks-page>
            <caffold-settings-workspace hidden></caffold-settings-workspace>
          </main>
        </div>
      </section>
    `;
    this.backButton = this.querySelector(".task-workspace-back");
    this.closeButton = this.querySelector(".task-workspace-close");
    this.masterDetail = this.querySelector(".task-workspace-master-detail");
    this.masterPane = this.querySelector(".task-workspace-master-pane");
    this.taskNavigator = this.querySelector("caffold-task-navigator");
    this.settingsNavigator = this.querySelector("caffold-settings-navigator");
    this.masterResizer = this.querySelector(".task-workspace-master-resizer");
    this.tasksPage = this.querySelector("caffold-tasks-page");
    this.settingsWorkspace = this.querySelector("caffold-settings-workspace");
    this.navigation = this.querySelector("caffold-task-workspace-navigation");
    this.tasksPage.ensureRendered();
    this.settingsWorkspace.ensureRendered();
    this.tasksPage.connectTaskNavigator(this.taskNavigator);
    this.settingsWorkspace.connectSettingsNavigator(this.settingsNavigator);
    this.renderIcons();

    this.backButton.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:request-tasks-route", {
          bubbles: true,
          detail: {
            route: { kind: "tasks" },
            replace: true,
          },
        }),
      );
    });
    this.closeButton.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("caffold:close-task-workspace", { bubbles: true }),
      );
    });
    this.navigation.addEventListener(
      "caffold:workspace-navigation-intent",
      (event) => {
        event.stopPropagation();
        const route = event.detail?.mode === "tasks"
          ? this.lastTaskRoute
          : { kind: "settings", section: "" };
        this.dispatchEvent(
          new CustomEvent("caffold:request-workspace-route", {
            bubbles: true,
            detail: { route: { ...route } },
          }),
        );
      },
    );
    this.masterResizer.addEventListener("pointerdown", (event) => {
      this.startTaskListResize(event, this.masterResizer);
    });
    this.masterResizer.addEventListener("keydown", (event) => {
      if (this.handleTaskListResizeKeydown(event)) {
        event.stopPropagation();
      }
    });
    this.addEventListener("caffold:tasks-presentation-change", (event) => {
      if (event.target !== this.tasksPage) {
        return;
      }
      event.stopPropagation();
      this.syncPresentationState();
    });
    this.addEventListener("caffold:settings-presentation-change", (event) => {
      if (event.target !== this.settingsWorkspace) {
        return;
      }
      event.stopPropagation();
      this.syncPresentationState();
    });
    this.applyTaskListWidth();
    this.updateChrome();
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

  renderIcons() {
    if (this.backButton) {
      this.backButton.innerHTML = renderInlineIcon(
        "ArrowLeft",
        "Back to tasks",
        "task-workspace-route-control-icon",
      );
    }
    if (this.closeButton) {
      this.closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close new task",
        "task-workspace-route-control-icon",
      );
    }
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    this.route = route;
    this.mode = route?.kind === "settings" ? "settings" : "tasks";
    if (this.mode === "tasks") {
      this.lastTaskRoute = { ...route };
      this.tasksPage.prepareRoute(route, options);
    } else {
      this.settingsWorkspace.prepareRoute(route);
    }
    this.taskNavigator.hidden = this.mode !== "tasks";
    this.settingsNavigator.hidden = this.mode !== "settings";
    this.tasksPage.hidden = this.mode !== "tasks";
    this.settingsWorkspace.hidden = this.mode !== "settings";
    this.updateChrome();
  }

  async openRoute(route, options = {}) {
    this.prepareRoute(route, options);
    if (this.mode === "settings") {
      return null;
    }
    const result = await this.tasksPage.openRoute(route, options);
    this.updateChrome();
    return result;
  }

  selectedTaskContextPath() {
    this.ensureRendered();
    return this.tasksPage.selectedTaskContextPath();
  }

  setCodexStatus(status) {
    this.ensureRendered();
    this.settingsWorkspace.setCodexStatus(status);
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.settingsWorkspace.setBuildStatus(health);
  }

  updateChrome() {
    if (!this.backButton || !this.closeButton) {
      return;
    }
    const taskRoute = this.mode === "tasks" ? this.route : null;
    const target = taskRoute ? routeTarget(taskRoute) : null;
    const showBack = ["detail", "review", "review-file"].includes(target);
    const showClose = target === "new";

    this.backButton.hidden = !showBack;
    this.closeButton.hidden = !showClose;
    this.toggleAttribute(
      "data-workspace-route-control-visible",
      showBack || showClose,
    );
    this.toggleAttribute("data-workspace-back-visible", showBack);
    this.toggleAttribute("data-workspace-close-visible", showClose);
    this.dataset.workspaceMode = this.mode ?? "tasks";
    this.syncPresentationState();

    this.renderIcons();
    this.navigation.setMode(this.mode);
    this.syncTaskListWidth();
  }

  syncPresentationState() {
    if (!this.tasksPage || !this.settingsWorkspace) {
      return;
    }
    this.dataset.tasksView = this.tasksPage.dataset.tasksView ?? "home";
    this.dataset.taskListState =
      this.tasksPage.dataset.taskListState ?? "loading";
    this.dataset.taskDetailView =
      this.tasksPage.dataset.taskDetailView ?? "conversation";
    this.dataset.settingsView =
      this.settingsWorkspace.dataset.settingsView ?? "list";
  }

  startTaskListResize(event, separator) {
    if (
      event.button !== 0 ||
      this.mode !== "tasks" ||
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
    if (
      event.currentTarget !== this.masterResizer ||
      this.mode !== "tasks" ||
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
    const available = (this.masterDetail?.clientWidth ?? 0) - TASK_DETAIL_MIN_WIDTH;
    return Math.max(
      TASK_LIST_MIN_WIDTH,
      Math.min(TASK_LIST_MAX_WIDTH, available),
    );
  }

  setTaskListWidth(width) {
    this.taskListWidth = Math.max(
      TASK_LIST_MIN_WIDTH,
      Math.min(this.taskListMaximumWidth(), width),
    );
    this.applyTaskListWidth();
  }

  syncTaskListWidth() {
    const shellWidth = this.masterDetail?.clientWidth ?? 0;
    if (
      !window.matchMedia(TASKS_MASTER_DETAIL_MEDIA_QUERY).matches ||
      shellWidth <= 0
    ) {
      this.applyTaskListWidth();
      return;
    }
    this.setTaskListWidth(this.taskListWidth);
  }

  applyTaskListWidth() {
    this.style.setProperty(
      "--task-workspace-master-width",
      `${this.taskListWidth}px`,
    );
    if (!this.masterResizer) {
      return;
    }
    this.masterResizer.setAttribute(
      "aria-valuemax",
      `${this.taskListMaximumWidth()}`,
    );
    this.masterResizer.setAttribute(
      "aria-valuenow",
      `${Math.round(this.taskListWidth)}`,
    );
  }
}

customElements.define("caffold-task-workspace", CaffoldTaskWorkspace);
