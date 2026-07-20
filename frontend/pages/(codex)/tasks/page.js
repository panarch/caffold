import {
  createTask,
  getCodexModels,
  getGitHubStatus,
  getGitStatus,
  getTask,
  getTasks,
  interruptTask,
  resolveTaskApproval,
  sendTaskPrompt,
  taskListStreamUrl,
  taskStreamUrl,
} from "../../../api.js";
import { escapeHtml } from "../../../components/dom.js";
import "../../../components/file-browser.js";
import "../../../components/git-compare-browser.js";
import "../../../components/git-diff-browser.js";
import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import { createRefreshCoordinator, subscribeToWatch } from "../../../watch.js";
import "./components/markdown.js";

const FALLBACK_REASONING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "ultra", label: "Very high" },
];
const FALLBACK_EFFORT = "ultra";
const STREAM_ERROR_DELAY_MS = 8_000;
const TASK_LIST_DEFAULT_WIDTH = 380;
const TASK_LIST_MIN_WIDTH = 280;
const TASK_LIST_MAX_WIDTH = 520;
const TASK_DETAIL_MIN_WIDTH = 520;
const TASK_LIST_RESIZER_WIDTH = 6;
const TASK_SEEN_STORAGE_KEY = "caffold.tasks.seen-versions.v1";
const TASK_COMPOSER_MAX_IMAGES = 4;
const TASK_COMPOSER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TASK_COMPOSER_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

class CaffoldTasksPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachGlobalListeners();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.view = "list";
    this.tasks = [];
    this.taskListLoading = false;
    this.taskListLoaded = false;
    this.taskListError = null;
    this.taskListRequestId = 0;
    this.taskListContext = "";
    this.taskListDirty = true;
    this.taskListStream = null;
    this.taskListStreamContext = "";
    this.taskListStreamNeedsSync = false;
    this.taskListWidth = TASK_LIST_DEFAULT_WIDTH;
    this.taskSeenState = readTaskSeenState();
    this.taskDetail = null;
    this.taskGithubStatus = null;
    this.taskGithubStatusPath = "";
    this.taskGithubStatusState = "idle";
    this.taskGithubStatusRequestId = 0;
    this.events = [];
    this.eventsThreadId = "";
    this.eventsByThread = new Map();
    this.eventsPage = { nextCursor: null };
    this.error = null;
    this.loading = false;
    this.loadingOlderEvents = false;
    this.cwdPath = "";
    this.defaultCwdPath = "";
    this.newTaskBrowsing = false;
    this.selectedThreadId = "";
    this.stream = null;
    this.streamState = "idle";
    this.streamGeneration = 0;
    this.streamErrorTimer = null;
    this.activeTurnClockTimer = null;
    this.taskRefresh = null;
    this.requestId = 0;
    this.conversationScrollMode = null;
    this.conversationScrollByThread = new Map();
    this.newTaskDraft = { prompt: "" };
    this.newTaskImages = [];
    this.followUpDraft = "";
    this.followUpDraftByThread = new Map();
    this.followUpImages = [];
    this.followUpImagesByThread = new Map();
    this.composerImageErrors = new Map();
    this.followUpRequest = null;
    this.modelOptions = [];
    this.modelOptionsLoaded = false;
    this.modelOptionsLoading = false;
    this.modelOptionsError = null;
    this.composerSettings = {
      model: "",
      effort: "",
    };
    this.openModelPickerForm = "";
    this.taskDetailView = "conversation";
    this.taskDiffMode = "working";
    this.taskDiffStatus = null;
    this.taskDiffError = null;
    this.taskDiffRequestId = 0;
    this.taskDiffWatchUnsubscribe = null;
    this.taskDiffWatchPath = "";
    this.taskDiffWatchUnavailable = false;
    this.taskDiffRefreshState = "idle";
    this.taskDiffRefreshCoordinator = createRefreshCoordinator(
      () => this.refreshTaskDiff(),
      (state) => this.setTaskDiffRefreshState(state),
    );
    this.taskCompareRefreshCoordinator = createRefreshCoordinator(
      () => this.refreshTaskCompare(),
      (state) => this.setTaskDiffRefreshState(state),
    );
    this.boundIconsReady = () => {
      this.querySelector(".tasks-header-region")?.removeAttribute("data-render-key");
      this.markTaskListDirty();
      this.render();
    };
    this.boundTaskListResize = () => this.clampTaskListWidth();
    this.boundVisibilityChange = () => this.handleVisibilityChange();
    this.boundTaskListPointerMove = (event) => this.resizeTaskList(event);
    this.boundTaskListPointerUp = () => this.stopTaskListResize();
    warmIcons();

    this.addEventListener(
      "click",
      (event) => {
        const reviewMenu = closestElement(event.target, ".task-review-menu");
        for (const menu of this.querySelectorAll(".task-review-menu[open]")) {
          if (menu !== reviewMenu) {
            menu.removeAttribute("open");
          }
        }
        const action = closestElement(event.target, "[data-task-action]");
        if (!action) {
          if (!closestElement(event.target, ".task-model-picker")) {
            window.setTimeout(() => this.closeModelPicker(), 0);
          }
          return;
        }

        this.handleAction(action.dataset.taskAction, action);
      },
      true,
    );
    this.addEventListener("pointerdown", (event) => {
      const separator = closestElement(event.target, ".tasks-master-resizer");
      if (separator) {
        this.startTaskListResize(event, separator);
      }
    });
    this.addEventListener("caffold:task-markdown-rendered", (event) =>
      this.handleTaskMarkdownRendered(event),
    );
    this.addEventListener("caffold:open-git-diff", (event) => {
      const browser = closestElement(event.target, "caffold-git-diff-browser");
      if (!browser || !this.querySelector(".task-diff-view")?.contains(browser)) {
        return;
      }
      event.stopPropagation();
      browser.openDiff(event.detail.path, event.detail.kind, event.detail.status);
    });
    this.addEventListener("caffold:open-compare-diff", (event) => {
      const browser = closestElement(event.target, "caffold-git-compare-browser");
      if (!browser || !this.querySelector(".task-diff-view")?.contains(browser)) {
        return;
      }
      event.stopPropagation();
      browser.openDiff(event.detail.path, event.detail.status);
    });
    this.addEventListener("caffold:git-compare-state-change", (event) => {
      const browser = closestElement(event.target, "caffold-git-compare-browser");
      if (!browser || !this.querySelector(".task-diff-view")?.contains(browser)) {
        return;
      }
      event.stopPropagation();
      this.patchTaskDiffHeader();
    });
    this.addEventListener("caffold:close-file-viewer", (event) => {
      const browser = closestElement(
        event.target,
        "caffold-git-diff-browser, caffold-git-compare-browser",
      );
      if (!browser || !this.querySelector(".task-diff-view")?.contains(browser)) {
        return;
      }
      event.stopPropagation();
      browser.showList();
    });
    this.addEventListener("click", (event) => {
      const button = closestElement(event.target, '[data-action="refresh-git-review"]');
      if (!button || !this.querySelector(".task-diff-view")?.contains(button)) {
        return;
      }
      event.stopPropagation();
      this.requestTaskReviewRefresh();
    });
    this.addEventListener("change", (event) => {
      const select = closestElement(event.target, "select[data-task-compare-base]");
      if (!select) {
        return;
      }
      this.changeTaskCompareBase(select.value);
    });
    this.addEventListener("input", (event) => {
      const textarea = closestElement(event.target, "textarea[name='prompt']");
      if (textarea) {
        syncComposerTextarea(textarea);
      }

      const form = closestElement(event.target, "form[data-task-form]");
      if (!form) {
        return;
      }

      this.captureDraft(form);
    });
    this.addEventListener(
      "paste",
      (event) => {
        void this.handleComposerPaste(event);
      },
      true,
    );
    this.addEventListener("keydown", (event) => {
      if (this.handleTaskListResizeKeydown(event)) {
        return;
      }
      this.handlePromptKeydown(event);
    });
    this.addEventListener(
      "submit",
      (event) => {
        const form = closestElement(event.target, "form[data-task-form]");
        if (!form) {
          return;
        }

        event.preventDefault();
        this.handleForm(form.dataset.taskForm, form);
      },
      true,
    );
    this.render();
  }

  disconnectedCallback() {
    this.detachGlobalListeners();
    this.stopTaskListResize();
    this.closeStream();
    this.closeTaskListStream();
    this.unsubscribeTaskDiffWatch();
    this.stopActiveTurnClock();
  }

  syncActiveTurnClock() {
    const activeTurn = this.querySelector("[data-active-turn-started-ms]");
    if (!activeTurn) {
      this.stopActiveTurnClock();
      return;
    }

    this.updateActiveTurnClock();
    if (this.activeTurnClockTimer) {
      return;
    }
    this.activeTurnClockTimer = window.setInterval(
      () => this.updateActiveTurnClock(),
      1_000,
    );
  }

  updateActiveTurnClock() {
    const activeTurn = this.querySelector("[data-active-turn-started-ms]");
    const duration = activeTurn?.querySelector(".task-turn-active-duration");
    const startedMs = Number(activeTurn?.dataset.activeTurnStartedMs);
    if (!activeTurn || !duration || !Number.isFinite(startedMs)) {
      this.stopActiveTurnClock();
      return;
    }
    duration.textContent = `Working for ${formatDuration(Date.now() - startedMs)}`;
  }

  stopActiveTurnClock() {
    window.clearInterval(this.activeTurnClockTimer);
    this.activeTurnClockTimer = null;
  }

  attachGlobalListeners() {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    window.addEventListener("resize", this.boundTaskListResize);
    document.addEventListener("visibilitychange", this.boundVisibilityChange);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    window.removeEventListener("resize", this.boundTaskListResize);
    document.removeEventListener("visibilitychange", this.boundVisibilityChange);
  }

  syncTaskListContext() {
    const context = `cwd:${cleanLogicalPath(this.cwdPath)}`;
    if (context === this.taskListContext) {
      return;
    }

    this.taskListContext = context;
    this.closeTaskListStream();
    this.taskListRequestId += 1;
    this.taskListLoading = false;
    this.taskListLoaded = false;
    this.taskListError = null;
    this.tasks = [];
    this.markTaskListDirty();
  }

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    if (
      options.preserveLoadedTask &&
      route?.threadId &&
      this.selectedThreadId === route.threadId &&
      this.taskDetail?.task?.threadId === route.threadId
    ) {
      this.view = "detail";
      this.error = null;
      this.activateThreadEvents(route.threadId);
      this.setAttribute("data-tasks-view", this.view);
      return;
    }

    this.error = null;
    if (route?.new) {
      this.view = "new";
      this.taskDetailView = "conversation";
      this.unsubscribeTaskDiffWatch();
      this.selectedThreadId = "";
      this.activateThreadEvents("");
      this.closeStream();
    } else if (route?.threadId) {
      this.newTaskBrowsing = false;
      if (this.selectedThreadId !== route.threadId) {
        this.taskDetailView = "conversation";
        this.taskDiffMode = "working";
        this.unsubscribeTaskDiffWatch();
        this.taskDiffRequestId += 1;
        this.taskDiffStatus = null;
        this.taskDiffError = null;
        this.resetTaskGithubStatus();
        this.closeStream();
      }
      this.view = "detail";
      this.selectedThreadId = route.threadId;
      this.activateThreadEvents(route.threadId);
      this.followUpDraft = this.followUpDraftByThread.get(route.threadId) ?? "";
      this.followUpImages = [...(this.followUpImagesByThread.get(route.threadId) ?? [])];
      this.taskDetail =
        this.taskDetail?.task?.threadId === route.threadId ? this.taskDetail : null;
      this.eventsPage =
        this.taskDetail?.task?.threadId === route.threadId
          ? this.eventsPage
          : { nextCursor: null };
    } else {
      this.newTaskBrowsing = false;
      this.view = "list";
      this.taskDetailView = "conversation";
      this.unsubscribeTaskDiffWatch();
      this.selectedThreadId = "";
      this.activateThreadEvents("");
      this.eventsPage = { nextCursor: null };
      this.closeStream();
    }
    this.setAttribute("data-tasks-view", this.view);
    this.render();
  }

  async openRoute(route, options = {}) {
    this.cwdPath = route?.cwd ?? "";
    this.defaultCwdPath = options.defaultCwdPath ?? this.defaultCwdPath;
    this.syncTaskListContext();
    this.connectTaskListStream();
    this.prepareRoute(route, options);
    if (route?.new) {
      return this.openNew();
    }
    if (route?.threadId) {
      if (
        options.preserveLoadedTask &&
        this.taskDetail?.task?.threadId === route.threadId
      ) {
        this.loading = false;
        this.loadTaskGithubStatus(this.taskDetail.task);
        this.loadModelOptions();
        return this.taskDetail;
      }
      return await this.openTask(route.threadId);
    }
    return await this.openList();
  }

  async openList() {
    this.requestId += 1;
    this.loading = false;
    this.error = null;
    this.view = "list";
    this.render();
    return await this.loadTaskList({ force: true });
  }

  openNew() {
    this.view = "new";
    this.error = null;
    this.loading = false;
    this.openModelPickerForm = "";
    this.closeStream();
    this.render();
    this.loadTaskList();
    this.loadModelOptions();
    this.querySelector("textarea[name='prompt']")?.focus();
    return null;
  }

  async openTask(threadId) {
    if (!threadId) {
      return null;
    }

    const requestId = ++this.requestId;
    this.view = "detail";
    this.selectedThreadId = threadId;
    this.loading = true;
    this.error = null;
    this.render();
    this.loadTaskList();
    this.connectStream(threadId);

    try {
      const detail = await getTask(threadId, null, this.cwdPath);
      if (requestId !== this.requestId) {
        return null;
      }
      this.taskDetail = detail;
      this.setThreadEvents(
        threadId,
        mergeEvents(this.eventsByThread.get(threadId) ?? [], detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.loading = false;
      this.markTaskSeen(detail.task);
      this.patchTaskListTask(detail.task);
      this.conversationScrollMode = "bottom";
      this.render();
      this.loadTaskGithubStatus(detail.task);
      this.loadModelOptions();
      return detail;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loading = false;
      this.error = error;
      this.render();
      return null;
    }
  }

  rememberActiveThreadEvents() {
    if (!this.eventsThreadId || this.events.length === 0) {
      return;
    }

    this.eventsByThread.set(
      this.eventsThreadId,
      mergeEvents(
        this.eventsByThread.get(this.eventsThreadId) ?? [],
        this.events,
      ),
    );
  }

  activateThreadEvents(threadId) {
    if (this.eventsThreadId === threadId) {
      return;
    }

    this.rememberActiveThreadEvents();
    this.eventsThreadId = threadId;
    this.events = threadId ? [...(this.eventsByThread.get(threadId) ?? [])] : [];
  }

  setThreadEvents(threadId, events) {
    const nextEvents = [...events];
    this.eventsByThread.set(threadId, nextEvents);
    if (threadId !== this.selectedThreadId) {
      return;
    }
    this.eventsThreadId = threadId;
    this.events = nextEvents;
  }

  async loadTaskList({ force = false } = {}) {
    if (this.taskListLoaded && !force) {
      return { tasks: this.tasks };
    }

    const requestId = ++this.taskListRequestId;
    const context = this.taskListContext;
    this.taskListLoading = true;
    this.taskListError = null;
    this.markTaskListDirty();
    this.renderTaskListRegion();

    try {
      const response = await getTasks(this.cwdPath);
      if (requestId !== this.taskListRequestId || context !== this.taskListContext) {
        return null;
      }
      this.tasks = response.tasks ?? [];
      this.initializeTaskSeenState(this.tasks);
      this.taskListLoading = false;
      this.taskListLoaded = true;
      this.markTaskListDirty();
      this.renderTaskListRegion();
      this.syncTaskListSelection();
      return response;
    } catch (error) {
      if (requestId !== this.taskListRequestId || context !== this.taskListContext) {
        return null;
      }
      this.taskListLoading = false;
      this.taskListError = error;
      this.markTaskListDirty();
      this.renderTaskListRegion();
      return null;
    }
  }

  connectStream(threadId) {
    this.closeStream();
    if (!("EventSource" in window)) {
      this.setStreamState("error");
      return;
    }

    const generation = this.streamGeneration;
    let stream;
    try {
      stream = new EventSource(taskStreamUrl(threadId, this.cwdPath));
    } catch {
      this.setStreamState("error");
      return;
    }

    this.stream = stream;
    this.streamState = "connecting";
    stream.addEventListener("open", () => {
      if (!this.isCurrentStream(stream, threadId, generation)) {
        return;
      }
      const shouldSync = this.streamState === "reconnecting";
      window.clearTimeout(this.streamErrorTimer);
      this.streamErrorTimer = null;
      this.setStreamState("connected");
      if (shouldSync) {
        this.requestSelectedTaskRefresh(threadId, generation);
      }
    });
    stream.addEventListener("error", () => {
      if (!this.isCurrentStream(stream, threadId, generation)) {
        return;
      }
      window.clearTimeout(this.streamErrorTimer);
      if (stream.readyState === 2) {
        this.streamErrorTimer = null;
        this.setStreamState("error");
        return;
      }
      this.setStreamState("reconnecting");
      this.streamErrorTimer = window.setTimeout(() => {
        if (
          this.isCurrentStream(stream, threadId, generation) &&
          this.streamState === "reconnecting"
        ) {
          this.streamErrorTimer = null;
          this.setStreamState("error");
        }
      }, STREAM_ERROR_DELAY_MS);
    });
    stream.addEventListener("task-sync", (event) => {
      const detail = parseJson(event.data);
      if (
        !this.isCurrentStream(stream, threadId, generation) ||
        detail?.task?.threadId !== threadId
      ) {
        return;
      }
      this.applyTaskDetailSync(threadId, detail);
    });
    stream.addEventListener("task-event", (event) => {
      const entry = parseJson(event.data);
      if (
        !this.isCurrentStream(stream, threadId, generation) ||
        !entry ||
        entry.threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.setThreadEvents(threadId, upsertEvent(this.events, entry));
      this.applyLiveTaskEvent(entry);
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    });
  }

  applyTaskDetailSync(threadId, detail) {
    if (threadId !== this.selectedThreadId) {
      return;
    }
    this.taskDetail = detail;
    this.setThreadEvents(
      threadId,
      mergeEvents(this.eventsByThread.get(threadId) ?? [], detail.events ?? []),
    );
    this.eventsPage = detail.eventsPage ?? this.eventsPage;
    this.patchTaskListTask(detail.task);
    this.loadTaskGithubStatus(detail.task);
    this.conversationScrollMode = "bottom-if-needed";
    this.render();
  }

  connectTaskListStream() {
    if (!("EventSource" in window)) {
      return;
    }
    const context = this.taskListContext;
    if (this.taskListStream && this.taskListStreamContext === context) {
      return;
    }
    this.closeTaskListStream();

    let stream;
    try {
      stream = new EventSource(taskListStreamUrl(this.cwdPath));
    } catch {
      return;
    }
    this.taskListStream = stream;
    this.taskListStreamContext = context;
    stream.addEventListener("open", () => {
      if (this.taskListStream !== stream || this.taskListStreamContext !== context) {
        return;
      }
      if (this.taskListStreamNeedsSync) {
        this.taskListStreamNeedsSync = false;
        this.loadTaskList({ force: true });
      }
    });
    stream.addEventListener("error", () => {
      if (this.taskListStream === stream) {
        this.taskListStreamNeedsSync = true;
      }
    });
    stream.addEventListener("task-event", (event) => {
      if (this.taskListStream !== stream || this.taskListStreamContext !== context) {
        return;
      }
      const entry = parseJson(event.data);
      const task = this.tasks.find(
        (candidate) => taskThreadId(candidate) === entry?.threadId,
      );
      const nextTask = taskWithLiveEventState(task, entry);
      if (nextTask && nextTask !== task) {
        this.patchTaskListTask(nextTask);
      }
    });
    stream.addEventListener("task-sync", (event) => {
      if (this.taskListStream !== stream || this.taskListStreamContext !== context) {
        return;
      }
      const detail = parseJson(event.data);
      if (detail?.task) {
        this.patchTaskListTask(detail.task);
      }
    });
  }

  closeTaskListStream() {
    this.taskListStream?.close();
    this.taskListStream = null;
    this.taskListStreamContext = "";
    this.taskListStreamNeedsSync = false;
  }

  applyLiveTaskEvent(event) {
    const task = this.taskDetail?.task;
    const nextTask = taskWithLiveEventState(task, event);
    if (!nextTask || nextTask === task) {
      return;
    }
    this.taskDetail = { ...this.taskDetail, task: nextTask };
    this.patchTaskListTask(nextTask);
  }

  closeStream() {
    this.streamGeneration += 1;
    window.clearTimeout(this.streamErrorTimer);
    this.streamErrorTimer = null;
    this.stream?.close();
    this.stream = null;
    this.streamState = "idle";
    this.taskRefresh = null;
  }

  isCurrentStream(stream, threadId, generation) {
    return (
      this.stream === stream &&
      this.streamGeneration === generation &&
      this.selectedThreadId === threadId
    );
  }

  setStreamState(state) {
    if (this.streamState === state) {
      return;
    }
    const wasVisible = isVisibleStreamState(this.streamState);
    this.streamState = state;
    if (this.view === "detail" && (wasVisible || isVisibleStreamState(state))) {
      this.render();
    }
  }

  handleVisibilityChange() {
    if (document.visibilityState !== "visible" || !this.selectedThreadId) {
      return;
    }
    this.requestSelectedTaskRefresh(
      this.selectedThreadId,
      this.streamGeneration,
    );
  }

  requestSelectedTaskRefresh(
    threadId = this.selectedThreadId,
    generation = this.streamGeneration,
  ) {
    if (!threadId || threadId !== this.selectedThreadId) {
      return Promise.resolve(null);
    }

    if (
      this.taskRefresh?.threadId === threadId &&
      this.taskRefresh?.generation === generation
    ) {
      this.taskRefresh.dirty = true;
      return this.taskRefresh.promise;
    }

    const refresh = {
      threadId,
      generation,
      dirty: false,
      promise: null,
    };
    refresh.promise = this.refreshSelectedTask(threadId, generation).finally(() => {
      if (this.taskRefresh !== refresh) {
        return;
      }
      const shouldRefreshAgain =
        refresh.dirty &&
        this.streamGeneration === generation &&
        this.selectedThreadId === threadId;
      this.taskRefresh = null;
      if (shouldRefreshAgain) {
        this.requestSelectedTaskRefresh(threadId, generation);
      }
    });
    this.taskRefresh = refresh;
    return refresh.promise;
  }

  async refreshSelectedTask(threadId, generation) {
    const requestId = this.requestId;
    try {
      const detail = await getTask(threadId, null, this.cwdPath);
      if (
        requestId !== this.requestId ||
        generation !== this.streamGeneration ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      if (detail?.task?.threadId !== threadId) {
        return;
      }
      this.taskDetail = detail;
      this.setThreadEvents(threadId, mergeEvents(this.events, detail.events ?? []));
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.patchTaskListTask(detail.task);
      this.loadTaskGithubStatus(detail.task);
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    } catch {
      // SSE already provided the timeline event. Keep the visible state stable.
    }
  }

  handleAction(action, element) {
    if (
      !action?.startsWith("select-") &&
      action !== "toggle-model-picker" &&
      action !== "close-model-picker"
    ) {
      this.closeModelPicker();
    }
    if (action === "open-list") {
      this.requestRoute({ kind: "tasks" });
      return;
    }
    if (action === "open-new") {
      this.requestRoute({ kind: "tasks", new: true });
      return;
    }
    if (action === "open-settings") {
      this.dispatchEvent(
        new CustomEvent("caffold:open-settings", {
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    if (action === "remove-composer-image") {
      this.removeComposerImage(
        element.dataset.formName,
        element.dataset.imageId,
        element.dataset.threadId,
      );
      return;
    }
    if (action === "open-git-tool" || action === "open-github-tool") {
      this.openTaskReviewRoute(action, element);
      return;
    }
    if (action === "open-task") {
      this.markTaskSeenByThreadId(element.dataset.threadId);
      this.requestRoute({ kind: "tasks", threadId: element.dataset.threadId });
      return;
    }
    if (action === "browse-new-task-cwd") {
      this.newTaskBrowsing = true;
      if (this.view !== "new") {
        this.requestRoute({ kind: "tasks", new: true });
      } else {
        this.render();
      }
      return;
    }
    if (action === "cancel-new-task-cwd") {
      this.newTaskBrowsing = false;
      this.render();
      return;
    }
    if (action === "choose-new-task-cwd") {
      const browser = this.querySelector(
        ".task-new-cwd-browser caffold-file-browser",
      );
      const cwd = cleanLogicalPath(browser?.currentPath ?? this.activeCwdPath());
      this.newTaskBrowsing = false;
      this.requestRoute(
        { kind: "tasks", new: true, cwd },
        { includeContext: false },
      );
      return;
    }
    if (action === "retry-stream") {
      if (this.selectedThreadId) {
        this.connectStream(this.selectedThreadId);
        this.render();
      }
      return;
    }
    if (action === "open-diff") {
      this.openTaskDiff();
      return;
    }
    if (action === "toggle-files") {
      this.setTaskDetailView(this.taskDetailView === "files" ? "conversation" : "files");
      return;
    }
    if (action === "refresh-diff") {
      this.requestTaskReviewRefresh();
      return;
    }
    if (action === "select-diff-mode") {
      this.setTaskDiffMode(element.dataset.diffMode);
      return;
    }
    if (action === "interrupt") {
      this.interruptSelectedTask();
      return;
    }
    if (action === "approval") {
      this.resolveApproval(element.dataset.approvalId, element.dataset.decision);
      return;
    }
    if (action === "toggle-model-picker") {
      this.toggleModelPicker(element.dataset.formName);
      return;
    }
    if (action === "close-model-picker") {
      this.closeModelPicker();
      return;
    }
    if (action === "select-model") {
      this.openModelPickerForm = "";
      this.selectModel(element.dataset.model);
      return;
    }
    if (action === "select-effort") {
      this.openModelPickerForm = "";
      this.selectEffort(element.dataset.effort);
    }
  }

  resetTaskGithubStatus() {
    this.taskGithubStatusRequestId += 1;
    this.taskGithubStatus = null;
    this.taskGithubStatusPath = "";
    this.taskGithubStatusState = "idle";
  }

  async loadTaskGithubStatus(task) {
    const rootPath = taskWorktreeRootPath(task);
    if (!rootPath) {
      this.resetTaskGithubStatus();
      this.patchTaskDetailSummary();
      return null;
    }
    if (
      this.taskGithubStatusPath === rootPath &&
      ["loading", "ready", "error"].includes(this.taskGithubStatusState)
    ) {
      return this.taskGithubStatus;
    }

    const requestId = ++this.taskGithubStatusRequestId;
    this.taskGithubStatusPath = rootPath;
    this.taskGithubStatusState = "loading";
    this.taskGithubStatus = null;
    this.patchTaskDetailSummary();
    try {
      const status = await getGitHubStatus(rootPath);
      if (
        requestId !== this.taskGithubStatusRequestId ||
        rootPath !== taskWorktreeRootPath(this.taskDetail?.task)
      ) {
        return null;
      }
      this.taskGithubStatus = status;
      this.taskGithubStatusState = "ready";
      this.patchTaskDetailSummary();
      return status;
    } catch (error) {
      if (
        requestId !== this.taskGithubStatusRequestId ||
        rootPath !== taskWorktreeRootPath(this.taskDetail?.task)
      ) {
        return null;
      }
      this.taskGithubStatus = { message: error.message };
      this.taskGithubStatusState = "error";
      this.patchTaskDetailSummary();
      return null;
    }
  }

  patchTaskDetailSummary() {
    const task = this.taskDetail?.task;
    if (!task) {
      return;
    }
    const current = this.querySelector(
      `.task-detail[data-thread-id="${CSS.escape(taskThreadId(task))}"] > .task-detail-summary`,
    );
    if (!current) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = this.renderTaskDetailSummary(task).trim();
    const next = template.content.firstElementChild;
    if (next) {
      current.replaceWith(next);
    }
  }

  taskGithubMenuState(rootPath) {
    if (
      this.taskGithubStatusPath !== rootPath ||
      ["idle", "loading"].includes(this.taskGithubStatusState)
    ) {
      return {
        enabled: false,
        loading: true,
        issues: false,
        pulls: false,
        message: "Checking GitHub availability",
      };
    }

    const status = this.taskGithubStatus;
    const issues = Boolean(status?.issuesAvailable);
    const pulls = Boolean(status?.pullsAvailable);
    return {
      enabled: Boolean(status?.github) && (issues || pulls),
      loading: false,
      issues,
      pulls,
      message:
        status?.message ||
        (status?.github
          ? "GitHub CLI authentication is required"
          : "No GitHub remote detected"),
    };
  }

  openTaskReviewRoute(action, element) {
    const task = this.taskDetail?.task;
    const cwd = taskWorktreeRootPath(task);
    const kind = element.dataset.reviewKind;
    if (!cwd || !kind) {
      return;
    }

    const returnRoute = {
      kind: "tasks",
      threadId: taskThreadId(task),
      cwd: cleanLogicalPath(this.cwdPath),
    };
    const options = {
      returnRoute,
      taskRelatedPaths: [task?.worktree?.rootPath, task?.cwdPath || task?.cwd].filter(Boolean),
    };
    const route =
      kind === "diff"
        ? { kind, cwd, path: "" }
        : kind === "compare"
          ? { kind, cwd, baseRef: "", headRef: "", path: "" }
          : kind === "log"
            ? { kind, cwd, page: 1, sha: "", path: "" }
            : kind === "issues"
              ? { kind, cwd, page: 1, number: null }
              : { kind: "pulls", cwd, page: 1, number: null, files: false, path: "" };
    const eventName =
      action === "open-git-tool"
        ? "caffold:request-git-route"
        : "caffold:request-github-route";
    element.closest("details")?.removeAttribute("open");
    this.dispatchEvent(
      new CustomEvent(eventName, {
        bubbles: true,
        composed: true,
        detail: { route, options },
      }),
    );
  }

  async handleForm(formName, form) {
    if (formName === "create") {
      await this.createTaskFromForm(form);
      return;
    }
    if (formName === "follow-up") {
      await this.sendFollowUpFromForm(form);
    }
  }

  handlePromptKeydown(event) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }
    if (event.isComposing) {
      return;
    }

    const textarea = closestElement(event.target, "textarea[name='prompt']");
    const form = closestElement(textarea, "form[data-task-form]");
    if (
      !textarea ||
      !form ||
      (!textarea.value.trim() && !this.composerImages(form.dataset.taskForm).length)
    ) {
      return;
    }

    event.preventDefault();
    form.requestSubmit();
  }

  async createTaskFromForm(form) {
    this.captureDraft(form);
    const formData = new FormData(form);
    const prompt = `${formData.get("prompt") ?? ""}`.trim();
    const images = [...this.newTaskImages];
    if (!prompt && !images.length) {
      return;
    }

    this.loading = true;
    this.error = null;
    this.render();

    try {
      const detail = await createTask({
        ...(this.activeCwdPath() ? { cwd: this.activeCwdPath() } : {}),
        prompt,
        images: images.map((image) => image.dataUrl),
        ...this.turnOptions(),
      });
      this.taskDetail = detail;
      this.setThreadEvents(detail.task.threadId, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.tasks = upsertTask(this.tasks, detail.task);
      this.newTaskDraft = { prompt: "" };
      this.newTaskImages = [];
      this.composerImageErrors.delete("create");
      this.conversationScrollMode = "bottom";
      this.requestRoute({ kind: "tasks", threadId: detail.task.threadId });
    } catch (error) {
      this.loading = false;
      this.error = error;
      this.render();
    }
  }

  async sendFollowUpFromForm(form) {
    const threadId = `${form?.dataset?.threadId ?? ""}`.trim();
    if (!threadId) {
      this.error = new Error("Could not identify the task for this prompt.");
      this.render();
      return;
    }
    if (this.followUpRequest?.threadId === threadId) {
      return;
    }

    if (this.selectedThreadId !== threadId) {
      this.selectedThreadId = threadId;
      this.activateThreadEvents(threadId);
    }
    this.captureDraft(form, threadId);
    const formData = new FormData(form);
    const prompt = `${formData.get("prompt") ?? ""}`.trim();
    const images = [...this.followUpImages];
    if (!prompt && !images.length) {
      return;
    }

    const requestId = ++this.requestId;
    const followUpRequest = { requestId, threadId };
    this.followUpRequest = followUpRequest;
    form.prompt.value = "";
    const optimisticEvent = optimisticUserMessageEvent(
      threadId,
      prompt,
      images,
      requestId,
    );
    const previousTask =
      taskThreadId(this.taskDetail?.task) === threadId
        ? this.taskDetail.task
        : this.tasks.find((task) => taskThreadId(task) === threadId) ?? null;
    const runningTask = taskWithStatus(previousTask, "running", {
      updatedMs: optimisticEvent.createdMs,
      recencyMs: optimisticEvent.createdMs,
    });
    this.setThreadEvents(
      threadId,
      mergeEvents(this.eventsByThread.get(threadId) ?? [], [optimisticEvent]),
    );
    if (runningTask) {
      this.taskDetail = { ...this.taskDetail, task: runningTask };
      this.patchTaskListTask(runningTask);
    }
    this.followUpDraft = "";
    this.followUpDraftByThread.set(threadId, "");
    this.followUpImages = [];
    this.followUpImagesByThread.set(threadId, []);
    this.composerImageErrors.delete("follow-up");
    this.conversationScrollMode = "bottom";
    this.render();

    try {
      const response = await sendTaskPrompt(
        threadId,
        prompt,
        {
          ...this.turnOptions(),
          activeTurnId:
            previousTask?.status === "running"
              ? previousTask.activeTurnId ?? null
              : null,
        },
        previousTask?.cwdPath || this.cwdPath,
        images.map((image) => image.dataUrl),
      );
      if (response?.threadId !== threadId) {
        throw new Error("Codex accepted the prompt for a different task.");
      }
      if (threadId === this.selectedThreadId) {
        this.conversationScrollMode = "bottom-if-needed";
      }
    } catch (error) {
      const threadEvents = this.eventsByThread.get(threadId) ?? [];
      this.setThreadEvents(
        threadId,
        threadEvents.filter((event) => event.id !== optimisticEvent.id),
      );
      if (previousTask && threadId === this.selectedThreadId) {
        this.taskDetail = { ...this.taskDetail, task: previousTask };
        this.patchTaskListTask(previousTask);
      }
      if (
        threadId === this.selectedThreadId &&
        !this.followUpDraft
      ) {
        this.followUpDraft = prompt;
        this.followUpDraftByThread.set(threadId, prompt);
      }
      if (
        threadId === this.selectedThreadId &&
        !this.followUpImages.length
      ) {
        this.followUpImages = images;
        this.followUpImagesByThread.set(threadId, images);
      }
      if (threadId === this.selectedThreadId) {
        this.error = error;
        this.conversationScrollMode = "preserve";
      }
    } finally {
      if (this.followUpRequest === followUpRequest) {
        this.followUpRequest = null;
      }
      if (threadId === this.selectedThreadId) {
        this.render();
      }
    }
  }

  async interruptSelectedTask() {
    if (!this.selectedThreadId) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await interruptTask(this.selectedThreadId, this.cwdPath);
      if (requestId !== this.requestId) {
        return;
      }
      this.taskDetail = detail;
      this.setThreadEvents(
        this.selectedThreadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.patchTaskListTask(detail.task);
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = error;
      this.render();
    }
  }

  async resolveApproval(approvalId, decision) {
    if (!this.selectedThreadId || !approvalId || !decision) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await resolveTaskApproval(
        this.selectedThreadId,
        approvalId,
        decision,
        this.cwdPath,
      );
      if (requestId !== this.requestId) {
        return;
      }
      this.taskDetail = detail;
      this.setThreadEvents(
        this.selectedThreadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.patchTaskListTask(detail.task);
      this.conversationScrollMode = "bottom-if-needed";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.error = error;
      this.render();
    }
  }

  async loadOlderEvents() {
    const cursor = this.eventsPage?.nextCursor;
    if (!this.selectedThreadId || !cursor || this.loadingOlderEvents) {
      return;
    }

    this.loadingOlderEvents = true;
    this.conversationScrollMode = "preserve";
    const requestId = ++this.requestId;
    this.render();
    try {
      const detail = await getTask(this.selectedThreadId, cursor, this.cwdPath);
      if (requestId !== this.requestId) {
        return;
      }
      if (detail?.task?.threadId !== this.selectedThreadId) {
        this.loadingOlderEvents = false;
        this.conversationScrollMode = "preserve";
        this.render();
        return;
      }
      this.taskDetail = {
        ...detail,
        task: this.taskDetail?.task ?? detail.task,
      };
      this.setThreadEvents(
        this.selectedThreadId,
        mergeEvents(detail.events ?? [], this.events),
      );
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.loadingOlderEvents = false;
      this.conversationScrollMode = "prepend";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.loadingOlderEvents = false;
      this.error = error;
      this.conversationScrollMode = "preserve";
      this.render();
    }
  }

  requestRoute(route, options = {}) {
    const includeContext = options.includeContext ?? true;
    const context = includeContext && this.cwdPath ? { cwd: this.cwdPath } : {};
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: {
            ...context,
            ...route,
          },
        },
      }),
    );
  }

  openTaskDiff() {
    if (!this.taskDetail?.task?.worktree) {
      return;
    }
    this.setTaskDetailView(this.taskDetailView === "diff" ? "conversation" : "diff");
  }

  async loadModelOptions() {
    if (this.modelOptionsLoaded || this.modelOptionsLoading) {
      return;
    }

    this.modelOptionsLoading = true;
    this.modelOptionsError = null;
    this.render();
    try {
      const response = await getCodexModels();
      this.modelOptions = normalizeModelOptions(response);
      this.modelOptionsLoaded = true;
      this.applyDefaultModelSelection();
    } catch (error) {
      this.modelOptionsError = error;
      this.modelOptionsLoaded = true;
    } finally {
      this.modelOptionsLoading = false;
      this.render();
    }
  }

  applyDefaultModelSelection() {
    if (!this.modelOptions.length) {
      return;
    }
    const selected = this.selectedModelOption();
    const model = selected ?? this.modelOptions.find((option) => option.isDefault) ?? this.modelOptions[0];
    if (!this.composerSettings.model) {
      this.composerSettings.model = model.model;
    }
    if (!this.composerSettings.effort) {
      this.composerSettings.effort =
        model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.value || "";
    }
  }

  selectModel(modelValue) {
    this.composerSettings.model = `${modelValue ?? ""}`;
    const model = this.selectedModelOption();
    const supported = this.reasoningOptionsForModel(model).map((option) => option.value);
    if (this.composerSettings.effort && !supported.includes(this.composerSettings.effort)) {
      this.composerSettings.effort =
        model?.defaultReasoningEffort ?? supported[0] ?? FALLBACK_EFFORT;
    }
    this.render();
  }

  selectEffort(effort) {
    this.composerSettings.effort = `${effort ?? ""}`;
    this.render();
  }

  toggleModelPicker(formName) {
    const nextFormName = `${formName ?? ""}`;
    this.openModelPickerForm = this.openModelPickerForm === nextFormName ? "" : nextFormName;
    if (this.openModelPickerForm) {
      this.loadModelOptions();
    }
    this.render();
  }

  closeModelPicker() {
    if (!this.openModelPickerForm) {
      return;
    }
    this.openModelPickerForm = "";
    this.render();
  }

  selectedModelOption() {
    return this.modelOptions.find((option) => option.model === this.composerSettings.model) ?? null;
  }

  selectedEffort() {
    return this.composerSettings.effort || this.selectedModelOption()?.defaultReasoningEffort || "";
  }

  turnOptions() {
    return {
      model: this.composerSettings.model || undefined,
      effort: this.selectedEffort() || undefined,
    };
  }

  reasoningOptionsForModel(model) {
    return model?.supportedReasoningEfforts?.length
      ? model.supportedReasoningEfforts
      : FALLBACK_REASONING_OPTIONS;
  }

  captureDraft(form, threadId = form?.dataset?.threadId) {
    const formData = new FormData(form);
    if (form.dataset.taskForm === "create") {
      this.newTaskDraft = {
        prompt: `${formData.get("prompt") ?? ""}`,
      };
      return;
    }
    if (form.dataset.taskForm === "follow-up") {
      this.followUpDraft = `${formData.get("prompt") ?? ""}`;
      const targetThreadId = `${threadId ?? this.selectedThreadId ?? ""}`.trim();
      if (targetThreadId) {
        this.followUpDraftByThread.set(targetThreadId, this.followUpDraft);
      }
    }
  }

  composerImages(formName) {
    return formName === "create" ? this.newTaskImages : this.followUpImages;
  }

  setComposerImages(formName, images, threadId = this.selectedThreadId) {
    if (formName === "create") {
      this.newTaskImages = images;
      return;
    }
    this.followUpImages = images;
    if (threadId) {
      this.followUpImagesByThread.set(threadId, images);
    }
  }

  async handleComposerPaste(event) {
    const textarea = closestElement(event.target, "textarea[name='prompt']");
    const form = closestElement(textarea, "form[data-task-form]");
    if (!textarea || !form) {
      return;
    }
    const imageFiles = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!imageFiles.length) {
      return;
    }

    event.preventDefault();
    this.captureDraft(form);
    const formName = form.dataset.taskForm;
    const threadId = form.dataset.threadId;
    const existing = this.composerImages(formName);
    const availableSlots = TASK_COMPOSER_MAX_IMAGES - existing.length;
    if (availableSlots <= 0) {
      this.composerImageErrors.set(
        formName,
        `Attach up to ${TASK_COMPOSER_MAX_IMAGES} images.`,
      );
      this.render();
      return;
    }

    const accepted = [];
    let error = imageFiles.length > availableSlots
      ? `Attach up to ${TASK_COMPOSER_MAX_IMAGES} images.`
      : "";
    for (const [index, file] of imageFiles.slice(0, availableSlots).entries()) {
      if (!TASK_COMPOSER_IMAGE_TYPES.has(file.type)) {
        error = "Use PNG, JPEG, GIF, WebP, or AVIF images.";
        continue;
      }
      if (file.size > TASK_COMPOSER_MAX_IMAGE_BYTES) {
        error = "Each image must be 10 MB or smaller.";
        continue;
      }
      let dataUrl;
      try {
        dataUrl = await readFileAsDataUrl(file);
      } catch {
        error = "Could not read the pasted image.";
        continue;
      }
      accepted.push({
        id: `clipboard:${Date.now()}:${index}:${Math.random().toString(36).slice(2)}`,
        name: file.name || `clipboard-image-${existing.length + accepted.length + 1}.${imageExtension(file.type)}`,
        type: file.type,
        size: file.size,
        dataUrl,
      });
    }

    this.setComposerImages(formName, [...existing, ...accepted], threadId);
    if (error) {
      this.composerImageErrors.set(formName, error);
    } else {
      this.composerImageErrors.delete(formName);
    }
    this.render();
  }

  removeComposerImage(formName, imageId, threadId = this.selectedThreadId) {
    if (!formName || !imageId) {
      return;
    }
    this.setComposerImages(
      formName,
      this.composerImages(formName).filter((image) => image.id !== imageId),
      threadId,
    );
    this.composerImageErrors.delete(formName);
    this.render();
  }

  render() {
    const previousScroll =
      this.rememberConversationScroll() ?? this.conversationScrollSnapshot();
    const previousComposerFocus = this.captureComposerFocus();
    const previousTaskFilePath = this.captureTaskFileBrowserPath();
    const previousNewTaskCwdPath = this.captureNewTaskCwdBrowserPath();
    const previousTaskDiffPath = this.captureTaskDiffPath();
    const previousTaskCompareState = this.captureTaskCompareState();
    this.setAttribute("data-tasks-view", this.view ?? "list");
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.ensureTaskShell();
    this.renderHeaderRegion();
    this.renderTaskListRegion();
    this.renderTaskContentRegion();
    this.syncComposerTextareas();
    this.restoreComposerFocus(previousComposerFocus);
    this.bindConversationScroll();
    this.restoreConversationScroll(previousScroll);
    this.updateTaskDetailView();
    this.syncTaskFileBrowser(previousTaskFilePath);
    this.syncNewTaskCwdBrowser(previousNewTaskCwdPath);
    this.syncTaskDiffBrowser(previousTaskDiffPath);
    this.syncTaskCompareBrowser(previousTaskCompareState);
    this.applyTaskListWidth();
    this.syncTaskListSelection();
    this.syncActiveTurnClock();
  }

  ensureTaskShell() {
    if (this.querySelector(":scope > .tasks-surface")) {
      return;
    }

    this.innerHTML = `
      <section class="tasks-surface" aria-label="Tasks">
        <div class="tasks-header-region"></div>
        <div class="tasks-master-detail">
          <aside class="tasks-list-pane" aria-label="Tasks list">
            <div class="tasks-list-region"></div>
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
            <div class="tasks-detail-region"></div>
          </main>
        </div>
      </section>
    `;
  }

  renderHeaderRegion() {
    const region = this.querySelector(".tasks-header-region");
    if (!region) {
      return;
    }
    const key = [
      this.view,
      this.cwdPath,
      this.taskDetailView,
    ].join("\u0000");
    if (region.dataset.renderKey === key) {
      return;
    }
    region.dataset.renderKey = key;
    region.innerHTML = this.renderHeader();
  }

  markTaskListDirty() {
    this.taskListDirty = true;
  }

  renderTaskListRegion() {
    const region = this.querySelector(".tasks-list-region");
    if (!region || !this.taskListDirty) {
      return;
    }
    const scrollTop = region.querySelector(".task-list-scroll")?.scrollTop ?? 0;
    region.innerHTML = this.renderTaskList();
    const scroller = region.querySelector(".task-list-scroll");
    if (scroller) {
      scroller.scrollTop = scrollTop;
    }
    this.taskListDirty = false;
  }

  renderTaskContentRegion() {
    const region = this.querySelector(".tasks-detail-region");
    if (!region) {
      return;
    }

    const currentDetail = region.querySelector(":scope > .task-detail");
    const threadId = this.taskDetail?.task?.threadId ?? this.taskDetail?.task?.id ?? "";
    if (
      this.view === "detail" &&
      currentDetail?.dataset.threadId === threadId &&
      threadId
    ) {
      const template = document.createElement("template");
      template.innerHTML = this.renderTaskDetail().trim();
      const nextDetail = template.content.firstElementChild;
      const nextSummary = nextDetail?.querySelector(":scope > .task-detail-summary");
      const nextConversation = nextDetail?.querySelector(":scope > .task-conversation-pane");
      const currentSummary = currentDetail.querySelector(":scope > .task-detail-summary");
      const currentConversation = currentDetail.querySelector(
        ":scope > .task-conversation-pane",
      );
      if (nextSummary && currentSummary) {
        currentSummary.replaceWith(nextSummary);
      }
      if (nextConversation && currentConversation) {
        currentConversation.replaceChildren(...nextConversation.childNodes);
      }
      currentDetail.dataset.taskDetailView = this.taskDetailView;
      return;
    }

    region.innerHTML = this.renderBody();
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
    window.addEventListener("pointermove", this.boundTaskListPointerMove);
    window.addEventListener("pointerup", this.boundTaskListPointerUp, { once: true });
    window.addEventListener("pointercancel", this.boundTaskListPointerUp, { once: true });
  }

  resizeTaskList(event) {
    if (!this.taskListResizeStart) {
      return;
    }
    const width =
      this.taskListResizeStart.width + event.clientX - this.taskListResizeStart.pointerX;
    this.setTaskListWidth(width);
  }

  stopTaskListResize() {
    this.taskListResizeStart = null;
    this.classList.remove("is-resizing-task-list");
    window.removeEventListener("pointermove", this.boundTaskListPointerMove);
    window.removeEventListener("pointerup", this.boundTaskListPointerUp);
    window.removeEventListener("pointercancel", this.boundTaskListPointerUp);
  }

  handleTaskListResizeKeydown(event) {
    const separator = closestElement(event.target, ".tasks-master-resizer");
    if (!separator || !window.matchMedia("(min-width: 960px)").matches) {
      return false;
    }
    let width = this.taskListWidth;
    if (event.key === "ArrowLeft") {
      width -= event.shiftKey ? 48 : 16;
    } else if (event.key === "ArrowRight") {
      width += event.shiftKey ? 48 : 16;
    } else if (event.key === "Home") {
      width = TASK_LIST_MIN_WIDTH;
    } else if (event.key === "End") {
      width = this.taskListMaximumWidth();
    } else {
      return false;
    }
    event.preventDefault();
    this.setTaskListWidth(width);
    return true;
  }

  taskListMaximumWidth() {
    const shellWidth = this.querySelector(".tasks-master-detail")?.clientWidth ?? 0;
    const available = shellWidth - TASK_LIST_RESIZER_WIDTH - TASK_DETAIL_MIN_WIDTH;
    return Math.max(TASK_LIST_MIN_WIDTH, Math.min(TASK_LIST_MAX_WIDTH, available));
  }

  setTaskListWidth(width) {
    const maximum = this.taskListMaximumWidth();
    this.taskListWidth = Math.max(TASK_LIST_MIN_WIDTH, Math.min(maximum, width));
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
    separator.setAttribute("aria-valuemax", `${this.taskListMaximumWidth()}`);
    separator.setAttribute("aria-valuenow", `${Math.round(this.taskListWidth)}`);
  }

  captureComposerFocus() {
    const textarea = closestElement(document.activeElement, "textarea[name='prompt']");
    if (!textarea || !this.contains(textarea)) {
      return null;
    }

    const form = closestElement(textarea, "form[data-task-form]");
    if (!form) {
      return null;
    }

    return {
      formName: form.dataset.taskForm,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  }

  restoreComposerFocus(previousFocus) {
    if (!previousFocus?.formName) {
      return;
    }

    const textarea = this.querySelector(
      `form[data-task-form="${CSS.escape(previousFocus.formName)}"] textarea[name="prompt"]`,
    );
    if (!textarea) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const textLength = textarea.value.length;
    const selectionStart = Math.min(previousFocus.selectionStart ?? textLength, textLength);
    const selectionEnd = Math.min(previousFocus.selectionEnd ?? selectionStart, textLength);
    textarea.setSelectionRange(selectionStart, selectionEnd);
  }

  setTaskDetailView(view) {
    const nextView = view === "files" || view === "diff" ? view : "conversation";
    if (this.taskDetailView === nextView) {
      return;
    }

    if (nextView !== "conversation") {
      this.rememberConversationScroll();
    }
    this.taskDetailView = nextView;
    this.updateTaskDetailView();
    this.syncTaskFileBrowser();
    this.syncTaskDiffBrowser();
    this.syncTaskCompareBrowser();
    if (nextView === "conversation") {
      window.requestAnimationFrame(() => {
        this.restoreConversationScroll(this.conversationScrollSnapshot());
      });
    }
    this.dispatchTaskDetailViewChange();
  }

  closeActiveSubview() {
    if (this.taskDetailView === "conversation") {
      return false;
    }

    this.setTaskDetailView("conversation");
    return true;
  }

  updateTaskDetailView() {
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    const detail = this.querySelector(".task-detail");
    if (!detail) {
      return;
    }

    detail.dataset.taskDetailView = this.taskDetailView;
    const filesButton = detail.querySelector('button[data-task-action="toggle-files"]');
    if (filesButton) {
      filesButton.setAttribute(
        "aria-pressed",
        this.taskDetailView === "files" ? "true" : "false",
      );
    }
    const diffButton = detail.querySelector('button[data-task-action="open-diff"]');
    if (diffButton) {
      diffButton.setAttribute(
        "aria-pressed",
        this.taskDetailView === "diff" ? "true" : "false",
      );
    }
    this.patchTaskDiffHeader();
  }

  setTaskDiffMode(mode) {
    const nextMode = mode === "branch" ? "branch" : "working";
    if (this.taskDiffMode === nextMode) {
      return;
    }

    this.taskDiffMode = nextMode;
    this.patchTaskDiffHeader();
    if (nextMode === "branch") {
      this.syncTaskCompareBrowser();
    } else {
      this.syncTaskDiffBrowser();
    }
  }

  dispatchTaskDetailViewChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-view-change", {
        bubbles: true,
        detail: { view: this.taskDetailView },
      }),
    );
  }

  captureTaskFileBrowserPath() {
    const browser = this.querySelector(".task-files-view caffold-file-browser");
    return browser?.currentPath ?? "";
  }

  captureNewTaskCwdBrowserPath() {
    const browser = this.querySelector(
      ".task-new-cwd-browser caffold-file-browser",
    );
    return browser?.currentPath ?? "";
  }

  syncNewTaskCwdBrowser(previousPath = "") {
    if (this.view !== "new" || !this.newTaskBrowsing) {
      return;
    }

    const browser = this.querySelector(
      ".task-new-cwd-browser caffold-file-browser",
    );
    const targetPath = previousPath || this.activeCwdPath();
    if (!browser) {
      return;
    }

    browser.ensureRendered();
    browser.setStorageKey(null);
    if (!browser.hasLoadedDirectory(targetPath)) {
      browser.loadDirectory(targetPath, { allowFailure: true });
    }
  }

  activeCwdPath() {
    return cleanLogicalPath(this.cwdPath || this.defaultCwdPath || ".");
  }

  selectedTaskContextPath() {
    return cleanLogicalPath(
      this.taskDetail?.task?.worktree?.rootPath || this.taskDetail?.task?.cwdPath || "",
    );
  }

  syncTaskFileBrowser(previousPath = "") {
    if (this.taskDetailView !== "files") {
      return;
    }

    const browser = this.querySelector(".task-files-view caffold-file-browser");
    const targetPath = previousPath || this.taskFilesRootPath();
    if (!browser) {
      return;
    }

    browser.ensureRendered();
    browser.setStorageKey(null);
    if (!browser.hasLoadedDirectory(targetPath)) {
      browser.loadDirectory(targetPath, { allowFailure: true });
    }
  }

  taskFilesRootPath() {
    return (
      this.taskDetail?.task?.worktree?.rootPath ||
      this.taskDetail?.task?.cwdPath ||
      this.cwdPath ||
      ""
    );
  }

  captureTaskDiffPath() {
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-git-diff-browser',
    );
    return browser?.changesTree?.selectedPath ?? "";
  }

  captureTaskCompareState() {
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
    );
    return browser?.stateSnapshot() ?? null;
  }

  syncTaskDiffBrowser(previousPath = "") {
    if (this.taskDetailView !== "diff") {
      this.unsubscribeTaskDiffWatch();
      return;
    }

    const rootPath = this.taskDetail?.task?.worktree?.rootPath ?? "";
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="working"] caffold-git-diff-browser',
    );
    if (!rootPath || !browser) {
      this.unsubscribeTaskDiffWatch();
      return;
    }

    browser.ensureRendered();
    browser.setContext({ path: rootPath, repository: this.taskDiffStatus?.repository });
    browser.setTaskRelatedPaths(latestTaskRelatedWorktreePaths(this.events, this.taskDetail?.task));
    if (this.taskDiffStatus?.repository?.rootPath === rootPath) {
      browser.setStatus(this.taskDiffStatus, { preserveState: true });
      if (previousPath) {
        browser.setSelectedPath(previousPath);
      }
    } else if (this.taskDiffError) {
      browser.setError(this.taskDiffError);
    } else {
      browser.setLoading({
        rootPath,
        branch: this.taskDetail?.task?.worktree?.branch ?? null,
        dirty: false,
      });
      this.requestTaskDiffRefresh();
    }
    browser.viewer.setRefreshState(
      this.taskDiffWatchUnavailable
        ? "unavailable"
        : this.taskDiffRefreshState === "refreshing"
          ? "refreshing"
          : "idle",
    );
    this.subscribeTaskDiffWatch(rootPath);
  }

  syncTaskCompareBrowser(previousState = null) {
    if (this.taskDetailView !== "diff" || this.taskDiffMode !== "branch") {
      return;
    }

    const task = this.taskDetail?.task;
    const rootPath = task?.worktree?.rootPath ?? "";
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
    );
    if (!rootPath || !browser) {
      return;
    }

    browser.ensureRendered();
    if (previousState?.currentPath === rootPath) {
      browser.restoreState(previousState);
      return;
    }

    const headRef = this.taskCompareHeadRef();
    const repository = this.taskDiffStatus?.repository ?? {
      rootPath,
      branch: task.worktree.branch ?? null,
    };
    browser.openCompare({
      path: rootPath,
      repository,
      headRef,
      preserveViewer: false,
    });
  }

  taskCompareHeadRef() {
    return this.taskDetail?.task?.worktree?.branch || "HEAD";
  }

  async changeTaskCompareBase(baseRef) {
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
    );
    if (!browser || !baseRef) {
      return;
    }
    await browser.changeRefs(baseRef, this.taskCompareHeadRef());
  }

  requestTaskDiffRefresh() {
    return this.taskDiffRefreshCoordinator.request();
  }

  requestTaskReviewRefresh() {
    return this.taskDiffMode === "branch"
      ? this.taskCompareRefreshCoordinator.request()
      : this.requestTaskDiffRefresh();
  }

  async refreshTaskDiff() {
    const rootPath = this.taskDetail?.task?.worktree?.rootPath ?? "";
    if (!rootPath || this.taskDetailView !== "diff") {
      return null;
    }

    const requestId = ++this.taskDiffRequestId;
    try {
      const status = await getGitStatus(rootPath);
      if (
        requestId !== this.taskDiffRequestId ||
        rootPath !== this.taskDetail?.task?.worktree?.rootPath
      ) {
        return null;
      }

      this.taskDiffStatus = status;
      this.taskDiffError = null;
      const browser = this.querySelector(
        '.task-diff-panel[data-task-diff-panel="working"] caffold-git-diff-browser',
      );
      if (browser) {
        browser.setContext({ path: rootPath, repository: status.repository });
        browser.setStatus(status, { preserveState: true });
        browser.setTaskRelatedPaths(
          latestTaskRelatedWorktreePaths(this.events, this.taskDetail?.task),
        );
        await browser.refreshSelectedDiff(status);
      }
      if (this.taskDiffMode === "branch") {
        this.syncTaskCompareBrowser();
      }
      return status;
    } catch (error) {
      if (requestId !== this.taskDiffRequestId) {
        return null;
      }
      this.taskDiffError = error;
      this.querySelector(
        '.task-diff-panel[data-task-diff-panel="working"] caffold-git-diff-browser',
      )?.setError(error);
      throw error;
    }
  }

  async refreshTaskCompare() {
    if (this.taskDetailView !== "diff" || this.taskDiffMode !== "branch") {
      return null;
    }
    const browser = this.querySelector(
      '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
    );
    if (!browser) {
      return null;
    }
    if (!browser.refsPayload) {
      this.syncTaskCompareBrowser();
      return null;
    }
    return await browser.refresh();
  }

  subscribeTaskDiffWatch(rootPath) {
    if (this.taskDiffWatchPath === rootPath && this.taskDiffWatchUnsubscribe) {
      return;
    }
    this.unsubscribeTaskDiffWatch();
    this.taskDiffWatchPath = rootPath;
    this.taskDiffWatchUnsubscribe = subscribeToWatch(rootPath, {
      onReady: ({ recovered }) => {
        this.taskDiffWatchUnavailable = false;
        this.patchTaskDiffRefreshState();
        if (recovered) {
          this.requestTaskDiffRefresh();
        }
      },
      onChange: (change) => {
        if (change.gitStatusChanged || change.overflow) {
          this.requestTaskDiffRefresh();
        }
        if ((change.gitRefsChanged || change.overflow) && this.taskDiffMode === "branch") {
          this.taskCompareRefreshCoordinator.request();
        }
      },
      onError: () => {
        this.taskDiffWatchUnavailable = true;
        this.patchTaskDiffRefreshState();
      },
    });
  }

  unsubscribeTaskDiffWatch() {
    this.taskDiffWatchUnsubscribe?.();
    this.taskDiffWatchUnsubscribe = null;
    this.taskDiffWatchPath = "";
    this.taskDiffWatchUnavailable = false;
  }

  setTaskDiffRefreshState(state) {
    this.taskDiffRefreshState = state;
    this.patchTaskDiffRefreshState();
  }

  patchTaskDiffRefreshState() {
    const panel = this.taskDiffMode === "branch" ? "branch" : "working";
    const viewer = this.querySelector(
      `.task-diff-panel[data-task-diff-panel="${panel}"] caffold-review-file-viewer`,
    );
    viewer?.setRefreshState(
      this.taskDiffWatchUnavailable
        ? "unavailable"
        : this.taskDiffRefreshState === "refreshing"
          ? "refreshing"
          : "idle",
    );
    const button = this.querySelector('.task-diff-header [data-task-action="refresh-diff"]');
    if (button) {
      button.classList.toggle("is-refreshing", this.taskDiffRefreshState === "refreshing");
      button.classList.toggle("is-unavailable", this.taskDiffWatchUnavailable);
      const label = this.taskDiffWatchUnavailable
        ? "Live updates unavailable. Refresh manually."
        : this.taskReviewRefreshLabel();
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }

  patchTaskDiffHeader() {
    const view = this.querySelector(".task-diff-view");
    if (!view) {
      return;
    }
    view.dataset.taskDiffMode = this.taskDiffMode;
    for (const button of view.querySelectorAll("button[data-diff-mode]")) {
      button.setAttribute(
        "aria-pressed",
        button.dataset.diffMode === this.taskDiffMode ? "true" : "false",
      );
    }
    const subtitle = view.querySelector(".task-diff-subtitle");
    if (subtitle) {
      subtitle.textContent = this.taskDiffSubtitle();
    }
    const compareBrowser = view.querySelector("caffold-git-compare-browser");
    const baseSelect = view.querySelector("select[data-task-compare-base]");
    if (baseSelect) {
      const refs = compareBrowser?.refsPayload?.refs ?? [];
      baseSelect.innerHTML = refs.length
        ? renderTaskCompareRefOptions(refs, compareBrowser.baseRef)
        : `<option value="">Loading refs...</option>`;
      baseSelect.disabled = refs.length === 0;
      if (compareBrowser?.baseRef) {
        baseSelect.value = compareBrowser.baseRef;
      }
    }
    const head = view.querySelector("[data-task-compare-head]");
    if (head) {
      head.textContent = this.taskCompareHeadRef();
      head.title = this.taskCompareHeadRef();
    }
    this.patchTaskDiffRefreshState();
  }

  taskDiffSubtitle() {
    if (this.taskDiffMode === "branch") {
      const browser = this.querySelector(
        '.task-diff-panel[data-task-diff-panel="branch"] caffold-git-compare-browser',
      );
      const compare = browser?.compare;
      if (!compare) {
        return `${this.taskCompareHeadRef()} · Loading comparison`;
      }
      const count = compare.files?.length ?? 0;
      return `${compare.baseRef}...${compare.headRef} · ${count} ${count === 1 ? "file" : "files"} · +${compare.additions} -${compare.deletions}`;
    }

    const task = this.taskDetail?.task;
    const status = this.taskDiffStatus;
    const count = status?.files?.length ?? 0;
    const stats = status
      ? `${count} ${count === 1 ? "file" : "files"} · +${status.additions} -${status.deletions}`
      : "Loading changes";
    return `${taskWorktreeRef(task)} · ${stats}`;
  }

  taskReviewRefreshLabel() {
    return this.taskDiffMode === "branch"
      ? "Refresh branch comparison"
      : "Refresh task diff";
  }

  syncComposerTextareas() {
    this.querySelectorAll("textarea[name='prompt']").forEach((textarea) =>
      syncComposerTextarea(textarea),
    );
  }

  bindConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    scroller?.addEventListener("scroll", () => this.handleConversationScroll());
  }

  captureConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller || scroller.clientHeight === 0) {
      return null;
    }
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: isScrolledToBottom(scroller),
    };
  }

  rememberConversationScroll() {
    const snapshot = this.captureConversationScroll();
    if (snapshot && this.selectedThreadId) {
      this.conversationScrollByThread.set(this.selectedThreadId, snapshot);
    }
    return snapshot;
  }

  conversationScrollSnapshot() {
    if (!this.selectedThreadId) {
      return null;
    }
    return this.conversationScrollByThread.get(this.selectedThreadId) ?? null;
  }

  restoreConversationScroll(previousScroll) {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller) {
      this.conversationScrollMode = null;
      return;
    }

    const mode = this.conversationScrollMode;
    this.conversationScrollMode = null;
    const shouldStickToBottom =
      mode === "bottom" ||
      (mode === "bottom-if-needed" && previousScroll?.atBottom) ||
      (!mode && previousScroll?.atBottom);
    if (shouldStickToBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
      return;
    }
    if (mode === "prepend" && previousScroll) {
      scroller.scrollTop = Math.min(
        previousScroll.scrollTop + (scroller.scrollHeight - previousScroll.scrollHeight),
        maxScrollTop(scroller),
      );
      return;
    }
    if (previousScroll) {
      scroller.scrollTop = Math.min(previousScroll.scrollTop, maxScrollTop(scroller));
    }
  }

  handleConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    this.rememberConversationScroll();
    if (
      !scroller ||
      this.loadingOlderEvents ||
      !this.eventsPage?.nextCursor ||
      scroller.scrollTop > 32
    ) {
      return;
    }
    this.loadOlderEvents();
  }

  handleTaskMarkdownRendered(event) {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller || !event.detail) {
      return;
    }

    if (event.detail.atBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
    } else if (
      event.detail.aboveViewport &&
      Number.isFinite(event.detail.scrollHeight) &&
      Number.isFinite(event.detail.nextScrollHeight) &&
      Number.isFinite(event.detail.scrollTop)
    ) {
      scroller.scrollTop = Math.min(
        event.detail.scrollTop +
          (event.detail.nextScrollHeight - event.detail.scrollHeight),
        maxScrollTop(scroller),
      );
    }
    this.rememberConversationScroll();
  }

  renderHeader() {
    const title =
      this.view === "new"
        ? "New Task"
        : this.view === "detail"
          ? "Task"
          : "Tasks";
    const subtitle = this.globalTasksSubtitle();

    return `
      <header class="tasks-header">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p>${escapeHtml(subtitle)}</p>
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

  globalTasksSubtitle() {
    return this.cwdPath ? `Tasks in ${this.displayCwdPath()}` : "All Tasks";
  }

  displayCwdPath() {
    return this.cwdPath === "." ? "~" : this.cwdPath;
  }

  renderBody() {
    if (this.loading && !this.taskDetail && this.view === "detail") {
      return `<p class="surface-message">Loading task...</p>`;
    }
    if (this.error && this.view !== "new") {
      return `<p class="surface-message">${escapeHtml(this.error.message)}</p>`;
    }
    if (this.view === "new") {
      return this.newTaskBrowsing
        ? this.renderNewTaskCwdBrowser()
        : this.renderNewTaskWorkspace();
    }
    if (this.view === "detail") {
      return this.renderTaskDetail();
    }
    return this.renderNewTaskWorkspace({ home: true });
  }

  renderTaskList() {
    if (this.taskListLoading && !this.tasks.length) {
      return `<p class="surface-message">Loading tasks...</p>`;
    }
    if (this.taskListError && !this.tasks.length) {
      return `<p class="surface-message">${escapeHtml(this.taskListError.message)}</p>`;
    }
    if (!this.tasks.length) {
      return `
        <div class="tasks-empty">
          <p>No tasks yet.</p>
          <button type="button" class="task-primary-button" data-task-action="open-new">New Task</button>
        </div>
      `;
    }

    const tasks = sortTasksByRecency(this.tasks);
    if (!this.usesRepositoryGroups()) {
      return `
        <div class="task-list-scroll">
          <ol class="task-list">
            ${tasks.map((task) => this.renderTaskRow(task)).join("")}
          </ol>
        </div>
      `;
    }

    const groups = groupTasksByRepository(tasks);
    return `
      <div class="task-list-scroll">
        <ol class="task-repository-groups">
          ${groups.map((group) => this.renderTaskRepositoryGroup(group)).join("")}
        </ol>
      </div>
    `;
  }

  usesRepositoryGroups() {
    return !cleanLogicalPath(this.cwdPath);
  }

  renderTaskRepositoryGroup(group) {
    const icon = group.repository ? "FolderGit2" : "Folder";
    const iconLabel = group.repository ? "Git repository" : "Directory";
    return `
      <li class="task-repository-group" data-task-repository-key="${escapeHtml(group.key)}">
        <div class="task-repository-header" title="${escapeHtml(group.rootPath)}">
          ${renderInlineIcon(icon, iconLabel, "task-repository-icon")}
          <span class="task-repository-label">${escapeHtml(group.label)}</span>
          <span class="task-repository-count">${group.tasks.length}</span>
        </div>
        <ol class="task-list">
          ${group.tasks.map((task) => this.renderTaskRow(task, group.key)).join("")}
        </ol>
      </li>
    `;
  }

  renderTaskRow(task, repositoryKey = this.taskListPartitionKey(task)) {
    const threadId = task.threadId ?? task.id;
    const selected = threadId === this.selectedThreadId ? ` aria-current="true"` : "";
    const status = taskStatusView(task.status)?.status ?? "idle";
    const busy = status === "running" ? ` aria-busy="true"` : "";
    const meta = renderTaskRowMeta(task, this.isTaskCompletionUnseen(task));
    const worktree = task?.worktree?.linked
      ? `<span class="task-row-worktree" title="${escapeHtml(taskWorktreeLabel(task))}">
          ${renderInlineIcon("GitBranch", "Linked worktree", "task-row-worktree-icon")}
        </span>`
      : "";
    return `
      <li data-thread-id="${escapeHtml(threadId)}" data-task-list-key="${escapeHtml(repositoryKey)}">
        <button type="button" class="task-row" data-task-action="open-task" data-thread-id="${escapeHtml(threadId)}" data-task-status="${escapeHtml(status)}" title="${escapeHtml(task.title)}"${selected}${busy}>
          <span class="task-row-title">${escapeHtml(task.title)}</span>
          <span class="task-row-indicators">
            ${worktree}
            ${meta}
          </span>
        </button>
      </li>
    `;
  }

  taskListPartitionKey(task) {
    return this.usesRepositoryGroups() ? taskRepositoryKey(task) : "flat";
  }

  syncTaskListSelection() {
    for (const row of this.querySelectorAll(".task-row[data-thread-id]")) {
      if (row.dataset.threadId === this.selectedThreadId) {
        row.setAttribute("aria-current", "true");
      } else {
        row.removeAttribute("aria-current");
      }
    }
  }

  initializeTaskSeenState(tasks) {
    let changed = false;
    if (!this.taskSeenState.initialized) {
      for (const task of tasks) {
        changed = rememberTaskVersion(this.taskSeenState, task) || changed;
      }
      this.taskSeenState.initialized = true;
      changed = true;
    } else {
      for (const task of tasks) {
        const threadId = taskThreadId(task);
        if (
          this.isTaskCurrentlyViewed(threadId) ||
          (!hasSeenTaskVersion(this.taskSeenState, threadId) &&
            !isTaskCompletionStatus(task.status))
        ) {
          changed = rememberTaskVersion(this.taskSeenState, task) || changed;
        }
      }
    }
    if (changed) {
      writeTaskSeenState(this.taskSeenState);
    }
  }

  isTaskCompletionUnseen(task) {
    const threadId = taskThreadId(task);
    const version = taskUpdatedMs(task);
    if (
      !this.taskSeenState.initialized ||
      !threadId ||
      this.isTaskCurrentlyViewed(threadId) ||
      !version ||
      !isTaskCompletionStatus(task.status)
    ) {
      return false;
    }
    const seenVersion = Number(this.taskSeenState.versions[threadId]);
    return !Number.isFinite(seenVersion) || version > seenVersion;
  }

  markTaskSeenByThreadId(threadId) {
    const task = this.tasks.find((candidate) => taskThreadId(candidate) === threadId);
    if (!task || !this.markTaskSeen(task)) {
      return;
    }
    this.patchTaskListTask(task);
  }

  isTaskCurrentlyViewed(threadId) {
    return (
      threadId === this.selectedThreadId &&
      this.view === "detail" &&
      this.taskDetailView === "conversation" &&
      this.getClientRects().length > 0
    );
  }

  markTaskSeen(task) {
    if (!task || !rememberTaskVersion(this.taskSeenState, task)) {
      return false;
    }
    this.taskSeenState.initialized = true;
    writeTaskSeenState(this.taskSeenState);
    return true;
  }

  patchTaskListTask(task) {
    if (!task || !this.taskListLoaded) {
      return;
    }
    const threadId = taskThreadId(task);
    if (this.isTaskCurrentlyViewed(threadId)) {
      this.markTaskSeen(task);
    }
    const index = this.tasks.findIndex((candidate) => taskThreadId(candidate) === threadId);
    if (index < 0) {
      this.tasks = [...this.tasks, task];
      this.markTaskListDirty();
      return;
    }

    const previous = this.tasks[index];
    this.tasks = this.tasks.map((candidate, candidateIndex) =>
      candidateIndex === index ? task : candidate,
    );
    const previousListKey = this.taskListPartitionKey(previous);
    const nextListKey = this.taskListPartitionKey(task);
    const row = this.querySelector(
      `.tasks-list-region li[data-thread-id="${CSS.escape(threadId)}"]`,
    );
    if (!row || previousListKey !== nextListKey) {
      this.markTaskListDirty();
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = this.renderTaskRow(task, nextListKey).trim();
    const nextRow = template.content.firstElementChild;
    if (nextRow) {
      row.replaceWith(nextRow);
      this.syncTaskListSelection();
      this.reorderTaskListDom();
    }
  }

  reorderTaskListDom() {
    const tasks = sortTasksByRecency(this.tasks);
    if (!this.usesRepositoryGroups()) {
      const taskList = this.querySelector(".task-list-scroll > .task-list");
      if (!taskList) {
        return;
      }
      for (const task of tasks) {
        const row = taskList.querySelector(
          `:scope > [data-thread-id="${CSS.escape(taskThreadId(task))}"]`,
        );
        if (row) {
          taskList.append(row);
        }
      }
      return;
    }

    const groups = groupTasksByRepository(tasks);
    const groupList = this.querySelector(".task-repository-groups");
    if (!groupList) {
      return;
    }
    for (const group of groups) {
      const groupElement = groupList.querySelector(
        `:scope > [data-task-repository-key="${CSS.escape(group.key)}"]`,
      );
      if (!groupElement) {
        continue;
      }
      const taskList = groupElement.querySelector(":scope > .task-list");
      for (const task of group.tasks) {
        const row = taskList?.querySelector(
          `:scope > [data-thread-id="${CSS.escape(taskThreadId(task))}"]`,
        );
        if (row) {
          taskList.append(row);
        }
      }
      groupList.append(groupElement);
    }
  }

  renderNewTask(options = {}) {
    return this.renderTaskComposer({
      formName: "create",
      className: "task-new-form",
      prompt: this.newTaskDraft.prompt,
      placeholder: "Ask Codex to work from the current directory",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: options.cancel ?? true,
    });
  }

  renderNewTaskWorkspace(options = {}) {
    return `
      <section class="task-new-workspace${options.home ? " is-home" : ""}">
        ${
          this.error
            ? `<div class="task-new-error" role="alert">
                ${renderInlineIcon("TriangleAlert", "Codex unavailable", "task-new-error-icon")}
                <span>${escapeHtml(this.error.message)}</span>
              </div>`
            : ""
        }
        ${this.renderNewTask({ cancel: !options.home })}
      </section>
    `;
  }

  renderNewTaskCwdBrowser() {
    return `
      <section class="task-new-cwd-browser" aria-label="Choose task directory">
        <header>
          <div>
            <h2>Browse Files</h2>
            <p>${escapeHtml(this.activeCwdPath())}</p>
          </div>
          <div>
            <button type="button" class="task-toolbar-button" data-task-action="cancel-new-task-cwd">Cancel</button>
            <button type="button" class="task-primary-button" data-task-action="choose-new-task-cwd">Use This Folder</button>
          </div>
        </header>
        <caffold-file-browser></caffold-file-browser>
      </section>
    `;
  }

  renderTaskComposer({
    formName,
    className,
    prompt,
    placeholder,
    ariaLabel,
    submitLabel,
    cancel = false,
    threadId = "",
  }) {
    const model = this.selectedModelOption();
    const effort = this.selectedEffort();
    const submitting =
      formName === "follow-up" &&
      this.followUpRequest?.threadId === threadId;
    const images = this.composerImages(formName);
    const imageError = this.composerImageErrors.get(formName) ?? "";
    return `
      <form class="task-composer ${escapeHtml(className)}" data-task-form="${escapeHtml(formName)}"${threadId ? ` data-thread-id="${escapeHtml(threadId)}"` : ""} aria-busy="${submitting ? "true" : "false"}">
        <div class="task-composer-panel">
          ${
            formName === "create"
              ? `<div class="task-composer-context">
                  ${renderInlineIcon("Folder", "Working directory", "task-composer-context-icon")}
                  <span title="${escapeHtml(this.activeCwdPath())}">${escapeHtml(this.activeCwdPath())}</span>
                  <button type="button" data-task-action="browse-new-task-cwd">Browse Files</button>
                </div>`
              : ""
          }
          ${this.renderComposerImages(formName, images, threadId)}
          <textarea
            name="prompt"
            rows="2"
            data-max-rows="10.5"
            aria-label="${escapeHtml(ariaLabel)}"
            placeholder="${escapeHtml(placeholder)}"
          >${escapeHtml(prompt ?? "")}</textarea>
          ${imageError ? `<p class="task-composer-image-error" role="alert">${escapeHtml(imageError)}</p>` : ""}
          <input type="hidden" name="model" value="${escapeHtml(model?.model ?? "")}">
          <input type="hidden" name="effort" value="${escapeHtml(effort)}">
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              ${
                cancel
                  ? `<button type="button" class="task-toolbar-button" data-task-action="open-list">Cancel</button>`
                  : ""
              }
              ${this.renderModelPicker(formName)}
            </div>
            <button type="submit" class="task-send-button" aria-label="${escapeHtml(submitLabel)}" title="${escapeHtml(submitLabel)}"${submitting ? " disabled" : ""}>
              <span class="task-send-arrow" aria-hidden="true">&uarr;</span>
            </button>
          </div>
        </div>
      </form>
    `;
  }

  renderComposerImages(formName, images, threadId = "") {
    if (!images.length) {
      return "";
    }
    return `
      <div class="task-composer-attachments" aria-label="Images to send">
        ${images
          .map(
            (image) => `
              <figure class="task-composer-attachment" title="${escapeHtml(image.name)}">
                <img src="${escapeHtml(image.dataUrl)}" alt="${escapeHtml(image.name)}">
                <button
                  type="button"
                  data-task-action="remove-composer-image"
                  data-form-name="${escapeHtml(formName)}"
                  ${threadId ? `data-thread-id="${escapeHtml(threadId)}"` : ""}
                  data-image-id="${escapeHtml(image.id)}"
                  aria-label="Remove ${escapeHtml(image.name)}"
                  title="Remove image"
                >${renderInlineIcon("X", "Remove image", "task-composer-attachment-remove-icon")}</button>
              </figure>
            `,
          )
          .join("")}
      </div>
    `;
  }

  renderModelPicker(formName) {
    const model = this.selectedModelOption();
    const modelLabel = model?.displayName ?? (this.modelOptionsLoading ? "Loading model" : "Model");
    const effort = this.selectedEffort();
    const effortLabel = reasoningLabel(effort);
    const open = this.openModelPickerForm === formName;
    const modelRows = this.modelOptions.length
      ? this.modelOptions.map((option) => renderModelOption(option, this.composerSettings.model)).join("")
      : renderModelFallback(this.modelOptionsLoading, this.modelOptionsError);
    const reasoningRows = this.reasoningOptionsForModel(model)
      .map((option) => renderReasoningOption(option, effort))
      .join("");

    return `
      <div class="task-model-picker${open ? " is-open" : ""}">
        <button
          type="button"
          class="task-model-button"
          data-task-action="toggle-model-picker"
          data-form-name="${escapeHtml(formName)}"
          aria-expanded="${open ? "true" : "false"}"
          aria-label="Choose model and reasoning"
        >
          ${renderInlineIcon("Circle", "Model", "task-model-icon")}
          <span>${escapeHtml(modelLabel)}</span>
          <span>${escapeHtml(effortLabel)}</span>
          <span class="task-model-caret" aria-hidden="true">&#8964;</span>
        </button>
        ${
          open
            ? `<button
                type="button"
                class="task-model-backdrop"
                data-task-action="close-model-picker"
                aria-label="Close model picker"
              ></button>
              <div class="task-model-popover" role="menu" aria-label="Model and reasoning options">
                <section>
                  <p>Reasoning level</p>
                  ${reasoningRows}
                </section>
                <hr>
                <section>
                  <p>Model</p>
                  ${modelRows}
                </section>
              </div>`
            : ""
        }
      </div>
    `;
  }

  renderTaskDetail() {
    const task = this.taskDetail?.task;
    if (!task) {
      return `<p class="surface-message">${this.loading ? "Loading task..." : "Select a task."}</p>`;
    }
    const approvals = pendingApprovals(this.events);
    return `
      <div class="task-detail" data-thread-id="${escapeHtml(task.threadId ?? task.id)}" data-task-detail-view="${escapeHtml(this.taskDetailView)}">
        ${this.renderTaskDetailSummary(task)}
        <section class="task-conversation-pane" aria-label="Task conversation">
          <div class="task-conversation-scroll">
            <div class="task-conversation-column">
              ${this.renderStreamState()}
              ${this.eventsPage?.nextCursor || this.loadingOlderEvents ? `<div class="task-load-older">${this.loadingOlderEvents ? "Loading older..." : ""}</div>` : ""}
              <ol class="task-conversation" aria-label="Task conversation">
                ${renderConversation(this.events, task, approvals)}
              </ol>
            </div>
          </div>
          ${this.renderTaskComposer({
            formName: "follow-up",
            className: "task-follow-up-form",
            threadId: taskThreadId(task),
            prompt: this.followUpDraft,
            placeholder: "Send another prompt to this task",
            ariaLabel: "Follow-up prompt",
            submitLabel: "Send prompt",
          })}
        </section>
        ${this.renderTaskFilesView()}
        ${this.renderTaskDiffView()}
      </div>
    `;
  }

  renderTaskDetailSummary(task) {
    const status = renderTaskStatusChip(task.status, "task-detail-status", { label: false });
    const statusLabel = formatStatus(task.status);
    const canOpenDiff = Boolean(task.worktree);
    const worktreeLabel = taskWorktreeLabel(task);

    return `
      <section class="task-detail-summary">
          <div class="task-detail-heading">
            <h2>${escapeHtml(task.title)}</h2>
            <p class="task-detail-meta">
              <span>Thread ${escapeHtml(shortId(task.threadId ?? task.id))}</span>
              ${worktreeLabel ? `<span>${escapeHtml(worktreeLabel)}</span>` : ""}
            </p>
          </div>
          <div class="task-detail-right">
            <div class="task-detail-actions">
              <button
                type="button"
                class="task-secondary-button"
                data-task-action="toggle-files"
                aria-pressed="${this.taskDetailView === "files" ? "true" : "false"}"
              >
                ${renderInlineIcon("Folder", "Files", "task-action-icon")}
                <span class="task-action-label">Files</span>
              </button>
              <button
                type="button"
                class="task-secondary-button"
                data-task-action="open-diff"
                aria-pressed="${this.taskDetailView === "diff" ? "true" : "false"}"
                ${canOpenDiff ? "" : "disabled"}
                title="${canOpenDiff ? "Open worktree diff" : "Diff is unavailable outside a Git worktree"}"
              >
                ${renderInlineIcon("FileDiff", "Open diff", "task-action-icon")}
                <span class="task-action-label">Open Diff</span>
              </button>
              ${this.renderTaskReviewMenus(task)}
              ${
                task.activeTurnId
                  ? `<button type="button" class="task-secondary-button" data-task-action="interrupt">
                      ${renderInlineIcon("Square", "Interrupt", "task-action-icon")}
                      <span class="task-action-label">Interrupt</span>
                    </button>`
                  : ""
              }
            </div>
            <button
              type="button"
              class="task-detail-info-button"
              popovertarget="task-detail-info"
              aria-label="Task details, ${escapeHtml(statusLabel)}"
              title="Status: ${escapeHtml(statusLabel)}"
            >
              ${status || renderInlineIcon("Info", "Task details", "task-action-icon")}
            </button>
          </div>
          <div
            id="task-detail-info"
            class="task-detail-popover"
            popover="auto"
            aria-label="Task details"
          >
            <dl>
              <div>
                <dt>Status</dt>
                <dd>${escapeHtml(statusLabel)}</dd>
              </div>
              <div>
                <dt>Thread</dt>
                <dd>${escapeHtml(task.threadId ?? task.id)}</dd>
              </div>
              <div>
                <dt>Working directory</dt>
                <dd>${escapeHtml(task.cwdPath || task.cwd || this.displayCwdPath())}</dd>
              </div>
              ${
                task.worktree
                  ? `<div>
                      <dt>Worktree</dt>
                      <dd>${escapeHtml(task.worktree.rootPath)}</dd>
                    </div>
                    <div>
                      <dt>Branch</dt>
                      <dd>${escapeHtml(taskWorktreeRef(task))}</dd>
                    </div>`
                  : ""
              }
              ${
                canOpenDiff
                  ? ""
                  : `<div>
                      <dt>Diff review</dt>
                      <dd>Unavailable outside a Git worktree.</dd>
                    </div>`
              }
            </dl>
          </div>
        </section>
    `;
  }

  renderTaskReviewMenus(task) {
    const rootPath = taskWorktreeRootPath(task);
    if (!rootPath) {
      return `
        <button type="button" class="task-brand-button" disabled title="Git and GitHub are unavailable outside a Git worktree">
          <img src="/assets/brand/git-logomark-light.svg" alt="">
          <span class="sr-only">Git unavailable</span>
        </button>
        <button type="button" class="task-brand-button" disabled title="Git and GitHub are unavailable outside a Git worktree">
          <img src="/assets/brand/github-invertocat-light.svg" alt="">
          <span class="sr-only">GitHub unavailable</span>
        </button>
      `;
    }

    const github = this.taskGithubMenuState(rootPath);
    return `
      <details class="task-review-menu">
        <summary class="task-brand-button" title="Open Git workspace" aria-label="Open Git workspace">
          <img src="/assets/brand/git-logomark-light.svg" alt="">
        </summary>
        <div class="task-review-menu-popover" role="menu" aria-label="Git workspace">
          <button type="button" role="menuitem" data-task-action="open-git-tool" data-review-kind="diff">Working Tree</button>
          <button type="button" role="menuitem" data-task-action="open-git-tool" data-review-kind="compare">Compare</button>
          <button type="button" role="menuitem" data-task-action="open-git-tool" data-review-kind="log">Log</button>
        </div>
      </details>
      ${
        github.enabled
          ? `<details class="task-review-menu">
              <summary class="task-brand-button" title="Open GitHub workspace" aria-label="Open GitHub workspace">
                <img src="/assets/brand/github-invertocat-light.svg" alt="">
              </summary>
              <div class="task-review-menu-popover" role="menu" aria-label="GitHub workspace">
                <button type="button" role="menuitem" data-task-action="open-github-tool" data-review-kind="pulls" ${github.pulls ? "" : "disabled"}>Pull Requests</button>
                <button type="button" role="menuitem" data-task-action="open-github-tool" data-review-kind="issues" ${github.issues ? "" : "disabled"}>Issues</button>
              </div>
            </details>`
          : `<button type="button" class="task-brand-button${github.loading ? " is-loading" : ""}" disabled title="${escapeHtml(github.message)}">
              <img src="/assets/brand/github-invertocat-light.svg" alt="">
              <span class="sr-only">${escapeHtml(github.message)}</span>
            </button>`
      }
    `;
  }

  renderStreamState() {
    if (this.streamState === "reconnecting") {
      return `
        <div class="task-stream-state" data-stream-state="reconnecting" role="status">
          <span class="task-stream-spinner" aria-hidden="true"></span>
          <span>Reconnecting live updates...</span>
        </div>
      `;
    }
    if (this.streamState === "error") {
      return `
        <div class="task-stream-state" data-stream-state="error" role="status">
          ${renderInlineIcon("TriangleAlert", "Live updates unavailable", "task-stream-icon")}
          <span>Live updates unavailable.</span>
          <button type="button" data-task-action="retry-stream">Retry</button>
        </div>
      `;
    }
    return "";
  }

  renderTaskFilesView() {
    const task = this.taskDetail?.task;
    const label = task?.worktree
      ? `${taskWorktreeRootName(task)} · ${taskWorktreeRef(task)}`
      : task?.cwdPath || "Current directory";
    return `
      <section class="task-files-view" aria-label="Task files">
        <header class="task-files-header">
          <div>
            <h3>Files</h3>
            <p>${escapeHtml(label)}</p>
          </div>
        </header>
        <caffold-file-browser></caffold-file-browser>
      </section>
    `;
  }

  renderTaskDiffView() {
    const task = this.taskDetail?.task;
    if (!task?.worktree) {
      return "";
    }
    const refreshLabel = this.taskDiffWatchUnavailable
      ? "Live updates unavailable. Refresh manually."
      : this.taskReviewRefreshLabel();
    return `
      <section
        class="task-diff-view"
        data-task-diff-mode="${escapeHtml(this.taskDiffMode)}"
        aria-label="Task worktree review"
      >
        <header class="task-diff-header">
          <div class="task-diff-heading">
            <h3>Diff</h3>
            <p class="task-diff-subtitle">${escapeHtml(this.taskDiffSubtitle())}</p>
          </div>
          <div class="task-diff-controls">
            <div class="task-diff-mode-switch" role="group" aria-label="Diff mode">
              <button
                type="button"
                data-task-action="select-diff-mode"
                data-diff-mode="working"
                aria-pressed="${this.taskDiffMode === "working"}"
              >Working Tree</button>
              <button
                type="button"
                data-task-action="select-diff-mode"
                data-diff-mode="branch"
                aria-pressed="${this.taskDiffMode === "branch"}"
              >Branch</button>
            </div>
            <div class="task-compare-controls" aria-label="Branch comparison">
              <label>
                <span>Base</span>
                <select data-task-compare-base disabled>
                  <option value="">Loading refs...</option>
                </select>
              </label>
              <span class="task-compare-separator" aria-hidden="true">...</span>
              <span class="task-compare-head-label">Head</span>
              <span class="task-compare-head" data-task-compare-head title="${escapeHtml(this.taskCompareHeadRef())}">
                ${escapeHtml(this.taskCompareHeadRef())}
              </span>
            </div>
            <button
              type="button"
              class="task-icon-button${this.taskDiffRefreshState === "refreshing" ? " is-refreshing" : ""}${this.taskDiffWatchUnavailable ? " is-unavailable" : ""}"
              data-task-action="refresh-diff"
              aria-label="${escapeHtml(refreshLabel)}"
              title="${escapeHtml(refreshLabel)}"
            >
              ${renderInlineIcon("RefreshCw", refreshLabel, "task-refresh-icon")}
            </button>
          </div>
        </header>
        <div class="task-diff-panel" data-task-diff-panel="working">
          <caffold-git-diff-browser></caffold-git-diff-browser>
        </div>
        <div class="task-diff-panel" data-task-diff-panel="branch">
          <caffold-git-compare-browser></caffold-git-compare-browser>
        </div>
      </section>
    `;
  }
}

customElements.define("caffold-tasks-page", CaffoldTasksPage);

function isVisibleStreamState(state) {
  return state === "reconnecting" || state === "error";
}

function normalizeModelOptions(response) {
  const models = Array.isArray(response?.data) ? response.data : [];
  return models
    .map((model) => {
      const modelValue = `${model?.model ?? model?.id ?? ""}`.trim();
      if (!modelValue) {
        return null;
      }
      return {
        model: modelValue,
        displayName: `${model?.displayName ?? modelValue}`.trim(),
        description: `${model?.description ?? ""}`.trim(),
        isDefault: Boolean(model?.isDefault),
        defaultReasoningEffort: `${model?.defaultReasoningEffort ?? ""}`.trim(),
        supportedReasoningEfforts: normalizeReasoningOptions(
          model?.supportedReasoningEfforts,
        ),
      };
    })
    .filter(Boolean);
}

function normalizeReasoningOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    return [];
  }
  return options
    .map((option) => {
      const value = `${option?.reasoningEffort ?? option ?? ""}`.trim();
      if (!value) {
        return null;
      }
      return {
        value,
        label: reasoningLabel(value),
        description: `${option?.description ?? ""}`.trim(),
      };
    })
    .filter(Boolean);
}

function reasoningLabel(value) {
  switch (value) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "ultra":
      return "Very high";
    default:
      return value ? titleCase(value) : "Reasoning";
  }
}

function titleCase(value) {
  return `${value}`
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderReasoningOption(option, selectedEffort) {
  const selected = option.value === selectedEffort;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-effort"
      data-effort="${escapeHtml(option.value)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.label)}</strong>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderModelOption(option, selectedModel) {
  const selected = option.model === selectedModel;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-model"
      data-model="${escapeHtml(option.model)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.displayName)}</strong>
        ${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderModelFallback(loading, error) {
  if (loading) {
    return `<p class="task-model-note">Loading models...</p>`;
  }
  if (error) {
    return `<p class="task-model-note">Model list unavailable. The default Codex model will be used.</p>`;
  }
  return `<p class="task-model-note">Open this menu after Codex is connected.</p>`;
}

function renderConversation(events, task, approvals = []) {
  const conversationEvents = dedupeCanonicalEvents(events);
  const groups = conversationGroups(conversationEvents);
  const activeGroupIndex = activeTurnGroupIndex(groups, task);
  const userPrompts = new Set(
    conversationEvents
      .filter((event) => event.type === "user_message")
      .map((event) => `${event.payload?.text ?? event.payload?.prompt ?? ""}`.trim())
      .filter(Boolean),
  );
  const output = groups
    .map((group, index) => {
      if (group.kind === "turn") {
        return renderTurnGroup(group, task, {
          forceActive: index === activeGroupIndex,
          approvals: index === activeGroupIndex ? approvals : [],
        });
      }
      if (!shouldRenderStandaloneEvent(group.event, userPrompts)) {
        return "";
      }
      return renderConversationEvent(group.event, task, { active: false });
    })
    .join("");
  if (isTaskActivelyWorking(task) && activeGroupIndex < 0) {
    return `${output}${renderActiveTurnStatus(
      {
        turnId: task?.activeTurnId ?? "active-turn",
        events: [],
      },
      task,
    )}${renderApprovalFlow(approvals)}`;
  }
  return output;
}

function activeTurnGroupIndex(groups, task) {
  if (!isTaskActivelyWorking(task)) {
    return -1;
  }
  const exactIndex = groups.findIndex(
    (group) => group.kind === "turn" && group.turnId === task?.activeTurnId,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const startedMs = Number(task?.activeTurnStartedMs);
  if (!Number.isFinite(startedMs) || startedMs <= 0) {
    return -1;
  }
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.kind !== "turn") {
      continue;
    }
    const hasCurrentEvent = group.events.some(
      (event) => Number(event.createdMs) >= startedMs - 2_000,
    );
    if (hasCurrentEvent) {
      return index;
    }
  }
  return groups.findLastIndex((group) => group.kind === "turn");
}

function isTaskActivelyWorking(task) {
  return ["running", "waiting_for_approval"].includes(task?.status);
}

function conversationGroups(events) {
  const groups = [];
  const turns = new Map();
  let activeGroup = null;

  const createImplicitTurnGroup = () => {
    const group = { kind: "turn", turnId: `implicit-${groups.length}`, events: [] };
    groups.push(group);
    activeGroup = group;
    return group;
  };

  for (const event of events) {
    const turnId = eventTurnId(event);
    if (!turnId) {
      if (event.type === "user_message") {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      if (isImplicitTurnEvent(event) && canAcceptTurnContinuation(activeGroup)) {
        activeGroup.events.push(event);
        continue;
      }
      if (isImplicitTurnEvent(event)) {
        createImplicitTurnGroup().events.push(event);
        continue;
      }
      groups.push({ kind: "event", event });
      continue;
    }

    let group = turns.get(turnId);
    if (!group) {
      group = { kind: "turn", turnId, events: [] };
      turns.set(turnId, group);
      groups.push(group);
    }
    group.events.push(event);
    activeGroup = isTerminalTurnEvent(event) ? null : group;
  }
  return groups;
}

function eventTurnId(event) {
  const payload = event?.payload ?? {};
  return payload.turnId ?? payload.turn?.id ?? null;
}

function renderTurnGroup(group, task, options = {}) {
  const userEvents = group.events.filter((event) => event.type === "user_message");
  const assistantEvents = group.events.filter((event) => event.type === "assistant_message");
  const workEvents = group.events.filter(isWorkEvent);
  const statusEvents = group.events.filter(isTurnStatusEvent);
  const terminalEvent = statusEvents.find(isTerminalTurnEvent);
  const isCurrentTurn = task?.activeTurnId === group.turnId;
  const isActive =
    isTaskActivelyWorking(task) && (options.forceActive || isCurrentTurn);
  const isComplete = Boolean(terminalEvent) || (assistantEvents.length > 0 && !isActive);

  const output = [];
  output.push(
    ...userEvents.map((event) =>
      renderConversationEvent(event, task, { active: false }),
    ),
  );

  if (isActive) {
    output.push(renderActiveTurnStatus(group, task));
    output.push(renderApprovalFlow(options.approvals ?? []));
  }

  if (isComplete && assistantEvents.length > 0) {
    const finalAssistantEvent =
      assistantEvents.findLast(isFinalAssistantEvent) ?? assistantEvents.at(-1);
    const progressAssistantEvents = assistantEvents.filter(
      (event) => event !== finalAssistantEvent,
    );
    const hiddenWorkEvents = [...progressAssistantEvents, ...workEvents];
    if (hiddenWorkEvents.length > 0) {
      output.push(renderTurnWorkSummary(group, hiddenWorkEvents, terminalEvent));
    }
    output.push(
      renderConversationEvent(finalAssistantEvent, task, {
        active: false,
        messagePhase: "final",
      }),
    );
    return output.join("");
  }

  output.push(
    ...workEvents.map((event) =>
      renderConversationEvent(event, task, { active: isActive }),
    ),
  );
  output.push(
    ...assistantEvents.map((event) =>
      renderConversationEvent(event, task, { active: false }),
    ),
  );
  return output.join("");
}

function renderActiveTurnStatus(group, task) {
  const startedMs = activeTurnStartMs(group.events, task);
  const state = activeTurnStateLabel(group.events, task);
  return `
    <li
      class="task-event task-turn-active"
      data-active-turn-started-ms="${escapeHtml(startedMs)}"
      data-turn-id="${escapeHtml(group.turnId)}"
    >
      <span class="task-status-spinner" aria-hidden="true"></span>
      <span class="task-turn-active-duration">Working for ${escapeHtml(formatDuration(Date.now() - startedMs))}</span>
      <span class="task-turn-active-state" title="${escapeHtml(state)}" aria-live="polite">${escapeHtml(state)}</span>
    </li>
  `;
}

function activeTurnStartMs(events, task) {
  const taskStartedMs = Number(task?.activeTurnStartedMs);
  if (Number.isFinite(taskStartedMs) && taskStartedMs > 0) {
    return taskStartedMs;
  }
  const started = events.find((event) => event.type === "turn_started");
  const value = Number(started?.createdMs ?? events[0]?.createdMs ?? Date.now());
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function activeTurnStateLabel(events, task) {
  if (task?.status === "waiting_for_approval") {
    return "Waiting for approval";
  }

  const event =
    [...events]
      .reverse()
      .find((entry) => entry.payload?.lifecycle === "started") ??
    [...events]
      .reverse()
      .find((entry) =>
        entry.type === "work_status" ||
        entry.type === "reasoning" ||
        entry.type === "plan" ||
        entry.type === "command_execution" ||
        entry.type === "file_change" ||
        entry.type === "assistant_message",
      );
  if (!event) {
    return "Thinking";
  }
  if (event.type === "work_status") {
    return activeWorkItemLabel(event.payload?.itemType);
  }
  if (event.type === "reasoning") {
    return "Thinking";
  }
  if (event.type === "plan") {
    return "Updating plan";
  }
  if (event.type === "command_execution") {
    return "Running command";
  }
  if (event.type === "file_change") {
    return "Editing files";
  }
  return "Thinking";
}

function activeWorkItemLabel(itemType) {
  if (itemType === "plan") {
    return "Updating plan";
  }
  if (["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(itemType)) {
    return "Running command";
  }
  if (itemType === "fileChange") {
    return "Editing files";
  }
  return "Thinking";
}

function renderApprovalFlow(approvals) {
  if (!approvals.length) {
    return "";
  }
  return `
    <li class="task-event task-approval-flow">
      <section class="task-approvals" aria-label="Pending approvals">
        ${approvals.map(renderApprovalCard).join("")}
      </section>
    </li>
  `;
}

function shouldRenderStandaloneEvent(event, userPrompts) {
  if (event.type === "prompt_sent") {
    const prompt = `${event.payload?.prompt ?? event.payload?.text ?? ""}`.trim();
    return Boolean(prompt && !userPrompts.has(prompt));
  }
  return ![
    "thread_started",
    "turn_started",
    "turn_completed",
    "thread_status_changed",
    "approval_requested",
    "approval_resolved",
    "diff_updated",
    "work_status",
  ].includes(event.type);
}

function renderConversationEvent(event, task, eventState) {
  const payload = event.payload ?? {};
  if (event.type === "prompt_sent" || event.type === "user_message") {
    if (event.type === "prompt_sent") {
      return renderStatusEvent(event);
    }
    const message = userMessagePresentation(payload);
    return renderMessageEvent(event, "user", message.text, {
      attachments: message.attachments,
    });
  }
  if (event.type === "assistant_message") {
    return renderMessageEvent(event, "assistant", payload.text, {
      phase: eventState?.messagePhase ?? assistantMessagePhase(payload.phase),
    });
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderThinkingEvent(
      event,
      [summary, content].filter(Boolean).join("\n\n"),
      task,
      eventState,
    );
  }
  if (event.type === "plan") {
    return renderToolEvent(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return renderCommandEvent(event);
  }
  if (event.type === "file_change") {
    return renderFileChangeEvent(event);
  }
  if (event.type === "task_failed") {
    return renderToolEvent(event, "Error", event.summary, "danger");
  }
  return renderStatusEvent(event);
}

function isWorkEvent(event) {
  return ["reasoning", "plan", "command_execution", "file_change", "task_failed"].includes(
    event.type,
  );
}

function isTurnContinuationEvent(event) {
  return event.type === "work_status" || isWorkEvent(event) || isTurnStatusEvent(event);
}

function isImplicitTurnEvent(event) {
  return event.type === "assistant_message" || isTurnContinuationEvent(event);
}

function canAcceptTurnContinuation(group) {
  if (!group || group.kind !== "turn") {
    return false;
  }
  const events = group.events ?? [];
  return !events.some((event) => isTerminalTurnEvent(event));
}

function isTurnStatusEvent(event) {
  return [
    "turn_started",
    "turn_completed",
    "turn_interrupted",
    "approval_resolved",
    "diff_updated",
  ].includes(event.type);
}

function isTerminalTurnEvent(event) {
  if (!isTurnStatusEvent(event)) {
    return false;
  }
  const status = event.payload?.status ?? event.type;
  return (
    event.type === "turn_completed" ||
    event.type === "turn_interrupted" ||
    ["completed", "failed", "interrupted"].includes(status)
  );
}

function renderStatusEvent(event) {
  const status = statusTone(event.type);
  return `
    <li class="task-event task-event-status" data-event-type="${escapeHtml(event.type)}" data-event-status="${escapeHtml(status)}">
      <span class="task-status-chip">${escapeHtml(event.summary)}</span>
      <time>${escapeHtml(formatDate(event.createdMs))}</time>
    </li>
  `;
}

function renderMessageEvent(event, role, text, options = {}) {
  const value = `${text ?? ""}`.trim();
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (!value && !attachments.length) {
    return renderStatusEvent(event);
  }
  const phaseAttribute = options.phase
    ? ` data-message-phase="${escapeHtml(options.phase)}"`
    : "";
  const attachmentsAttribute = attachments.length ? " data-has-attachments" : "";

  return `
    <li class="task-event task-message" data-event-type="${escapeHtml(event.type)}" data-message-role="${escapeHtml(role)}"${phaseAttribute}${attachmentsAttribute}>
      <div class="task-message-header">
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </div>
      ${renderMessageAttachments(attachments)}
      ${value ? `
        <div class="task-message-content">
          <caffold-task-markdown>${escapeHtml(value)}</caffold-task-markdown>
        </div>
      ` : ""}
    </li>
  `;
}

function userMessagePresentation(payload) {
  const prompt = `${payload.prompt ?? ""}`.trim();
  const payloadText = `${payload.text ?? ""}`.trim();
  const text = prompt || payloadText;
  const content = Array.isArray(payload.item?.content) ? payload.item.content : [];
  const imageItems = content.filter((item) => ["image", "localImage"].includes(item?.type));

  if (!imageItems.length) {
    return { text, attachments: [] };
  }

  const parsed = parseCodexAttachmentPrompt(text);
  const names = parsed?.fileNames ?? [];
  return {
    text: parsed?.request ?? text,
    attachments: imageItems.map((item, index) => ({
      src: taskImageSource(item),
      name: item.name ?? names[index] ?? `Attached image ${index + 1}`,
    })),
  };
}

function taskImageSource(item) {
  if (item?.type === "image") {
    return safeTaskImageSource(item.url);
  }
  if (item?.type !== "localImage") {
    return "";
  }
  const path = `${item.path ?? ""}`.trim();
  if (!path.startsWith("/")) {
    return "";
  }
  return `/api/task-image?${new URLSearchParams({ path })}`;
}

function safeTaskImageSource(value) {
  const source = `${value ?? ""}`.trim();
  return /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(source)
    ? source
    : "";
}

function parseCodexAttachmentPrompt(text) {
  const filesMarker = /^# Files mentioned by the user:\s*$/m;
  const requestMarker = /^## My request for Codex:\s*$/m;
  const filesMatch = filesMarker.exec(text);
  const requestMatch = requestMarker.exec(text);
  if (!filesMatch || !requestMatch || requestMatch.index <= filesMatch.index) {
    return null;
  }

  const fileSection = text.slice(filesMatch.index + filesMatch[0].length, requestMatch.index);
  const fileNames = Array.from(
    fileSection.matchAll(/^##\s+(.+?):\s+\/.*$/gm),
    (match) => match[1].trim(),
  ).filter((name) => /\.(?:avif|gif|jpe?g|png|webp)$/i.test(name));
  const request = text
    .slice(requestMatch.index + requestMatch[0].length)
    .trim();

  return { fileNames, request };
}

function renderMessageAttachments(attachments) {
  if (!attachments.length) {
    return "";
  }

  return `
    <div class="task-message-attachments" aria-label="Attached images">
      ${attachments
        .map(
          (attachment) => `
            <figure class="task-message-attachment">
              ${attachment.src ? `
                <div class="task-message-attachment-preview">
                  <img src="${escapeHtml(attachment.src)}" alt="${escapeHtml(attachment.name)}" loading="lazy">
                </div>
              ` : `
                <div class="task-message-attachment-preview task-message-attachment-unavailable">
                  ${renderInlineIcon("ImageOff", "Image preview unavailable", "task-message-attachment-placeholder-icon")}
                  <span>Preview unavailable</span>
                </div>
              `}
              <figcaption title="${escapeHtml(attachment.name)}">
                ${renderInlineIcon("FileImage", "Attached image", "task-message-attachment-icon")}
                <span>${escapeHtml(attachment.name)}</span>
              </figcaption>
            </figure>
          `,
        )
        .join("")}
    </div>
  `;
}

function assistantMessagePhase(phase) {
  if (["final", "final_answer"].includes(phase)) {
    return "final";
  }
  if (phase === "commentary") {
    return "progress";
  }
  return null;
}

function isFinalAssistantEvent(event) {
  return assistantMessagePhase(event?.payload?.phase ?? event?.payload?.item?.phase) === "final";
}

function renderThinkingEvent(event, text, task, eventState) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }
  const isActive =
    eventState?.active ??
    ["running", "waiting_for_approval"].includes(task?.status);
  const open = isActive ? " open" : "";
  const state = isActive ? "active" : "complete";

  return `
    <li class="task-event task-thinking" data-event-type="${escapeHtml(event.type)}" data-thinking-state="${escapeHtml(state)}">
      <details${open}>
        <summary>
          <span>Thinking</span>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <div class="task-thinking-content">
          <caffold-task-markdown>${escapeHtml(value)}</caffold-task-markdown>
        </div>
      </details>
    </li>
  `;
}

function renderTurnWorkSummary(group, workEvents, terminalEvent) {
  const duration = turnDurationLabel(group.events, terminalEvent);
  const count = workEvents.length;
  const updateText = count === 1 ? "1 update" : `${count} updates`;
  const label = duration ? `Worked for ${duration}` : "Work details";
  return `
    <li class="task-event task-turn-work" data-turn-id="${escapeHtml(group.turnId)}">
      <details>
        <summary>
          <span>${escapeHtml(label)}</span>
          <span>${escapeHtml(updateText)}</span>
        </summary>
        <div class="task-turn-work-body">
          ${renderTurnWorkItems(workEvents)}
        </div>
      </details>
    </li>
  `;
}

function turnDurationLabel(events, terminalEvent) {
  const started = events.find((event) => event.type === "turn_started");
  const startMs = started?.createdMs ?? events[0]?.createdMs;
  const endMs = terminalEvent?.createdMs ?? events.at(-1)?.createdMs;
  if (typeof startMs !== "number" || typeof endMs !== "number" || endMs <= startMs) {
    return "";
  }
  return formatDuration(endMs - startMs);
}

function renderTurnWorkItems(events) {
  const assistantEvents = events.filter((event) => event.type === "assistant_message");
  const reasoningEvents = events.filter((event) => event.type === "reasoning");
  const planEvents = events.filter((event) => event.type === "plan");
  const commandEvents = events.filter((event) => event.type === "command_execution");
  const fileChangeEvents = events.filter((event) => event.type === "file_change");
  const failureEvents = events.filter((event) => event.type === "task_failed");
  const knownEvents = new Set([
    ...assistantEvents,
    ...reasoningEvents,
    ...planEvents,
    ...commandEvents,
    ...fileChangeEvents,
    ...failureEvents,
  ]);
  const unknownEvents = events.filter((event) => !knownEvents.has(event));

  return [
    ...assistantEvents.map(renderTurnWorkItem),
    renderCombinedReasoningWorkItem(reasoningEvents),
    renderLatestPlanWorkItem(planEvents),
    ...commandEvents.map(renderTurnWorkItem),
    renderCombinedFileChangeWorkItem(fileChangeEvents),
    ...failureEvents.map(renderTurnWorkItem),
    ...unknownEvents.map(renderTurnWorkItem),
  ]
    .filter(Boolean)
    .join("");
}

function renderLatestPlanWorkItem(events) {
  return events.length ? renderTurnWorkItem(latestEvent(events)) : "";
}

function renderCombinedReasoningWorkItem(events) {
  if (!events.length) {
    return "";
  }
  const text = events
    .map((event) => {
      const payload = event.payload ?? {};
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter(Boolean).join("\n\n")
        : "";
      const content = Array.isArray(payload.content)
        ? payload.content.filter(Boolean).join("\n\n")
        : "";
      return [summary, content].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return renderTurnWorkItemShell(latestEvent(events), "Thinking", text);
}

function renderCombinedFileChangeWorkItem(events) {
  if (!events.length) {
    return "";
  }

  const latest = latestEvent(events);
  const payload = latest.payload ?? {};
  const latestCount =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : null;
  const latestSummary =
    typeof latestCount === "number"
      ? latestCount === 1
        ? "Latest: 1 changed file"
        : `Latest: ${latestCount} changed files`
      : "";
  const status = payload.status ? `Latest status: ${formatStatus(payload.status)}` : "";
  const updateText =
    events.length === 1
      ? "1 file change update"
      : `${events.length} file change updates`;

  return renderFileChangeWorkItemShell(
    latest,
    [updateText, latestSummary, status].filter(Boolean).join("\n"),
    fileChangePaths(events),
  );
}

function latestEvent(events) {
  return events.reduce((latest, event) =>
    (event.createdMs ?? 0) >= (latest.createdMs ?? 0) ? event : latest,
  );
}

function renderTurnWorkItem(event) {
  const payload = event.payload ?? {};
  const dataType = escapeHtml(event.type);
  if (event.type === "assistant_message") {
    return renderTurnWorkItemShell(event, "Update", payload.text);
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderTurnWorkItemShell(event, "Thinking", [summary, content].filter(Boolean).join("\n\n"));
  }
  if (event.type === "plan") {
    return renderTurnWorkItemShell(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    const command = `${payload.command ?? ""}`.trim();
    const cwd = `${payload.cwd ?? ""}`.trim();
    const status = `${payload.status ?? ""}`.trim();
    const output = `${payload.aggregatedOutput ?? ""}`.trim();
    const open = status && status !== "completed" ? " open" : "";
    return `
      <article class="task-work-item task-work-command" data-event-type="command_execution" data-command-status="${escapeHtml(status || "unknown")}">
        <details${open}>
          <summary>
            <strong>Command</strong>
            ${status ? `<span>${escapeHtml(formatStatus(status))}</span>` : ""}
            <time>${escapeHtml(formatDate(event.createdMs))}</time>
          </summary>
          <div class="task-work-command-body">
            ${command ? `<code>$ ${escapeHtml(command)}</code>` : ""}
            ${cwd ? `<span>cwd: ${escapeHtml(cwd)}</span>` : ""}
            ${output ? `<pre>${escapeHtml(output)}</pre>` : ""}
          </div>
        </details>
      </article>
    `;
  }
  if (event.type === "file_change") {
    const count =
      typeof payload.changeCount === "number"
        ? payload.changeCount
        : Array.isArray(payload.changes)
          ? payload.changes.length
          : 0;
    const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
    const summary = count === 1 ? "1 changed file" : `${count} changed files`;
    return renderFileChangeWorkItemShell(
      event,
      [summary, status].filter(Boolean).join("\n"),
      fileChangePaths([event]),
    );
  }
  if (event.type === "task_failed") {
    return renderTurnWorkItemShell(event, "Error", event.summary, "danger");
  }
  return `
    <article class="task-work-item" data-event-type="${dataType}">
      <header>
        <strong>${escapeHtml(event.summary)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
    </article>
  `;
}

function renderTurnWorkItemShell(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-item" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
    </article>
  `;
}

function renderFileChangeWorkItemShell(event, text, paths) {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-item" data-event-type="file_change" data-tool-tone="neutral">
      <header>
        <strong>Files changed</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
      ${renderChangedFilePaths(paths)}
    </article>
  `;
}

function renderToolEvent(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }

  return `
    <li class="task-event task-tool-card" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      <pre>${escapeHtml(value)}</pre>
    </li>
  `;
}

function renderCommandEvent(event) {
  const payload = event.payload ?? {};
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const status = `${payload.status ?? ""}`.trim();
  const output = `${payload.aggregatedOutput ?? ""}`.trim();
  const details = [
    command ? `$ ${command}` : "",
    cwd ? `cwd: ${cwd}` : "",
    status ? `status: ${status}` : "",
    output,
  ]
    .filter(Boolean)
    .join("\n");
  const open = status && status !== "completed" ? " open" : "";
  return `
    <li class="task-event task-command" data-event-type="${escapeHtml(event.type)}" data-command-status="${escapeHtml(status || "unknown")}">
      <details${open}>
        <summary>
          <span>Command</span>
          ${status ? `<span>${escapeHtml(formatStatus(status))}</span>` : ""}
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <pre>${escapeHtml(details || "(command unavailable)")}</pre>
      </details>
    </li>
  `;
}

function renderFileChangeEvent(event) {
  const payload = event.payload ?? {};
  const count =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : 0;
  const status = payload.status ? `Status: ${formatStatus(payload.status)}` : "";
  const summary = count === 1 ? "1 changed file" : `${count} changed files`;
  return `
    <li class="task-event task-file-change" data-event-type="${escapeHtml(event.type)}">
      <article>
        <header>
          <strong>Files changed</strong>
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </header>
        <p>${escapeHtml(summary)}${status ? ` · ${status}` : ""}</p>
        ${renderChangedFilePaths(fileChangePaths([event]))}
      </article>
    </li>
  `;
}

function renderChangedFilePaths(paths) {
  if (!paths.length) {
    return "";
  }

  return `
    <ul class="task-changed-files" aria-label="Changed files">
      ${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}
    </ul>
  `;
}

function latestTaskRelatedWorktreePaths(events, task) {
  const groups = conversationGroups(dedupeCanonicalEvents(events));
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (group.kind !== "turn") {
      continue;
    }

    const paths = uniquePaths(
      fileChangePaths(group.events)
        .map((path) => taskFileWorktreePath(path, task))
        .filter(Boolean),
    );
    if (paths.length) {
      return paths;
    }
  }
  return [];
}

function fileChangePaths(events) {
  return uniquePaths(
    events.flatMap((event) => {
      if (event?.type !== "file_change" || !Array.isArray(event.payload?.changes)) {
        return [];
      }
      return event.payload.changes
        .map((change) => normalizeTaskPath(typeof change === "string" ? change : change?.path))
        .filter(Boolean);
    }),
  );
}

function taskFileWorktreePath(path, task) {
  const rawPath = normalizeTaskPath(path);
  if (!rawPath) {
    return "";
  }

  const cwd = normalizeTaskPath(task?.cwd);
  const relativeCwd = cleanRelativeTaskPath(task?.worktree?.relativeCwd);
  let relativePath = rawPath;

  if (cwd && (rawPath === cwd || rawPath.startsWith(`${cwd}/`))) {
    relativePath = rawPath.slice(cwd.length).replace(/^\/+/, "");
  } else {
    relativePath = rawPath.replace(/^\/+/, "");
  }

  if (
    relativeCwd &&
    relativePath !== relativeCwd &&
    !relativePath.startsWith(`${relativeCwd}/`)
  ) {
    relativePath = `${relativeCwd}/${relativePath}`;
  }

  return cleanRelativeTaskPath(relativePath);
}

function taskWorktreeRef(task) {
  const branch = `${task?.worktree?.branch ?? ""}`.trim();
  if (branch) {
    return branch;
  }
  return shortId(task?.worktree?.headSha ?? "");
}

function cleanLogicalPath(path) {
  return cleanRelativeTaskPath(path);
}

function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function taskThreadId(task) {
  return `${task?.threadId ?? task?.id ?? ""}`;
}

function taskUpdatedMs(task) {
  const value = Number(task?.recencyMs ?? task?.updatedMs ?? task?.createdMs ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function taskRepositoryPath(task) {
  return cleanLogicalPath(
    task?.worktree?.repositoryRootPath ??
      task?.worktree?.rootPath ??
      task?.cwdPath ??
      task?.cwd ??
      task?.relativeCwd,
  );
}

function taskRepositoryKey(task) {
  const prefix = task?.worktree ? "repository" : "cwd";
  return `${prefix}:${taskRepositoryPath(task)}`;
}

function taskRepositoryLabel(task) {
  const path = taskRepositoryPath(task);
  return path.split("/").filter(Boolean).at(-1) ?? "Directory";
}

function sortTasksByRecency(tasks) {
  return [...tasks].sort((left, right) => taskUpdatedMs(right) - taskUpdatedMs(left));
}

function groupTasksByRepository(tasks) {
  const groupsByKey = new Map();
  for (const task of tasks) {
    const key = taskRepositoryKey(task);
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.tasks.push(task);
      existing.updatedMs = Math.max(existing.updatedMs, taskUpdatedMs(task));
      continue;
    }
    const rootPath = taskRepositoryPath(task);
    groupsByKey.set(key, {
      key,
      label: taskRepositoryLabel(task),
      rootPath,
      repository: Boolean(task?.worktree),
      updatedMs: taskUpdatedMs(task),
      tasks: [task],
    });
  }

  return [...groupsByKey.values()]
    .map((group) => ({
      ...group,
      tasks: sortTasksByRecency(group.tasks),
    }))
    .sort((left, right) => right.updatedMs - left.updatedMs);
}

function taskWorktreeRootName(task) {
  const rootPath = cleanRelativeTaskPath(task?.worktree?.rootPath);
  return rootPath.split("/").filter(Boolean).at(-1) ?? "Worktree";
}

function taskWorktreeLabel(task) {
  if (!task?.worktree) {
    return task?.cwdPath ?? task?.relativeCwd ?? "";
  }

  return [
    taskWorktreeRef(task),
    taskWorktreeRootName(task),
    cleanRelativeTaskPath(task.worktree.relativeCwd),
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderTaskCompareRefOptions(refs, selectedRef) {
  return refs
    .map((ref) => {
      const name = `${ref?.name ?? ""}`;
      if (!name) {
        return "";
      }
      const selected = name === selectedRef ? " selected" : "";
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    })
    .join("");
}

function normalizeTaskPath(path) {
  return `${path ?? ""}`
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function cleanRelativeTaskPath(path) {
  return normalizeTaskPath(path)
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function uniquePaths(paths) {
  return [...new Set(paths)];
}

function renderApprovalCard(event) {
  const payload = event.payload ?? {};
  const params = payload.params ?? {};
  const approvalId = payload.approvalId ?? "";
  const isCommand = payload.kind === "command";
  const decisions = params.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];

  return `
    <article class="task-approval-card">
      <header>
        <h3>${isCommand ? "Command Approval" : "File Change Approval"}</h3>
        <span>${escapeHtml(params.reason ?? "Approval requested")}</span>
      </header>
      ${
        isCommand
          ? `<pre>${escapeHtml(formatCommand(params.command))}</pre>
             <p>${escapeHtml(params.cwd ?? "")}</p>`
          : `<p>${escapeHtml(params.grantRoot ? `Grant root: ${params.grantRoot}` : "File change permission requested")}</p>`
      }
      <div class="task-approval-actions">
        ${decisions
          .filter((decision) => ["accept", "acceptForSession", "decline", "cancel"].includes(decision))
          .map(
            (decision) =>
              `<button type="button" class="task-secondary-button" data-task-action="approval" data-approval-id="${escapeHtml(approvalId)}" data-decision="${escapeHtml(decision)}">${escapeHtml(formatDecision(decision))}</button>`,
          )
          .join("")}
      </div>
    </article>
  `;
}

function pendingApprovals(events) {
  const pending = new Map();
  for (const event of events) {
    const approvalId = event.payload?.approvalId;
    if (!approvalId) {
      continue;
    }
    if (event.type === "approval_requested") {
      pending.set(approvalId, event);
    } else if (event.type === "approval_resolved") {
      pending.delete(approvalId);
    }
  }
  return [...pending.values()];
}

function upsertEvent(events, event) {
  return mergeEvents(events, [event]);
}

function mergeEvents(leftEvents, rightEvents) {
  const byId = new Map();
  for (const event of [...leftEvents, ...rightEvents]) {
    const key = eventIdentityKey(event);
    if (key) {
      byId.set(key, mergeEventRecord(byId.get(key), event));
    }
  }
  return dedupeCanonicalEvents([...byId.values()]).sort(
    (left, right) =>
      (left.createdMs ?? 0) - (right.createdMs ?? 0) ||
      `${left.id ?? ""}`.localeCompare(`${right.id ?? ""}`),
  );
}

function mergeEventRecord(existing, incoming) {
  if (!existing) {
    return incoming;
  }
  const existingPayload = existing.payload ?? {};
  const incomingPayload = incoming.payload ?? {};
  const payload = { ...existingPayload, ...incomingPayload };
  if (existingPayload.item || incomingPayload.item) {
    payload.item = {
      ...(existingPayload.item ?? {}),
      ...(incomingPayload.item ?? {}),
    };
  }
  return { ...existing, ...incoming, payload };
}

function optimisticUserMessageEvent(threadId, prompt, images, requestId) {
  const createdMs = Date.now();
  const content = [
    ...(prompt ? [{ type: "text", text: prompt }] : []),
    ...images.map((image) => ({
      type: "image",
      url: image.dataUrl,
      name: image.name,
    })),
  ];
  return {
    id: `local:user:${threadId}:${requestId}:${createdMs}`,
    threadId,
    type: "user_message",
    summary: "User prompt",
    payload: {
      text: prompt,
      item: { content },
      optimistic: true,
    },
    createdMs,
  };
}

function taskWithLiveEventState(task, event) {
  if (!task || !event) {
    return task;
  }

  const payload = event.payload ?? {};
  const createdMs = Number(event.createdMs) || Date.now();
  if (payload.lifecycle === "started" && payload.turnId) {
    return taskWithStatus(task, "running", {
      activeTurnId: payload.turnId,
      activeTurnStartedMs: task.activeTurnStartedMs ?? createdMs,
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  if (event.type === "turn_started") {
    return taskWithStatus(task, "running", {
      activeTurnId: payload.turnId ?? payload.turn?.id ?? task.activeTurnId,
      activeTurnStartedMs: createdMs,
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  if (event.type === "approval_requested") {
    return taskWithStatus(task, "waiting_for_approval", {
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  if (event.type === "approval_resolved") {
    return taskWithStatus(task, "running", {
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  if (event.type === "turn_completed") {
    const status = normalizeTurnStatus(payload.turn?.status ?? payload.status);
    return taskWithStatus(task, status, {
      activeTurnId: null,
      activeTurnStartedMs: null,
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  if (event.type === "thread_status_changed") {
    const status = normalizeThreadStatus(payload.status ?? payload.notification?.status);
    return taskWithStatus(task, status, {
      ...(status === "running"
        ? {
            activeTurnId: payload.activeTurnId ?? task.activeTurnId,
            activeTurnStartedMs:
              payload.activeTurnStartedMs ?? task.activeTurnStartedMs ?? createdMs,
          }
        : { activeTurnId: null, activeTurnStartedMs: null }),
      updatedMs: createdMs,
      recencyMs: createdMs,
    });
  }
  return task;
}

function taskWithStatus(task, status, updates = {}) {
  if (!task || !status) {
    return task;
  }
  return { ...task, ...updates, status };
}

function normalizeTurnStatus(status) {
  return {
    failed: "failed",
    interrupted: "interrupted",
    completed: "completed",
  }[`${status ?? ""}`] ?? "running";
}

function normalizeThreadStatus(status) {
  const type = typeof status === "object" ? status?.type : status;
  return {
    active: "running",
    running: "running",
    systemError: "failed",
    failed: "failed",
    idle: "idle",
    notLoaded: "notLoaded",
  }[`${type ?? ""}`] ?? "unknown";
}

function eventIdentityKey(event) {
  if (!event) {
    return "";
  }

  const payload = event.payload ?? {};
  const threadId = event.threadId ?? payload.threadId ?? "";
  const itemId = payload.itemId ?? payload.item?.id ?? "";
  if (itemId) {
    return ["item", threadId, eventTurnId(event) ?? "", itemId].join(":");
  }

  const approvalId = payload.approvalId ?? "";
  if (approvalId) {
    return ["approval", threadId, approvalId, event.type].join(":");
  }

  const turnId = eventTurnId(event);
  if (turnId && isTurnStatusEvent(event)) {
    return ["turn", threadId, turnId, event.type, payload.status ?? ""].join(":");
  }

  if (turnId && ["user_message", "assistant_message"].includes(event.type)) {
    const text = `${payload.prompt ?? payload.text ?? ""}`.trim();
    if (text) {
      return ["message", threadId, turnId, event.type, text].join(":");
    }
  }

  return event.id ?? "";
}

function dedupeCanonicalEvents(events) {
  const byKey = new Map();
  for (const event of removeSupersededOptimisticEvents(events)) {
    const key = canonicalEventKey(event) || eventIdentityKey(event);
    if (!key) {
      continue;
    }
    const existing = byKey.get(key);
    byKey.set(key, preferStructuredEvent(existing, event));
  }
  return [...byKey.values()];
}

function removeSupersededOptimisticEvents(events) {
  const confirmedUserMessages = new Set();
  for (const event of events) {
    if (event?.type !== "user_message" || event.payload?.optimistic) {
      continue;
    }
    const fingerprint = userMessageFingerprint(event);
    if (fingerprint) {
      confirmedUserMessages.add(fingerprint);
    }
  }

  return events.filter((event) => {
    if (event?.type !== "user_message" || !event.payload?.optimistic) {
      return true;
    }
    return !confirmedUserMessages.has(userMessageFingerprint(event));
  });
}

function userMessageFingerprint(event) {
  if (event?.type !== "user_message") {
    return "";
  }
  const payload = event.payload ?? {};
  const text = `${payload.prompt ?? payload.text ?? ""}`.trim();
  const content = Array.isArray(payload.item?.content) ? payload.item.content : [];
  const images = content
    .filter((item) => ["image", "localImage"].includes(item?.type))
    .map((item) => imageInputFingerprint(item));
  if (!text && !images.length) {
    return "";
  }
  return JSON.stringify([event.threadId ?? "", text, images]);
}

function imageInputFingerprint(item) {
  if (item?.type === "localImage") {
    return `local:${item.path ?? ""}`;
  }
  const value = `${item?.url ?? ""}`;
  return `data:${value.length}:${value.slice(-64)}`;
}

function canonicalEventKey(event) {
  if (!event || !["user_message", "assistant_message"].includes(event.type)) {
    return "";
  }

  if (event.payload?.optimistic) {
    return event.id ?? "";
  }

  const payload = event.payload ?? {};
  const text = `${payload.prompt ?? payload.text ?? ""}`.trim();
  if (!text) {
    return "";
  }

  const threadId = event.threadId ?? payload.threadId ?? "";
  const turnId = eventTurnId(event);
  if (turnId) {
    return ["message", threadId, turnId, event.type, text].join(":");
  }

  const createdMs = typeof event.createdMs === "number" ? event.createdMs : 0;
  const createdBucket = createdMs ? Math.floor(createdMs / 5000) : "";
  return ["message", threadId, event.type, text, createdBucket].join(":");
}

function preferStructuredEvent(existing, next) {
  if (!existing) {
    return next;
  }
  return eventStructureScore(next) >= eventStructureScore(existing) ? next : existing;
}

function eventStructureScore(event) {
  const payload = event?.payload ?? {};
  return [
    payload.itemId,
    payload.item?.id,
    payload.turnId,
    payload.threadId,
  ].filter(Boolean).length;
}

function isScrolledToBottom(element) {
  return maxScrollTop(element) - element.scrollTop <= 8;
}

function maxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

function syncComposerTextarea(textarea) {
  const styles = getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 22;
  const padding =
    (Number.parseFloat(styles.paddingTop) || 0) +
    (Number.parseFloat(styles.paddingBottom) || 0);
  const maxRows = Number.parseFloat(textarea.dataset.maxRows ?? "10.5") || 10.5;
  const maxHeight = lineHeight * maxRows + padding;

  textarea.style.height = "auto";
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(`${reader.result ?? ""}`), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image")), {
      once: true,
    });
    reader.readAsDataURL(file);
  });
}

function imageExtension(type) {
  return {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[type] ?? "png";
}

function upsertTask(tasks, task) {
  const threadId = task.threadId ?? task.id;
  const existing = tasks.filter((entry) => (entry.threadId ?? entry.id) !== threadId);
  existing.unshift(task);
  return existing;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function renderTaskRowMeta(task, unseen = false) {
  const status = normalizeTaskStatus(task.status);
  if (status && status !== "completed" && taskStatusView(status)) {
    return renderTaskStatusChip(status, "task-row-meta", { label: false });
  }
  if (unseen) {
    return `
      <span
        class="task-row-meta task-unseen-complete"
        title="Completed - not viewed"
        aria-label="Completed - not viewed"
      ></span>
    `;
  }

  const ms = task.recencyMs ?? task.updatedMs;
  const date = new Date(Number(ms));
  const dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
  return `
    <time class="task-row-meta task-row-time" datetime="${escapeHtml(dateTime)}">
      ${escapeHtml(formatRelativeAge(ms))}
    </time>
  `;
}

function renderTaskStatusChip(status, className = "", options = {}) {
  const view = taskStatusView(status);
  if (!view) {
    return "";
  }
  const showLabel = options.label !== false;

  const classes = ["task-status-chip", className].filter(Boolean).join(" ");
  const icon = view.status === "running"
    ? `<span class="task-status-spinner" aria-hidden="true"></span><span class="sr-only">${escapeHtml(view.label)}</span>`
    : renderInlineIcon(view.icon, view.label, "task-status-icon");
  return `
    <span
      class="${escapeHtml(classes)}"
      data-status="${escapeHtml(view.status)}"
      title="${escapeHtml(view.label)}"
      aria-label="${escapeHtml(view.label)}"
    >
      ${icon}
      ${showLabel ? `<span class="task-status-label">${escapeHtml(view.label)}</span>` : ""}
    </span>
  `;
}

function taskStatusView(status) {
  const normalized = normalizeTaskStatus(status);
  return {
    running: { status: "running", label: "running", icon: "" },
    waiting_for_approval: {
      status: "waiting_for_approval",
      label: "approval",
      icon: "CircleAlert",
    },
    failed: { status: "failed", label: "failed", icon: "TriangleAlert" },
    interrupted: { status: "interrupted", label: "interrupted", icon: "CircleSlash" },
    completed: { status: "completed", label: "completed", icon: "CircleCheck" },
  }[normalized] ?? null;
}

function normalizeTaskStatus(status) {
  return `${status ?? ""}`.trim();
}

function isTaskCompletionStatus(status) {
  return ["", "completed", "idle", "notLoaded"].includes(normalizeTaskStatus(status));
}

function readTaskSeenState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_SEEN_STORAGE_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && parsed.versions) {
      return {
        initialized: Boolean(parsed.initialized),
        versions: { ...parsed.versions },
      };
    }
  } catch {
    // Treat unavailable or invalid local storage as a fresh local view state.
  }
  return { initialized: false, versions: {} };
}

function writeTaskSeenState(state) {
  try {
    const versions = Object.fromEntries(
      Object.entries(state.versions)
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 1_000),
    );
    state.versions = versions;
    localStorage.setItem(
      TASK_SEEN_STORAGE_KEY,
      JSON.stringify({ initialized: true, versions }),
    );
  } catch {
    // The indicator remains session-local when storage is unavailable.
  }
}

function hasSeenTaskVersion(state, threadId) {
  return Object.hasOwn(state.versions, threadId);
}

function rememberTaskVersion(state, task) {
  const threadId = taskThreadId(task);
  const version = taskUpdatedMs(task);
  if (!threadId || !version || Number(state.versions[threadId]) >= version) {
    return false;
  }
  state.versions[threadId] = version;
  return true;
}

function formatStatus(status) {
  const normalized = normalizeTaskStatus(status);
  if (normalized === "notLoaded") {
    return "ready";
  }
  return `${normalized || "unknown"}`.replaceAll("_", " ");
}

function formatRelativeAge(ms, now = Date.now()) {
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "";
  }

  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) {
    return "now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }

  return `${Math.floor(months / 12)}y`;
}

function formatDecision(decision) {
  return {
    accept: "Accept",
    acceptForSession: "Accept for Session",
    decline: "Decline",
    cancel: "Cancel",
  }[decision] ?? decision;
}

function formatCommand(command) {
  if (Array.isArray(command)) {
    return command.join(" ");
  }
  if (typeof command === "string" && command.trim()) {
    return command;
  }
  if (command && typeof command === "object") {
    return JSON.stringify(command);
  }
  return "(command unavailable)";
}

function shortId(id) {
  return `${id ?? ""}`.slice(0, 8);
}

function formatDate(ms) {
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(Number(ms) / 1000));
  if (!Number.isFinite(seconds)) {
    return "";
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function statusTone(type) {
  if (type === "task_failed" || type === "turn_interrupted") {
    return "danger";
  }
  if (type === "approval_requested") {
    return "warning";
  }
  return "muted";
}
