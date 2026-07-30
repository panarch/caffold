import {
  createTask,
  getCodexModels,
  getCodexPermissions,
  getGitHubStatus,
  getGitStatus,
  getTask,
  interruptTask,
  resolveTaskApproval,
  sendTaskPrompt,
  taskStreamUrl,
} from "../../../api.js";
import { escapeHtml } from "../../../components/dom.js";
import "../../../components/file-browser.js";
import "../../../components/git-compare-browser.js";
import "../../../components/git-diff-browser.js";
import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import { createRefreshCoordinator, subscribeToWatch } from "../../../watch.js";
import "./components/markdown.js";
import "./components/navigator.js";
import {
  PROMPT_SUBMISSION_STATE,
  TASK_TRANSPORT_STATE,
  classifyPromptFailure,
  formatTaskStatus,
  isTaskActivelyWorking,
  isTaskTransportStale,
  promptSubmissionState,
  taskActiveFlagLabel,
  taskStatusView,
  taskThreadStatusType,
  withPromptSubmissionState,
} from "./runtime-state.js";
import {
  assistantMessagePhase,
  canAcceptTurnContinuation,
  conversationGroups,
  dedupeCanonicalEvents,
  eventIdentityKey,
  eventTurnId,
  isFinalAssistantEvent,
  isImplicitTurnEvent,
  isTerminalTurnEvent,
  isTurnContinuationEvent,
  isTurnStatusEvent,
  isWorkEvent,
  mergeEvents,
  mergeTaskEventsPage,
  optimisticUserMessageEvent,
  pendingApprovals,
  upsertEvent,
  userMessageFingerprint,
} from "./task-events.js";
import {
  cleanLogicalPath,
  cleanRelativeTaskPath,
  formatCommand,
  formatDate,
  formatDecision,
  formatDuration,
  formatStatus,
  normalizeTaskPath,
  shortId,
  uniquePaths,
} from "./task-format.js";
import {
  taskDetailThreadId,
  taskThreadId,
  taskWorktreeLabel,
  taskWorktreeRootName,
} from "./task-list-model.js";

const STREAM_ERROR_DELAY_MS = 8_000;
const TASK_LIST_DEFAULT_WIDTH = 380;
const TASK_LIST_MIN_WIDTH = 280;
const TASK_LIST_MAX_WIDTH = 520;
const TASK_DETAIL_MIN_WIDTH = 520;
const TASK_LIST_RESIZER_WIDTH = 6;
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
    this.syncActiveTurnClock();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.view = "list";
    this.taskListWidth = TASK_LIST_DEFAULT_WIDTH;
    this.taskDetail = null;
    this.taskDetailRevisionByThread = new Map();
    this.taskGithubStatus = null;
    this.taskGithubStatusPath = "";
    this.taskGithubStatusState = "idle";
    this.taskGithubStatusRequestId = 0;
    this.events = [];
    this.eventsThreadId = "";
    this.eventsByThread = new Map();
    this.eventsPage = { nextCursor: null };
    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.loading = false;
    this.loadingOlderEvents = false;
    this.newTaskCwd = "";
    this.defaultCwdPath = "";
    this.newTaskBrowsing = false;
    this.selectedThreadId = "";
    this.stream = null;
    this.streamState = TASK_TRANSPORT_STATE.IDLE;
    this.streamGeneration = 0;
    this.streamErrorTimer = null;
    this.activeTurnClockTimer = null;
    this.taskRefresh = null;
    this.requestId = 0;
    this.initialConversationScrollRequest = null;
    this.conversationScrollMode = null;
    this.conversationScrollByThread = new Map();
    this.conversationResizeObserver = null;
    this.conversationDisclosureByThread = new Map();
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
    this.composerSettingsByThread = new Map();
    this.composerSettingsOverrideThreadIds = new Set();
    this.permissionOptions = [];
    this.permissionOptionsCwd = "";
    this.permissionOptionsLoaded = false;
    this.permissionOptionsLoading = false;
    this.permissionOptionsError = null;
    this.permissionOptionsRequestId = 0;
    this.defaultPermissionMode = "askForApproval";
    this.newTaskPermissionMode = "";
    this.newTaskPermissionExplicit = false;
    this.permissionModeByThread = new Map();
    this.permissionOverrideThreadIds = new Set();
    this.composerSettings = {
      model: "",
      effort: "",
    };
    this.openModelPickerForm = "";
    this.openPermissionPickerForm = "";
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
      this.render();
    };
    this.boundTaskListResize = () => {
      this.clampTaskListWidth();
      this.fitModelPicker();
    };
    this.boundVisibilityChange = () => this.handleVisibilityChange();
    this.boundTaskListPointerMove = (event) => this.resizeTaskList(event);
    this.boundTaskListPointerUp = () => this.stopTaskListResize();
    warmIcons();

    this.addEventListener(
      "click",
      (event) => {
        if (closestElement(event.target, "caffold-task-navigator")) {
          return;
        }
        this.handleConversationDisclosureClick(event);
        const reviewMenu = closestElement(event.target, ".task-review-menu");
        for (const menu of this.querySelectorAll(".task-review-menu[open]")) {
          if (menu !== reviewMenu) {
            menu.removeAttribute("open");
          }
        }
        const action = closestElement(event.target, "[data-task-action]");
        if (!action) {
          if (
            !closestElement(
              event.target,
              ".task-model-picker, .task-permission-picker",
            )
          ) {
            window.setTimeout(() => this.closeComposerPickers(), 0);
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
    this.addEventListener("caffold:task-navigator-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "select-task") {
        this.requestRoute({ kind: "tasks", threadId: event.detail.threadId });
      } else if (event.detail?.type === "new-task") {
        this.requestRoute({ kind: "tasks", new: true, cwd: this.activeCwdPath() });
      }
    });
    this.addEventListener("caffold:task-continued", (event) => {
      event.stopPropagation();
      const threadId = taskThreadId(event.detail?.task);
      if (!threadId) {
        return;
      }
      if (taskDetailThreadId(this.taskDetail) === threadId) {
        this.taskDetail = null;
      }
      this.requestRoute({ kind: "tasks", threadId });
    });
    this.addEventListener("caffold:task-continuation-change", (event) => {
      event.stopPropagation();
      if (
        event.detail?.threadId === this.selectedThreadId &&
        this.taskDetail?.managed === false
      ) {
        this.render();
      }
    });
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
        const formName = form.dataset.taskForm;
        void this.handleForm(formName, form).catch((error) => {
          if (formName === "create") {
            this.loading = false;
          } else if (formName === "follow-up") {
            const threadId = `${form.dataset.threadId ?? ""}`.trim();
            if (this.followUpRequest?.threadId === threadId) {
              this.followUpRequest = null;
            }
          }
          this.error = error instanceof Error ? error : new Error(`${error}`);
          this.render();
        });
      },
      true,
    );
    this.render();
  }

  disconnectedCallback() {
    this.detachGlobalListeners();
    this.stopTaskListResize();
    this.closeStream();
    this.disconnectConversationResizeObserver();
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

  prepareRoute(route, options = {}) {
    this.ensureRendered();
    if (
      options.preserveLoadedTask &&
      route?.threadId &&
      this.selectedThreadId === route.threadId &&
      taskDetailThreadId(this.taskDetail) === route.threadId
    ) {
      this.view = "detail";
      this.error = null;
      this.detailLoadError = null;
      this.activateThreadEvents(route.threadId);
      this.setAttribute("data-tasks-view", this.view);
      this.taskNavigator()?.setSelectedThreadId(route.threadId);
      return;
    }

    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
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
        taskDetailThreadId(this.taskDetail) === route.threadId ? this.taskDetail : null;
      this.eventsPage =
        taskDetailThreadId(this.taskDetail) === route.threadId
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
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
    this.render();
  }

  async openRoute(route, options = {}) {
    this.newTaskCwd = route?.new ? route.cwd ?? "" : "";
    this.defaultCwdPath = options.defaultCwdPath ?? this.defaultCwdPath;
    this.prepareRoute(route, options);
    if (route?.new) {
      return this.openNew();
    }
    if (route?.threadId) {
      if (
        options.preserveLoadedTask &&
        taskDetailThreadId(this.taskDetail) === route.threadId
      ) {
        this.loading = false;
        this.loadTaskGithubStatus(this.taskDetail.task);
        this.loadModelOptions();
        this.observeTaskSettings(this.taskDetail);
        this.loadPermissionOptions(this.activeCwdPath());
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
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.view = "list";
    this.render();
    return await this.taskNavigator()?.activate({ force: true });
  }

  openNew() {
    this.view = "new";
    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.loading = false;
    this.openModelPickerForm = "";
    this.openPermissionPickerForm = "";
    this.closeStream();
    this.render();
    void this.taskNavigator()?.activate();
    this.loadModelOptions();
    this.loadPermissionOptions(this.activeCwdPath());
    this.querySelector("textarea[name='prompt']")?.focus();
    return null;
  }

  async openTask(threadId) {
    if (!threadId) {
      return null;
    }

    const requestId = ++this.requestId;
    this.initialConversationScrollRequest = this.conversationScrollSnapshot(threadId)
      ? null
      : { threadId, requestId };
    this.view = "detail";
    this.selectedThreadId = threadId;
    this.loading = true;
    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.render();
    void this.taskNavigator()?.activate();
    this.connectStream(threadId);

    try {
      const detail = await getTask(threadId);
      if (requestId !== this.requestId) {
        return null;
      }
      if (
        taskDetailThreadId(detail) !== threadId ||
        !this.acceptTaskDetailRevision(threadId, detail.revision)
      ) {
        this.finishInitialConversationScroll(threadId, requestId);
        return null;
      }
      this.acknowledgeFollowUpFromCanonicalDetail(threadId, detail);
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(
        threadId,
        mergeEvents(this.eventsByThread.get(threadId) ?? [], detail.events ?? []),
      );
      this.eventsPage = mergeTaskEventsPage(this.eventsPage, detail);
      this.loading = detail.syncState === "loading";
      this.detailLoadError = null;
      this.historyLoadError = null;
      if (detail.managed === false) {
        this.closeStream();
        this.render();
        this.finishInitialConversationScroll(threadId, requestId);
        return detail;
      }
      if (detail.task) {
        this.taskNavigator()?.upsertCanonicalTask({ ...detail.task, unseen: false });
      }
      this.conversationScrollMode = this.isInitialConversationScrollPending(threadId)
        ? "bottom"
        : this.conversationScrollSnapshot(threadId)
          ? "preserve"
          : "bottom";
      this.render();
      this.finishInitialConversationScroll(threadId, requestId);
      this.loadTaskGithubStatus(detail.task);
      this.loadModelOptions();
      this.loadPermissionOptions(this.activeCwdPath());
      return detail;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loading = false;
      this.detailLoadError = error;
      this.render();
      this.finishInitialConversationScroll(threadId, requestId);
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

  connectStream(threadId) {
    this.closeStream();
    if (!("EventSource" in window)) {
      this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }

    const generation = this.streamGeneration;
    let stream;
    try {
      stream = new EventSource(taskStreamUrl(threadId));
    } catch {
      this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }

    this.stream = stream;
    this.streamState = TASK_TRANSPORT_STATE.CONNECTING;
    stream.addEventListener("open", () => {
      if (!this.isCurrentStream(stream, threadId, generation)) {
        return;
      }
      const shouldSync = isTaskTransportStale(this.streamState);
      window.clearTimeout(this.streamErrorTimer);
      this.streamErrorTimer = null;
      if (shouldSync) {
        this.requestSelectedTaskRefresh(threadId, generation);
        return;
      }
      this.setStreamState(TASK_TRANSPORT_STATE.READY);
    });
    stream.addEventListener("error", () => {
      if (!this.isCurrentStream(stream, threadId, generation)) {
        return;
      }
      window.clearTimeout(this.streamErrorTimer);
      if (stream.readyState === 2) {
        this.streamErrorTimer = null;
        this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE);
        return;
      }
      this.setStreamState(TASK_TRANSPORT_STATE.RECONNECTING);
      this.streamErrorTimer = window.setTimeout(() => {
        if (
          this.isCurrentStream(stream, threadId, generation) &&
          this.streamState === TASK_TRANSPORT_STATE.RECONNECTING
        ) {
          this.streamErrorTimer = null;
          this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE);
        }
      }, STREAM_ERROR_DELAY_MS);
    });
    stream.addEventListener("task-sync", (event) => {
      const message = parseJson(event.data);
      const detail = message?.detail;
      if (
        message?.reason === "external-sync-start" ||
        !this.isCurrentStream(stream, threadId, generation) ||
        message?.threadId !== threadId ||
        taskDetailThreadId(detail) !== threadId
      ) {
        return;
      }
      this.applyTaskDetailSync(threadId, detail, message.revision, {
        resetRevision: message.reason === "stream-bootstrap",
        error: message.error,
      });
    });
    stream.addEventListener("task-event", (event) => {
      const message = parseJson(event.data);
      const entry = message?.event;
      if (
        !this.isCurrentStream(stream, threadId, generation) ||
        message?.threadId !== threadId ||
        !entry ||
        entry.threadId !== this.selectedThreadId ||
        !this.acceptTaskDetailRevision(threadId, message.revision)
      ) {
        return;
      }
      this.setThreadEvents(threadId, upsertEvent(this.events, entry));
      this.conversationScrollMode = this.liveConversationScrollMode(threadId);
      this.render();
    });
  }

  applyTaskDetailSync(
    threadId,
    detail,
    revision,
    { resetRevision = false, error = null } = {},
  ) {
    if (threadId !== this.selectedThreadId) {
      return;
    }
    if (resetRevision) {
      // Session revisions are process-local, so a reconnect after a server
      // restart can authoritatively bootstrap at a lower revision.
      this.taskDetailRevisionByThread.delete(threadId);
    }
    if (!this.acceptTaskDetailRevision(threadId, revision ?? detail?.revision)) {
      return;
    }
    this.acknowledgeFollowUpFromCanonicalDetail(threadId, detail);
    this.taskDetail = detail;
    this.observeTaskSettings(detail);
    this.loading = detail?.syncState === "loading" && !error;
    this.detailLoadError = error ? new Error(error) : null;
    this.setThreadEvents(
      threadId,
      mergeEvents(this.eventsByThread.get(threadId) ?? [], detail.events ?? []),
    );
    this.eventsPage = mergeTaskEventsPage(this.eventsPage, detail);
    if (detail?.task) {
      this.taskNavigator()?.upsertCanonicalTask(detail.task);
    }
    this.loadTaskGithubStatus(detail.task);
    this.conversationScrollMode = this.liveConversationScrollMode(threadId);
    if (error && isTaskTransportStale(this.streamState)) {
      this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE, { render: false });
    } else if (detail?.syncState === "ready" && detail?.task) {
      this.markStreamReadyFromCanonical(threadId);
    }
    this.render();
  }

  acknowledgeFollowUpFromCanonicalDetail(threadId, detail) {
    const request = this.followUpRequest;
    if (!request || request.threadId !== threadId) {
      return;
    }

    const confirmedEvent = (detail?.events ?? []).find((event) => {
      if (
        event?.type !== "user_message" ||
        event.payload?.optimistic ||
        userMessageFingerprint(event) !== request.fingerprint
      ) {
        return false;
      }
      return !request.canonicalEventIds.has(event.id);
    });
    if (!confirmedEvent) {
      return;
    }

    request.state = PROMPT_SUBMISSION_STATE.ACCEPTED;
    if (this.followUpRequest === request) {
      this.followUpRequest = null;
    }
  }

  acceptTaskDetailRevision(threadId, revision) {
    return this.acceptTaskRevision(this.taskDetailRevisionByThread, threadId, revision);
  }

  acceptTaskRevision(revisions, threadId, revision) {
    const value = Number(revision);
    if (!threadId || !Number.isFinite(value) || value <= 0) {
      return true;
    }
    const current = revisions.get(threadId) ?? 0;
    if (value < current) {
      return false;
    }
    revisions.set(threadId, value);
    return true;
  }

  closeStream() {
    this.streamGeneration += 1;
    window.clearTimeout(this.streamErrorTimer);
    this.streamErrorTimer = null;
    this.stream?.close();
    this.stream = null;
    this.streamState = TASK_TRANSPORT_STATE.IDLE;
    this.taskRefresh = null;
  }

  isCurrentStream(stream, threadId, generation) {
    return (
      this.stream === stream &&
      this.streamGeneration === generation &&
      this.selectedThreadId === threadId
    );
  }

  setStreamState(state, { render = true } = {}) {
    if (this.streamState === state) {
      return;
    }
    const wasVisible = isVisibleStreamState(this.streamState);
    this.streamState = state;
    if (
      render &&
      this.view === "detail" &&
      (wasVisible || isVisibleStreamState(state))
    ) {
      this.render();
    }
  }

  markStreamReadyFromCanonical(threadId) {
    if (
      threadId === this.selectedThreadId &&
      this.stream?.readyState === 1 &&
      isTaskTransportStale(this.streamState)
    ) {
      window.clearTimeout(this.streamErrorTimer);
      this.streamErrorTimer = null;
      this.setStreamState(TASK_TRANSPORT_STATE.READY, { render: false });
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
      const detail = await getTask(threadId);
      if (
        requestId !== this.requestId ||
        generation !== this.streamGeneration ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      if (taskDetailThreadId(detail) !== threadId) {
        return;
      }
      if (!this.acceptTaskDetailRevision(threadId, detail.revision)) {
        return;
      }
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(threadId, mergeEvents(this.events, detail.events ?? []));
      this.eventsPage = mergeTaskEventsPage(this.eventsPage, detail);
      if (detail.task) {
        this.taskNavigator()?.upsertCanonicalTask(detail.task);
      }
      this.loadTaskGithubStatus(detail.task);
      this.conversationScrollMode = this.liveConversationScrollMode(threadId);
      if (detail?.syncState === "ready" && detail?.task) {
        this.markStreamReadyFromCanonical(threadId);
      }
      this.render();
    } catch {
      if (
        generation === this.streamGeneration &&
        threadId === this.selectedThreadId &&
        isTaskTransportStale(this.streamState)
      ) {
        this.setStreamState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      }
    }
  }

  handleAction(action, element) {
    if (
      !action?.startsWith("select-") &&
      action !== "toggle-model-picker" &&
      action !== "close-model-picker" &&
      action !== "toggle-permission-picker" &&
      action !== "close-permission-picker"
    ) {
      this.closeComposerPickers();
    }
    if (action === "open-list") {
      this.requestRoute({ kind: "tasks" });
      return;
    }
    if (action === "open-new") {
      this.requestRoute({ kind: "tasks", new: true, cwd: this.activeCwdPath() });
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
    if (action === "continue-history-task") {
      void this.taskNavigator()?.continueThread(element.dataset.threadId);
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
      this.requestRoute({ kind: "tasks", new: true, cwd });
      return;
    }
    if (action === "retry-stream") {
      if (this.selectedThreadId) {
        this.connectStream(this.selectedThreadId);
        this.render();
      }
      return;
    }
    if (action === "retry-task-detail") {
      if (this.selectedThreadId) {
        this.openTask(this.selectedThreadId);
      }
      return;
    }
    if (action === "retry-task-history") {
      this.loadOlderEvents({ retry: true });
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
      this.selectModel(element.dataset.formName, element.dataset.model);
      return;
    }
    if (action === "select-effort") {
      this.openModelPickerForm = "";
      this.selectEffort(element.dataset.formName, element.dataset.effort);
      return;
    }
    if (action === "toggle-permission-picker") {
      this.togglePermissionPicker(element.dataset.formName);
      return;
    }
    if (action === "close-permission-picker") {
      this.closePermissionPicker();
      return;
    }
    if (action === "select-permission") {
      this.selectPermissionMode(element.dataset.formName, element.dataset.permissionMode);
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
    if (!this.taskNavigator()?.isTransportAvailable()) {
      this.error = new Error(
        "Caffold server is unavailable. Wait for the task list to reconnect.",
      );
      this.render();
      return;
    }
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
        ...this.turnOptions("create"),
      });
      this.acceptTaskDetailRevision(detail?.task?.threadId, detail?.revision);
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(detail.task.threadId, detail.events ?? []);
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.taskNavigator()?.upsertCanonicalTask(detail.task);
      this.newTaskDraft = { prompt: "" };
      this.newTaskImages = [];
      this.newTaskPermissionMode = this.defaultPermissionMode;
      this.newTaskPermissionExplicit = false;
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
    if (isTaskTransportStale(this.streamState)) {
      this.error = new Error(
        "Caffold server is unavailable. Wait for the task to reconnect.",
      );
      this.render();
      return;
    }
    if (this.followUpRequest?.threadId === threadId) {
      return;
    }

    const textarea = promptTextareaForForm(form);
    if (!textarea) {
      this.error = new Error("Could not find the task prompt field.");
      this.render();
      return;
    }
    const restoreComposerFocus = form.contains(document.activeElement);

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

    this.error = null;

    const optimisticEvent = optimisticUserMessageEvent(
      threadId,
      prompt,
      images,
      this.requestId + 1,
    );
    const previousTask =
      taskThreadId(this.taskDetail?.task) === threadId
        ? this.taskDetail.task
        : null;
    const turnOptions = this.turnOptions("follow-up");
    const requestId = ++this.requestId;
    const followUpRequest = {
      requestId,
      threadId,
      fingerprint: userMessageFingerprint(optimisticEvent),
      canonicalEventIds: new Set(
        (this.eventsByThread.get(threadId) ?? [])
          .filter(
            (event) =>
              event?.type === "user_message" && !event.payload?.optimistic,
          )
          .map((event) => event.id)
          .filter(Boolean),
      ),
      state: PROMPT_SUBMISSION_STATE.SENDING,
    };
    this.followUpRequest = followUpRequest;

    try {
      textarea.value = "";
      this.setThreadEvents(
        threadId,
        mergeEvents(this.eventsByThread.get(threadId) ?? [], [optimisticEvent]),
      );
      this.followUpDraft = "";
      this.followUpDraftByThread.set(threadId, "");
      this.followUpImages = [];
      this.followUpImagesByThread.set(threadId, []);
      this.composerImageErrors.delete("follow-up");
      this.conversationScrollMode = "bottom";
      this.render();

      const response = await sendTaskPrompt(
        threadId,
        prompt,
        {
          ...turnOptions,
          activeTurnId: isTaskActivelyWorking(previousTask)
            ? previousTask?.activeTurn?.id ?? null
            : null,
        },
        images.map((image) => image.dataUrl),
      );
      if (response?.threadId !== threadId) {
        throw new Error("Codex accepted the prompt for a different task.");
      }
      followUpRequest.state = PROMPT_SUBMISSION_STATE.ACCEPTED;
      this.setThreadEvents(
        threadId,
        (this.eventsByThread.get(threadId) ?? []).map((event) =>
          event.id === optimisticEvent.id
            ? withPromptSubmissionState(
                event,
                PROMPT_SUBMISSION_STATE.ACCEPTED,
              )
            : event,
        ),
      );
      if (!response?.steered) {
        this.permissionOverrideThreadIds.delete(threadId);
        this.composerSettingsOverrideThreadIds.delete(threadId);
      }
      if (threadId === this.selectedThreadId) {
        this.conversationScrollMode = "bottom-if-needed";
      }
    } catch (error) {
      if (followUpRequest.state === PROMPT_SUBMISSION_STATE.ACCEPTED) {
        return;
      }
      const threadEvents = this.eventsByThread.get(threadId) ?? [];
      const failureState = classifyPromptFailure(error);
      followUpRequest.state = failureState;
      if (failureState === PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN) {
        this.setThreadEvents(
          threadId,
          threadEvents.map((event) =>
            event.id === optimisticEvent.id
              ? withPromptSubmissionState(event, failureState)
              : event,
          ),
        );
        if (threadId === this.selectedThreadId) {
          this.error = error;
          this.conversationScrollMode = "bottom-if-needed";
        }
        return;
      }
      this.setThreadEvents(
        threadId,
        threadEvents.filter((event) => event.id !== optimisticEvent.id),
      );
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
        if (restoreComposerFocus) {
          this.focusFollowUpComposer(threadId);
        }
      }
    }
  }

  focusFollowUpComposer(threadId) {
    const form = this.querySelector(
      `.task-follow-up-form[data-thread-id="${CSS.escape(threadId)}"]`,
    );
    const textarea = promptTextareaForForm(form);
    if (!textarea) {
      return;
    }
    textarea.focus({ preventScroll: true });
    const cursor = textarea.value.length;
    textarea.setSelectionRange(cursor, cursor);
  }

  async interruptSelectedTask() {
    if (
      !this.selectedThreadId ||
      isTaskTransportStale(this.streamState)
    ) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await interruptTask(this.selectedThreadId);
      if (requestId !== this.requestId) {
        return;
      }
      if (!this.acceptTaskDetailRevision(this.selectedThreadId, detail.revision)) {
        return;
      }
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(
        this.selectedThreadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.taskNavigator()?.upsertCanonicalTask(detail.task);
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
    if (
      !this.selectedThreadId ||
      !approvalId ||
      !decision ||
      isTaskTransportStale(this.streamState)
    ) {
      return;
    }

    const requestId = ++this.requestId;
    try {
      const detail = await resolveTaskApproval(
        this.selectedThreadId,
        approvalId,
        decision,
      );
      if (requestId !== this.requestId) {
        return;
      }
      if (!this.acceptTaskDetailRevision(this.selectedThreadId, detail.revision)) {
        return;
      }
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(
        this.selectedThreadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.taskNavigator()?.upsertCanonicalTask(detail.task);
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

  async loadOlderEvents(options = {}) {
    const cursor = this.eventsPage?.nextCursor;
    if (
      !this.selectedThreadId ||
      !cursor ||
      this.loadingOlderEvents ||
      (this.historyLoadError && !options.retry)
    ) {
      return;
    }

    this.loadingOlderEvents = true;
    this.historyLoadError = null;
    this.conversationScrollMode = "preserve";
    const requestId = ++this.requestId;
    this.render();
    try {
      const detail = await getTask(this.selectedThreadId, cursor);
      if (requestId !== this.requestId) {
        return;
      }
      if (taskDetailThreadId(detail) !== this.selectedThreadId || !detail?.task) {
        this.loadingOlderEvents = false;
        this.conversationScrollMode = "preserve";
        this.render();
        return;
      }
      if (!this.acceptTaskDetailRevision(this.selectedThreadId, detail.revision)) {
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
      this.historyLoadError = null;
      this.conversationScrollMode = "prepend";
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) {
        return;
      }
      this.loadingOlderEvents = false;
      this.historyLoadError = error;
      this.conversationScrollMode = "preserve";
      this.render();
    }
  }

  requestRoute(route) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-tasks-route", {
        bubbles: true,
        detail: {
          route: {
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

  async loadPermissionOptions(cwd = this.activeCwdPath()) {
    const targetCwd = cleanLogicalPath(cwd || ".");
    if (
      this.permissionOptionsCwd === targetCwd &&
      (this.permissionOptionsLoaded || this.permissionOptionsLoading)
    ) {
      return;
    }

    const requestId = ++this.permissionOptionsRequestId;
    this.permissionOptionsCwd = targetCwd;
    this.permissionOptionsLoaded = false;
    this.permissionOptionsLoading = true;
    this.permissionOptionsError = null;
    this.render();
    try {
      const response = await getCodexPermissions(targetCwd);
      if (
        requestId !== this.permissionOptionsRequestId ||
        this.permissionOptionsCwd !== targetCwd
      ) {
        return;
      }
      this.permissionOptions = normalizePermissionOptions(response);
      const requestedDefault = `${response?.defaultMode ?? ""}`.trim();
      const defaultOption =
        this.permissionOptions.find(
          (option) => option.mode === requestedDefault && option.allowed,
        ) ?? this.permissionOptions.find((option) => option.allowed);
      this.defaultPermissionMode = defaultOption?.mode ?? "askForApproval";
      const selectedNewOption = this.permissionOptions.find(
        (option) => option.mode === this.newTaskPermissionMode,
      );
      if (!this.newTaskPermissionExplicit || !selectedNewOption?.allowed) {
        this.newTaskPermissionMode = this.defaultPermissionMode;
        this.newTaskPermissionExplicit = false;
      }
      this.permissionOptionsLoaded = true;
    } catch (error) {
      if (requestId !== this.permissionOptionsRequestId) {
        return;
      }
      this.permissionOptions = [];
      this.permissionOptionsError = error;
      this.permissionOptionsLoaded = true;
      this.defaultPermissionMode = "askForApproval";
      this.newTaskPermissionMode ||= this.defaultPermissionMode;
    } finally {
      if (requestId === this.permissionOptionsRequestId) {
        this.permissionOptionsLoading = false;
        this.render();
      }
    }
  }

  observeTaskSettings(detail) {
    const threadId = taskDetailThreadId(detail).trim();
    const permissionMode = `${detail?.permissionMode ?? ""}`.trim();
    if (
      threadId &&
      permissionMode &&
      !this.permissionOverrideThreadIds.has(threadId)
    ) {
      this.permissionModeByThread.set(threadId, permissionMode);
    }
    if (
      !threadId ||
      this.composerSettingsOverrideThreadIds.has(threadId)
    ) {
      return;
    }
    const model = `${detail?.model ?? ""}`.trim();
    const effort = `${detail?.reasoningEffort ?? ""}`.trim();
    if (model || effort) {
      this.composerSettingsByThread.set(threadId, { model, effort });
    }
  }

  selectedPermissionMode(formName) {
    if (formName === "create") {
      return this.newTaskPermissionMode || this.defaultPermissionMode;
    }
    const threadId = this.selectedThreadId;
    return (
      this.permissionModeByThread.get(threadId) ||
      `${this.taskDetail?.permissionMode ?? ""}`.trim() ||
      this.defaultPermissionMode
    );
  }

  selectPermissionMode(formName, permissionMode) {
    const option = this.permissionOptions.find(
      (candidate) => candidate.mode === permissionMode,
    );
    if (!option?.allowed) {
      return;
    }
    if (
      option.dangerous &&
      this.selectedPermissionMode(formName) !== permissionMode &&
      !window.confirm(
        "Full access removes sandbox restrictions and approval prompts for subsequent turns. Continue?",
      )
    ) {
      return;
    }

    if (formName === "create") {
      this.newTaskPermissionMode = permissionMode;
      this.newTaskPermissionExplicit = true;
    } else if (this.selectedThreadId) {
      this.permissionModeByThread.set(this.selectedThreadId, permissionMode);
      this.permissionOverrideThreadIds.add(this.selectedThreadId);
    }
    this.openPermissionPickerForm = "";
    this.render();
  }

  togglePermissionPicker(formName) {
    const nextFormName = `${formName ?? ""}`;
    this.openPermissionPickerForm =
      this.openPermissionPickerForm === nextFormName ? "" : nextFormName;
    this.openModelPickerForm = "";
    if (this.openPermissionPickerForm) {
      this.loadPermissionOptions(this.activeCwdPath());
    }
    this.render();
  }

  closePermissionPicker() {
    if (!this.openPermissionPickerForm) {
      return;
    }
    this.openPermissionPickerForm = "";
    this.render();
  }

  applyDefaultModelSelection() {
    if (!this.modelOptions.length) {
      return;
    }
    const selected = this.selectedModelOption("create");
    const model = selected ?? this.modelOptions.find((option) => option.isDefault) ?? this.modelOptions[0];
    if (!this.composerSettings.model) {
      this.composerSettings.model = model.model;
    }
    if (!this.composerSettings.effort) {
      this.composerSettings.effort =
        model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.value || "";
    }
  }

  composerSettingsFor(formName) {
    if (formName === "create") {
      return this.composerSettings;
    }
    return (
      this.composerSettingsByThread.get(this.selectedThreadId) ?? {
        model: "",
        effort: "",
      }
    );
  }

  editableComposerSettings(formName) {
    if (formName === "create") {
      return this.composerSettings;
    }
    const threadId = this.selectedThreadId;
    const existing = this.composerSettingsByThread.get(threadId);
    if (existing) {
      return existing;
    }
    const settings = { model: "", effort: "" };
    if (threadId) {
      this.composerSettingsByThread.set(threadId, settings);
    }
    return settings;
  }

  markComposerSettingsOverride(formName) {
    if (formName === "follow-up" && this.selectedThreadId) {
      this.composerSettingsOverrideThreadIds.add(this.selectedThreadId);
    }
  }

  modelSelectionLocked(formName) {
    return (
      formName === "follow-up" &&
      isTaskActivelyWorking(this.taskDetail?.task)
    );
  }

  selectModel(formName, modelValue) {
    if (this.modelSelectionLocked(formName)) {
      return;
    }
    const settings = this.editableComposerSettings(formName);
    settings.model = `${modelValue ?? ""}`;
    const model = this.selectedModelOption(formName);
    const supported = this.reasoningOptionsForModel(model).map((option) => option.value);
    if (settings.effort && !supported.includes(settings.effort)) {
      settings.effort =
        model?.defaultReasoningEffort ?? supported[0] ?? "";
    }
    this.markComposerSettingsOverride(formName);
    this.render();
  }

  selectEffort(formName, effort) {
    if (this.modelSelectionLocked(formName)) {
      return;
    }
    this.editableComposerSettings(formName).effort = `${effort ?? ""}`;
    this.markComposerSettingsOverride(formName);
    this.render();
  }

  toggleModelPicker(formName) {
    if (this.modelSelectionLocked(formName)) {
      return;
    }
    const nextFormName = `${formName ?? ""}`;
    this.openModelPickerForm = this.openModelPickerForm === nextFormName ? "" : nextFormName;
    this.openPermissionPickerForm = "";
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

  closeComposerPickers() {
    if (!this.openModelPickerForm && !this.openPermissionPickerForm) {
      return;
    }
    this.openModelPickerForm = "";
    this.openPermissionPickerForm = "";
    this.render();
  }

  selectedModelOption(formName) {
    const selectedModel = this.composerSettingsFor(formName).model;
    return (
      this.modelOptions.find((option) => option.model === selectedModel) ??
      this.modelOptions.find((option) => option.isDefault) ??
      this.modelOptions[0] ??
      null
    );
  }

  selectedEffort(formName) {
    const model = this.selectedModelOption(formName);
    const supported = this.reasoningOptionsForModel(model).map((option) => option.value);
    const selected = this.composerSettingsFor(formName).effort;
    return (
      (supported.includes(selected) ? selected : "") ||
      model?.defaultReasoningEffort ||
      supported[0] ||
      ""
    );
  }

  turnOptions(formName) {
    const activeTurn = formName === "follow-up" && isTaskActivelyWorking(this.taskDetail?.task);
    const options = {};
    if (!activeTurn) {
      const model = this.selectedModelOption(formName);
      options.model = model?.model || undefined;
      options.effort = this.selectedEffort(formName) || undefined;
    }
    const explicitPermission =
      formName === "create"
        ? this.newTaskPermissionExplicit
        : this.permissionOverrideThreadIds.has(this.selectedThreadId);
    if (!activeTurn && explicitPermission) {
      options.permissionMode = this.selectedPermissionMode(formName);
    }
    return options;
  }

  reasoningOptionsForModel(model) {
    return model?.supportedReasoningEfforts ?? [];
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
    const renderedThreadId = this.renderedConversationThreadId();
    const renderedScroll = this.rememberConversationScroll(renderedThreadId);
    const previousScroll =
      renderedThreadId === this.selectedThreadId
        ? renderedScroll
        : this.conversationScrollSnapshot(this.selectedThreadId);
    const previousComposerFocus = this.captureComposerFocus();
    const previousTaskFilePath = this.captureTaskFileBrowserPath();
    const previousNewTaskCwdPath = this.captureNewTaskCwdBrowserPath();
    const previousTaskDiffPath = this.captureTaskDiffPath();
    const previousTaskCompareState = this.captureTaskCompareState();
    this.setAttribute("data-tasks-view", this.view ?? "list");
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.ensureTaskShell();
    this.renderHeaderRegion();
    this.renderTaskContentRegion();
    this.restoreConversationDisclosureState();
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
    this.taskNavigator()?.setSelectedThreadId(this.selectedThreadId);
    this.syncActiveTurnClock();
    this.fitModelPicker();
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
            <div class="tasks-detail-region"></div>
          </main>
        </div>
      </section>
    `;
  }

  taskNavigator() {
    return this.querySelector(":scope > .tasks-surface caffold-task-navigator");
  }

  renderHeaderRegion() {
    const region = this.querySelector(".tasks-header-region");
    if (!region) {
      return;
    }
    const key = [this.view, this.taskDetailView].join("\u0000");
    if (region.dataset.renderKey === key) {
      return;
    }
    region.dataset.renderKey = key;
    region.innerHTML = this.renderHeader();
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
    const selectedTaskCwd = this.view === "detail" ? this.selectedTaskContextPath() : "";
    return cleanLogicalPath(
      this.newTaskCwd || selectedTaskCwd || this.defaultCwdPath || ".",
    );
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
    this.disconnectConversationResizeObserver();
    const scroller = this.querySelector(".task-conversation-scroll");
    scroller?.addEventListener("scroll", () => this.handleConversationScroll());
    const column = scroller?.querySelector(".task-conversation-column");
    const threadId = this.renderedConversationThreadId();
    if (!scroller || !column || !threadId || typeof ResizeObserver === "undefined") {
      return;
    }
    this.conversationResizeObserver = new ResizeObserver(() => {
      if (this.querySelector(".task-conversation-scroll") !== scroller) {
        return;
      }
      const previousScroll = this.conversationScrollSnapshot(threadId);
      if (!previousScroll) {
        return;
      }
      if (previousScroll.atBottom) {
        scroller.scrollTop = maxScrollTop(scroller);
      } else {
        this.restoreConversationAnchor(scroller, previousScroll);
      }
      this.rememberConversationScroll(threadId);
    });
    this.conversationResizeObserver.observe(column);
  }

  disconnectConversationResizeObserver() {
    this.conversationResizeObserver?.disconnect();
    this.conversationResizeObserver = null;
  }

  captureConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    if (!scroller || scroller.clientHeight === 0) {
      return null;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const events = [...scroller.querySelectorAll(".task-event[data-event-id]")];
    const anchor =
      events.find((event) => {
        const eventRect = event.getBoundingClientRect();
        return (
          eventRect.top >= scrollerRect.top + 1 &&
          eventRect.top < scrollerRect.bottom - 1
        );
      }) ??
      events.find((event) => event.getBoundingClientRect().bottom > scrollerRect.top + 1);
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: isScrolledToBottom(scroller),
      anchorEventId: anchor?.dataset.eventId ?? "",
      anchorOffset: anchor
        ? anchor.getBoundingClientRect().top - scrollerRect.top
        : null,
    };
  }

  renderedConversationThreadId() {
    return `${
      this.querySelector(".task-conversation-scroll")
        ?.closest(".task-detail")
        ?.getAttribute("data-thread-id") ?? ""
    }`.trim();
  }

  handleConversationDisclosureClick(event) {
    const summary = closestElement(
      event.target,
      ".task-conversation details[data-disclosure-key] > summary",
    );
    const disclosure = summary?.parentElement;
    if (
      !(disclosure instanceof HTMLDetailsElement) ||
      !disclosure.matches(".task-conversation details[data-disclosure-key]")
    ) {
      return;
    }

    const threadId = `${
      disclosure.closest(".task-detail")?.getAttribute("data-thread-id") ?? ""
    }`.trim();
    const key = `${disclosure.dataset.disclosureKey ?? ""}`.trim();
    if (!threadId || !key) {
      return;
    }
    let state = this.conversationDisclosureByThread.get(threadId);
    if (!state) {
      state = new Map();
      this.conversationDisclosureByThread.set(threadId, state);
    }
    state.set(key, !disclosure.open);
  }

  restoreConversationDisclosureState() {
    const threadId = this.renderedConversationThreadId();
    const state = this.conversationDisclosureByThread.get(threadId);
    if (!state) {
      return;
    }

    this.querySelectorAll(
      ".task-conversation details[data-disclosure-key]",
    ).forEach((disclosure) => {
      const key = disclosure.dataset.disclosureKey;
      if (!state.has(key)) {
        return;
      }
      disclosure.toggleAttribute("open", state.get(key));
    });
  }

  rememberConversationScroll(threadId = this.renderedConversationThreadId()) {
    const snapshot = this.captureConversationScroll();
    if (snapshot && threadId) {
      this.conversationScrollByThread.set(threadId, snapshot);
    }
    return snapshot;
  }

  conversationScrollSnapshot(threadId = this.selectedThreadId) {
    if (!threadId) {
      return null;
    }
    return this.conversationScrollByThread.get(threadId) ?? null;
  }

  isInitialConversationScrollPending(threadId = this.selectedThreadId) {
    return this.initialConversationScrollRequest?.threadId === threadId;
  }

  liveConversationScrollMode(threadId = this.selectedThreadId) {
    return this.isInitialConversationScrollPending(threadId)
      ? "bottom"
      : "bottom-if-needed";
  }

  finishInitialConversationScroll(threadId, requestId) {
    const pending = this.initialConversationScrollRequest;
    if (pending?.threadId === threadId && pending.requestId === requestId) {
      this.initialConversationScrollRequest = null;
    }
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
      this.rememberConversationScroll();
      return;
    }
    if (mode === "prepend" && previousScroll) {
      if (this.restoreConversationAnchor(scroller, previousScroll)) {
        return;
      }
      scroller.scrollTop = Math.min(
        previousScroll.scrollTop + (scroller.scrollHeight - previousScroll.scrollHeight),
        maxScrollTop(scroller),
      );
      return;
    }
    if (this.restoreConversationAnchor(scroller, previousScroll)) {
      return;
    }
    if (previousScroll) {
      scroller.scrollTop = Math.min(previousScroll.scrollTop, maxScrollTop(scroller));
    }
  }

  restoreConversationAnchor(scroller, previousScroll) {
    if (
      !previousScroll?.anchorEventId ||
      !Number.isFinite(previousScroll.anchorOffset)
    ) {
      return false;
    }
    const anchor = [...scroller.querySelectorAll(".task-event[data-event-id]")].find(
      (event) => event.dataset.eventId === previousScroll.anchorEventId,
    );
    if (!anchor) {
      return false;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const currentOffset = anchor.getBoundingClientRect().top - scrollerTop;
    scroller.scrollTop = Math.min(
      Math.max(0, scroller.scrollTop + currentOffset - previousScroll.anchorOffset),
      maxScrollTop(scroller),
    );
    return true;
  }

  handleConversationScroll() {
    const scroller = this.querySelector(".task-conversation-scroll");
    this.rememberConversationScroll();
    if (
      !scroller ||
      this.loadingOlderEvents ||
      this.historyLoadError ||
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

    const previousScroll = this.conversationScrollSnapshot();
    if (event.detail.atBottom) {
      scroller.scrollTop = maxScrollTop(scroller);
    } else if (this.restoreConversationAnchor(scroller, previousScroll)) {
      // Keep the same conversation event at the same viewport offset while
      // prepended Markdown replaces its temporary plain-text layout.
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
    const subtitle = "Caffold Tasks and Codex History";

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

  hasSelectedTaskDetail() {
    return Boolean(
      this.view === "detail" &&
        this.selectedThreadId &&
        this.taskDetail?.task?.threadId === this.selectedThreadId,
    );
  }

  renderBody() {
    const hasSelectedTaskDetail = this.hasSelectedTaskDetail();
    if (this.loading && !hasSelectedTaskDetail && this.view === "detail") {
      return `<p class="surface-message">Loading task...</p>`;
    }
    if (this.detailLoadError && !hasSelectedTaskDetail && this.view === "detail") {
      return this.renderTaskDetailLoadError();
    }
    if (this.error && this.view !== "new" && !hasSelectedTaskDetail) {
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

  renderTaskDetailLoadError() {
    return `
      <section class="task-detail-load-error" role="alert">
        <p>Task details are temporarily unavailable.</p>
        <p class="task-load-error-message">${escapeHtml(this.detailLoadError?.message ?? "")}</p>
        <button type="button" class="task-secondary-button" data-task-action="retry-task-detail">Retry</button>
      </section>
    `;
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
    const model = this.selectedModelOption(formName);
    const effort = this.selectedEffort(formName);
    const submitting =
      formName === "follow-up" &&
      this.followUpRequest?.threadId === threadId;
    const transportBlocked =
      formName === "follow-up"
        ? isTaskTransportStale(this.streamState)
        : !this.taskNavigator()?.isTransportAvailable();
    const permissionLocked =
      formName === "follow-up" &&
      (isTaskActivelyWorking(this.taskDetail?.task) || transportBlocked);
    const permissionMode = this.selectedPermissionMode(formName);
    const images = this.composerImages(formName);
    const imageError = this.composerImageErrors.get(formName) ?? "";
    const requestError =
      formName === "follow-up" && this.error
        ? this.error.message || `${this.error}`
        : "";
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
            ${transportBlocked ? "disabled" : ""}
          >${escapeHtml(prompt ?? "")}</textarea>
          ${imageError ? `<p class="task-composer-image-error" role="alert">${escapeHtml(imageError)}</p>` : ""}
          ${requestError ? `<p class="task-composer-request-error" role="alert">${escapeHtml(requestError)}</p>` : ""}
          <input type="hidden" name="model" value="${escapeHtml(model?.model ?? "")}">
          <input type="hidden" name="effort" value="${escapeHtml(effort)}">
          <input type="hidden" name="permissionMode" value="${escapeHtml(permissionMode)}">
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              ${
                cancel
                  ? `<button type="button" class="task-toolbar-button" data-task-action="open-list">Cancel</button>`
                  : ""
              }
              ${this.renderModelPicker(formName, permissionLocked)}
              ${this.renderPermissionPicker(formName, permissionLocked)}
            </div>
            <button type="submit" class="task-send-button" aria-label="${escapeHtml(submitLabel)}" title="${escapeHtml(transportBlocked ? "Caffold server is reconnecting." : submitLabel)}"${submitting || transportBlocked ? " disabled" : ""}>
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

  renderModelPicker(formName, disabled = false) {
    const model = this.selectedModelOption(formName);
    const modelLabel = model?.displayName ?? (this.modelOptionsLoading ? "Loading model" : "Model");
    const effort = this.selectedEffort(formName);
    const reasoningOptions = this.reasoningOptionsForModel(model);
    const effortLabel =
      reasoningOptions.find((option) => option.value === effort)?.label ||
      effort ||
      "Reasoning";
    const open = !disabled && this.openModelPickerForm === formName;
    const modelRows = this.modelOptions.length
      ? this.modelOptions
          .map((option) => renderModelOption(option, model?.model ?? "", formName))
          .join("")
      : renderModelFallback(this.modelOptionsLoading, this.modelOptionsError);
    const reasoningRows = reasoningOptions
      .map((option) => renderReasoningOption(option, effort, formName))
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
          ${disabled ? 'disabled title="Model and reasoning can be changed after the active turn finishes."' : ""}
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

  renderPermissionPicker(formName, disabled = false) {
    const permissionMode = this.selectedPermissionMode(formName);
    const selected = this.permissionOptions.find(
      (option) => option.mode === permissionMode,
    );
    const label =
      selected?.label ??
      (this.permissionOptionsLoading
        ? "Loading permissions"
        : this.permissionOptionsError
          ? "Codex default"
          : permissionModeLabel(permissionMode));
    const open = !disabled && this.openPermissionPickerForm === formName;
    const rows = this.permissionOptions.length
      ? this.permissionOptions
          .map((option) => renderPermissionOption(option, permissionMode, formName))
          .join("")
      : renderPermissionFallback(
          this.permissionOptionsLoading,
          this.permissionOptionsError,
        );
    const lockedMessage = "Approval mode can be changed after the active turn finishes.";

    return `
      <div class="task-permission-picker${open ? " is-open" : ""}">
        <button
          type="button"
          class="task-permission-button${selected?.dangerous ? " is-dangerous" : ""}"
          data-task-action="toggle-permission-picker"
          data-form-name="${escapeHtml(formName)}"
          aria-expanded="${open ? "true" : "false"}"
          aria-label="Choose approval mode"
          title="${escapeHtml(disabled ? lockedMessage : label)}"
          ${disabled ? "disabled" : ""}
        >
          ${renderInlineIcon("Shield", "Permissions", "task-permission-icon")}
          <span>${escapeHtml(label)}</span>
          <span class="task-model-caret" aria-hidden="true">&#8964;</span>
        </button>
        ${
          open
            ? `<button
                type="button"
                class="task-permission-backdrop"
                data-task-action="close-permission-picker"
                aria-label="Close approval mode picker"
              ></button>
              <div class="task-permission-popover" role="menu" aria-label="Approval modes">
                <p class="task-permission-heading">Permissions</p>
                ${rows}
              </div>`
            : ""
        }
      </div>
    `;
  }

  fitModelPicker() {
    const popover = this.querySelector(
      ".task-model-picker.is-open .task-model-popover",
    );
    if (!popover) {
      return;
    }

    popover.style.removeProperty("max-height");
    if (window.matchMedia("(max-width: 860px)").matches) {
      return;
    }

    const button = popover
      .closest(".task-model-picker")
      ?.querySelector(".task-model-button");
    if (!button) {
      return;
    }

    const buttonRect = button.getBoundingClientRect();
    const opensUpward = Boolean(popover.closest(".task-follow-up-form"));
    const conversationRect = popover
      .closest(".task-conversation-pane")
      ?.getBoundingClientRect();
    const availableHeight = opensUpward
      ? buttonRect.top - (conversationRect?.top ?? 0) - 18
      : window.innerHeight - buttonRect.bottom - 18;
    popover.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`;
  }

  renderTaskDetail() {
    const task = this.taskDetail?.task;
    if (!task) {
      return `<p class="surface-message">${this.loading ? "Loading task..." : "Select a task."}</p>`;
    }
    if (this.taskDetail?.managed === false) {
      return this.renderContinueGate(task);
    }
    const approvals = pendingApprovals(this.events);
    const controlsDisabled = isTaskTransportStale(this.streamState);
    return `
      <div class="task-detail" data-thread-id="${escapeHtml(task.threadId ?? task.id)}" data-task-detail-view="${escapeHtml(this.taskDetailView)}" data-task-availability="${escapeHtml(this.streamState)}">
        ${this.renderTaskDetailSummary(task)}
        <section class="task-conversation-pane" aria-label="Task conversation">
          <div class="task-conversation-scroll">
            <div class="task-conversation-column">
              ${
                this.detailLoadError
                  ? `<div class="task-detail-load-error task-detail-load-error-inline" role="alert">
                      <p>Task details could not be refreshed.</p>
                      <p class="task-load-error-message">${escapeHtml(this.detailLoadError.message)}</p>
                      <button type="button" class="task-secondary-button" data-task-action="retry-task-detail">Retry</button>
                    </div>`
                  : ""
              }
              ${
                this.taskDetail?.historyLoading
                  ? `<p class="task-history-loading" role="status">Loading conversation...</p>`
                  : ""
              }
              ${
                this.eventsPage?.nextCursor || this.loadingOlderEvents
                  ? `<div class="task-load-older">
                      ${this.loadingOlderEvents ? "Loading older..." : ""}
                      ${
                        this.historyLoadError
                          ? `<div class="task-history-error" role="alert">
                              <span>Older messages are temporarily unavailable.</span>
                              <span class="task-load-error-message">${escapeHtml(this.historyLoadError.message)}</span>
                              <button type="button" data-task-action="retry-task-history">Retry loading older messages</button>
                            </div>`
                          : ""
                      }
                    </div>`
                  : ""
              }
              <ol class="task-conversation" aria-label="Task conversation">
                ${renderConversation(this.events, task, approvals, {
                  controlsDisabled,
                })}
              </ol>
            </div>
          </div>
          ${this.renderStreamState()}
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

  renderContinueGate(task) {
    const threadId = taskThreadId(task);
    const continuation = this.taskNavigator()?.continuationState(threadId) ?? {
      loading: false,
      error: null,
    };
    return `
      <section class="task-continue-gate" data-thread-id="${escapeHtml(threadId)}">
        <p class="task-continue-eyebrow">Codex History</p>
        <h2>${escapeHtml(task.title)}</h2>
        ${task.preview ? `<p class="task-continue-preview">${escapeHtml(task.preview)}</p>` : ""}
        ${task.cwd ? `<p class="task-continue-cwd">${escapeHtml(task.cwd)}</p>` : ""}
        <p>This thread is not managed by Caffold yet. Continue it before loading its conversation or runtime.</p>
        ${continuation.error ? `<p class="task-load-error-message" role="alert">${escapeHtml(continuation.error.message)}</p>` : ""}
        <button type="button" class="task-primary-button" data-task-action="continue-history-task" data-thread-id="${escapeHtml(threadId)}" ${continuation.loading ? "disabled" : ""}>${continuation.loading ? "Continuing..." : "Continue in Caffold"}</button>
      </section>
    `;
  }

  renderTaskDetailSummary(task) {
    const status = renderTaskStatusChip(task, "task-detail-status", {
      label: false,
      transportState: this.streamState,
    });
    const statusLabel = formatTaskStatus(task, this.streamState);
    const canOpenDiff = Boolean(task.worktree);
    const worktreeLabel = taskWorktreeLabel(task);
    const transportBlocked = isTaskTransportStale(this.streamState);

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
                task.activeTurn?.id
                  ? `<button type="button" class="task-secondary-button" data-task-action="interrupt" ${transportBlocked ? 'disabled title="Caffold server connection is unavailable."' : ""}>
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
                <dd>${escapeHtml(task.cwdPath || task.cwd || this.activeCwdPath())}</dd>
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
    if (this.streamState === TASK_TRANSPORT_STATE.RECONNECTING) {
      return `
        <div class="task-stream-state" data-stream-state="reconnecting" role="status">
          <span class="task-stream-spinner" aria-hidden="true"></span>
          <span>Caffold server connection lost. Reconnecting...</span>
        </div>
      `;
    }
    if (this.streamState === TASK_TRANSPORT_STATE.UNAVAILABLE) {
      return `
        <div class="task-stream-state" data-stream-state="unavailable" role="status">
          ${renderInlineIcon("TriangleAlert", "Caffold server unavailable", "task-stream-icon")}
          <span>Caffold server unavailable.</span>
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
  return isTaskTransportStale(state);
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
      const fallbackValue = typeof option === "string" ? option : "";
      const value = `${option?.value ?? option?.reasoningEffort ?? fallbackValue}`.trim();
      if (!value) {
        return null;
      }
      return {
        value,
        label: `${option?.label ?? value}`.trim(),
        description: `${option?.description ?? ""}`.trim(),
      };
    })
    .filter(Boolean);
}

function normalizePermissionOptions(response) {
  const options = Array.isArray(response?.options) ? response.options : [];
  return options
    .map((option) => {
      const mode = `${option?.mode ?? ""}`.trim();
      if (!mode) {
        return null;
      }
      return {
        mode,
        label: `${option?.label ?? permissionModeLabel(mode)}`.trim(),
        description: `${option?.description ?? ""}`.trim(),
        allowed: Boolean(option?.allowed),
        dangerous: Boolean(option?.dangerous),
      };
    })
    .filter(Boolean);
}

function permissionModeLabel(mode) {
  if (mode === "approveForMe") {
    return "Approve for me";
  }
  if (mode === "fullAccess") {
    return "Full access";
  }
  return "Ask for approval";
}

function renderPermissionOption(option, selectedMode, formName) {
  const selected = option.mode === selectedMode;
  const unavailable = option.allowed ? "" : " Not allowed by Codex requirements.";
  return `
    <button
      type="button"
      class="task-model-option task-permission-option${option.dangerous ? " is-dangerous" : ""}"
      data-task-action="select-permission"
      data-form-name="${escapeHtml(formName)}"
      data-permission-mode="${escapeHtml(option.mode)}"
      aria-pressed="${selected ? "true" : "false"}"
      ${option.allowed ? "" : "disabled"}
    >
      <span>
        <strong>${escapeHtml(option.label)}</strong>
        <small>${escapeHtml(`${option.description}${unavailable}`)}</small>
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderPermissionFallback(loading, error) {
  if (loading) {
    return `<p class="task-model-note">Loading permission modes...</p>`;
  }
  if (error) {
    return `<p class="task-model-note">Permission modes are unavailable. Current Codex settings will be kept.</p>`;
  }
  return `<p class="task-model-note">Open this menu after Codex is connected.</p>`;
}

function renderReasoningOption(option, selectedEffort, formName) {
  const selected = option.value === selectedEffort;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-effort"
      data-form-name="${escapeHtml(formName)}"
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

function renderModelOption(option, selectedModel, formName) {
  const selected = option.model === selectedModel;
  return `
    <button
      type="button"
      class="task-model-option"
      data-task-action="select-model"
      data-form-name="${escapeHtml(formName)}"
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

function renderConversation(events, task, approvals = [], options = {}) {
  const conversationEvents = dedupeCanonicalEvents(events);
  const groups = conversationGroups(conversationEvents);
  const liveStatusAvailable = !options.controlsDisabled;
  const activeGroupIndex = liveStatusAvailable
    ? activeTurnGroupIndex(groups, task)
    : -1;
  const pendingApprovalIds = new Set(
    approvals.map((event) => event.payload?.approvalId).filter(Boolean),
  );
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
          pendingApprovalIds,
          controlsDisabled: options.controlsDisabled,
          liveStatusAvailable,
        });
      }
      if (
        group.event.type === "approval_requested" &&
        pendingApprovalIds.has(group.event.payload?.approvalId)
      ) {
        return renderApprovalFlow([group.event], {
          disabled: options.controlsDisabled,
        });
      }
      if (!shouldRenderStandaloneEvent(group.event, userPrompts)) {
        return "";
      }
      return renderConversationEvent(group.event, task, { active: false });
    })
    .join("");
  if (
    liveStatusAvailable &&
    isTaskActivelyWorking(task) &&
    activeGroupIndex < 0
  ) {
    return `${output}${renderActiveTurnStatus(
      {
        turnId: task?.activeTurn?.id ?? "active-turn",
        events: [],
      },
      task,
    )}`;
  }
  return output;
}

function activeTurnGroupIndex(groups, task) {
  if (!isTaskActivelyWorking(task)) {
    return -1;
  }
  const exactIndex = groups.findIndex(
    (group) => group.kind === "turn" && group.turnId === task?.activeTurn?.id,
  );
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const startedMs = Number(task?.activeTurn?.startedAtMs);
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

function renderTurnGroup(group, task, options = {}) {
  const assistantEvents = group.events.filter((event) => event.type === "assistant_message");
  const statusEvents = group.events.filter(isTurnStatusEvent);
  const terminalEvent = statusEvents.find(isTerminalTurnEvent);
  const finalAssistantEvent =
    assistantEvents.findLast(isFinalAssistantEvent) ?? assistantEvents.at(-1);
  const isCurrentTurn = task?.activeTurn?.id === group.turnId;
  const isActive =
    options.liveStatusAvailable !== false &&
    isTaskActivelyWorking(task) &&
    (options.forceActive || isCurrentTurn);
  const isComplete =
    Boolean(terminalEvent) ||
    (Boolean(finalAssistantEvent && isFinalAssistantEvent(finalAssistantEvent)) &&
      !isActive);

  if (isComplete) {
    return renderCompletedTurnGroup(
      group,
      task,
      terminalEvent,
      finalAssistantEvent,
      options.pendingApprovalIds,
      options.controlsDisabled,
    );
  }

  const output = group.events
    .map((event) =>
      renderActiveTurnTimelineEvent(
        event,
        task,
        options.pendingApprovalIds,
        options.controlsDisabled,
      ),
    )
    .filter(Boolean);
  if (isActive) {
    output.push(renderActiveTurnStatus(group, task));
  }
  return output.join("");
}

function renderCompletedTurnGroup(
  group,
  task,
  terminalEvent,
  finalAssistantEvent,
  pendingApprovalIds = new Set(),
  controlsDisabled = false,
) {
  const output = [];
  const userEvents = group.events.filter((event) => event.type === "user_message");
  const workEvents = group.events.filter(
    (event) =>
      isWorkEvent(event) ||
      (event.type === "assistant_message" && event !== finalAssistantEvent),
  );
  const approvals = group.events.filter(
    (event) =>
      event.type === "approval_requested" &&
      pendingApprovalIds.has(event.payload?.approvalId),
  );

  for (const event of userEvents) {
    output.push(renderConversationEvent(event, task, { active: false }));
  }
  if (workEvents.length > 0) {
    output.push(renderTurnWorkSummary(group, workEvents, terminalEvent));
  }
  if (approvals.length > 0) {
    output.push(renderApprovalFlow(approvals, { disabled: controlsDisabled }));
  }
  if (finalAssistantEvent) {
    output.push(
      renderConversationEvent(finalAssistantEvent, task, {
        active: false,
        messagePhase: "final",
      }),
    );
  }
  return output.join("");
}

function renderActiveTurnTimelineEvent(
  event,
  task,
  pendingApprovalIds = new Set(),
  controlsDisabled = false,
) {
  if (
    event.type === "approval_requested" &&
    pendingApprovalIds.has(event.payload?.approvalId)
  ) {
    return renderApprovalFlow([event], { disabled: controlsDisabled });
  }
  if (
    event.type === "user_message" ||
    event.type === "assistant_message" ||
    isWorkEvent(event)
  ) {
    return renderConversationEvent(event, task, {
      active: isWorkEvent(event),
    });
  }
  return "";
}

function renderActiveTurnStatus(group, task) {
  const startedMs = activeTurnStartMs(task);
  const state = activeTurnStateLabel(group.events, task);
  const startedAttribute = startedMs
    ? ` data-active-turn-started-ms="${escapeHtml(startedMs)}"`
    : "";
  const duration = startedMs
    ? `Working for ${formatDuration(Date.now() - startedMs)}`
    : "Working";
  return `
    <li
      class="task-event task-turn-active"
      ${startedAttribute}
      data-turn-id="${escapeHtml(group.turnId)}"
    >
      <span class="task-status-spinner" aria-hidden="true"></span>
      <span class="task-turn-active-duration">${escapeHtml(duration)}</span>
      <span class="task-turn-active-state" title="${escapeHtml(state)}" aria-live="polite">${escapeHtml(state)}</span>
    </li>
  `;
}

function activeTurnStartMs(task) {
  const taskStartedMs = Number(task?.activeTurn?.startedAtMs);
  if (Number.isFinite(taskStartedMs) && taskStartedMs > 0) {
    return taskStartedMs;
  }
  return null;
}

function activeTurnStateLabel(events, task) {
  const activeFlagLabel = taskActiveFlagLabel(task);
  if (activeFlagLabel) {
    return activeFlagLabel;
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

function renderApprovalFlow(approvals, options = {}) {
  if (!approvals.length) {
    return "";
  }
  return `
    <li class="task-event task-approval-flow">
      <section class="task-approvals" aria-label="Pending approvals">
        ${approvals
          .map((approval) => renderApprovalCard(approval, options))
          .join("")}
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

function renderStatusEvent(event) {
  const status = statusTone(event.type);
  return `
    <li class="task-event task-event-status"${eventIdentityAttribute(event)} data-event-type="${escapeHtml(event.type)}" data-event-status="${escapeHtml(status)}">
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
  const submissionState = promptSubmissionState(event);
  const deliveryAttribute = submissionState
    ? ` data-delivery-state="${escapeHtml(submissionState)}"`
    : "";
  const deliveryLabel = {
    [PROMPT_SUBMISSION_STATE.SENDING]: "Sending...",
    [PROMPT_SUBMISSION_STATE.ACCEPTED]: "Accepted - syncing...",
    [PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN]: "Delivery unconfirmed",
  }[submissionState] ?? "";

  return `
    <li class="task-event task-message"${eventIdentityAttribute(event)} data-event-type="${escapeHtml(event.type)}" data-message-role="${escapeHtml(role)}"${phaseAttribute}${attachmentsAttribute}${deliveryAttribute}>
      <div class="task-message-header">
        ${deliveryLabel ? `<span class="task-message-delivery">${escapeHtml(deliveryLabel)}</span>` : ""}
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

function eventIdentityAttribute(event) {
  const eventId = `${event?.id ?? ""}`.trim();
  return eventId ? ` data-event-id="${escapeHtml(eventId)}"` : "";
}

function disclosureIdentityAttribute(kind, identity) {
  const value = `${identity ?? ""}`.trim();
  return value
    ? ` data-disclosure-key="${escapeHtml(`${kind}:${value}`)}"`
    : "";
}

function turnGroupDisclosureIdentity(group) {
  const turnId = `${group?.turnId ?? ""}`.trim();
  if (turnId && !turnId.startsWith("implicit-")) {
    return turnId;
  }

  const eventId = group?.events
    ?.map((event) => `${event?.id ?? ""}`.trim())
    .find(Boolean);
  return eventId || eventIdentityKey(group?.events?.[0]) || turnId;
}

function userMessagePresentation(payload) {
  const content = userMessageContent(payload);
  const text = userMessageText(payload);
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

function userMessageText(payload) {
  const prompt = `${payload?.prompt ?? ""}`.trim();
  const payloadText = `${payload?.text ?? ""}`.trim();
  const content = userMessageContent(payload);
  const itemText = content
    .filter((item) => ["text", "input_text"].includes(item?.type))
    .map((item) => `${item?.text ?? ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  return normalizedUserMessageText(payloadText || prompt || itemText);
}

function userMessageContent(payload) {
  if (Array.isArray(payload?.content)) {
    return payload.content;
  }
  return Array.isArray(payload?.item?.content) ? payload.item.content : [];
}

function normalizedUserMessageText(text) {
  const isAmbientWrapper =
    text.includes("automatically supplied ambient UI state") ||
    text.includes("<in-app-browser-context") ||
    text.includes("# In app browser:");
  if (!isAmbientWrapper) {
    return text;
  }

  for (const marker of ["## My request for Codex:", "My request for Codex:"]) {
    const markerIndex = text.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return text.slice(markerIndex + marker.length).trim();
    }
  }
  return text;
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

function renderThinkingEvent(event, text, task, eventState) {
  const value = `${text ?? ""}`.trim();
  if (!value) {
    return renderStatusEvent(event);
  }
  const isActive =
    eventState?.active ??
    isTaskActivelyWorking(task);
  const open = isActive ? " open" : "";
  const state = isActive ? "active" : "complete";

  return `
    <li class="task-event task-thinking" data-event-type="${escapeHtml(event.type)}" data-thinking-state="${escapeHtml(state)}">
      <details${open}${disclosureIdentityAttribute("thinking", eventIdentityKey(event))}>
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
  const count = turnWorkItemCount(workEvents);
  const updateText = count === 1 ? "1 update" : `${count} updates`;
  const label = duration ? `Worked for ${duration}` : "Work details";
  return `
    <li class="task-event task-turn-work" data-turn-id="${escapeHtml(group.turnId)}">
      <details${disclosureIdentityAttribute("turn-work", turnGroupDisclosureIdentity(group))}>
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

function turnWorkItemCount(events) {
  let count = 0;
  let combinedType = "";
  for (const event of events) {
    if (["reasoning", "file_change"].includes(event.type)) {
      if (combinedType !== event.type) {
        count += 1;
        combinedType = event.type;
      }
      continue;
    }
    combinedType = "";
    count += 1;
  }
  return count;
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
  const output = [];
  let combinedEvents = [];
  let combinedType = "";
  const flushCombinedEvents = () => {
    if (combinedType === "reasoning") {
      output.push(renderCombinedReasoningWorkItem(combinedEvents));
    } else if (combinedType === "file_change") {
      output.push(renderCombinedFileChangeWorkItem(combinedEvents));
    }
    combinedEvents = [];
    combinedType = "";
  };

  for (const event of events) {
    if (["reasoning", "file_change"].includes(event.type)) {
      if (combinedType && combinedType !== event.type) {
        flushCombinedEvents();
      }
      combinedType = event.type;
      combinedEvents.push(event);
      continue;
    }
    flushCombinedEvents();
    output.push(renderTurnWorkItem(event));
  }
  flushCombinedEvents();
  return output.filter(Boolean).join("");
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
        <details${open}${disclosureIdentityAttribute("command", eventIdentityKey(event))}>
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
      <details${open}${disclosureIdentityAttribute("command", eventIdentityKey(event))}>
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

function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
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

function renderApprovalCard(event, options = {}) {
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
              `<button type="button" class="task-secondary-button" data-task-action="approval" data-approval-id="${escapeHtml(approvalId)}" data-decision="${escapeHtml(decision)}" ${options.disabled ? "disabled" : ""}>${escapeHtml(formatDecision(decision))}</button>`,
          )
          .join("")}
      </div>
    </article>
  `;
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

function promptTextareaForForm(form) {
  const field = form?.elements?.namedItem("prompt");
  return field instanceof HTMLTextAreaElement ? field : null;
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

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function renderTaskStatusChip(task, className = "", options = {}) {
  const view = taskStatusView(
    task,
    options.transportState ?? TASK_TRANSPORT_STATE.READY,
  );
  if (!view) {
    return "";
  }
  const showLabel = options.label !== false;

  const classes = ["task-status-chip", className].filter(Boolean).join(" ");
  const icon = ["running", "syncing", "reconnecting"].includes(view.status)
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

function statusTone(type) {
  if (type === "task_failed" || type === "turn_interrupted") {
    return "danger";
  }
  if (type === "approval_requested") {
    return "warning";
  }
  return "muted";
}
