import {
  getCodexModels,
  getCodexPermissions,
  getGitHubStatus,
  getGitStatus,
  getTask,
  interruptTask,
  resolveTaskApproval,
  sendTaskPrompt,
  taskStreamUrl,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import "../../../../components/file-browser.js";
import "../../../../components/git-compare-browser.js";
import "../../../../components/git-diff-browser.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { createRefreshCoordinator, subscribeToWatch } from "../../../../watch.js";
import {
  latestTaskRelatedWorktreePaths,
} from "../conversation-render.js";
import "./conversation.js";
import "./markdown.js";
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
} from "../runtime-state.js";
import {
  mergeEvents,
  mergeTaskEventsPage,
  optimisticUserMessageEvent,
  upsertEvent,
  userMessageFingerprint,
} from "../task-events.js";
import {
  cleanLogicalPath,
  cleanRelativeTaskPath,
  shortId,
} from "../task-format.js";
import {
  taskDetailThreadId,
  taskThreadId,
  taskWorktreeLabel,
  taskWorktreeRootName,
} from "../task-list-model.js";

const STREAM_ERROR_DELAY_MS = 8_000;
const TASK_COMPOSER_MAX_IMAGES = 4;
const TASK_COMPOSER_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TASK_COMPOSER_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

class CaffoldTaskDetail extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachGlobalListeners();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.view = "detail";
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
    this.selectedThreadId = "";
    this.stream = null;
    this.streamState = TASK_TRANSPORT_STATE.IDLE;
    this.streamGeneration = 0;
    this.streamErrorTimer = null;
    this.taskRefresh = null;
    this.detailLoadGeneration = 0;
    this.historyRequestToken = 0;
    this.interruptActionToken = 0;
    this.approvalActionToken = 0;
    this.promptSubmissionSequence = 0;
    this.continuationStateValue = { loading: false, error: null };
    this.conversationUpdateKind = null;
    this.initialConversationLoad = null;
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
    this.permissionModeByThread = new Map();
    this.permissionOverrideThreadIds = new Set();
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
      this.render();
    };
    this.boundTaskListResize = () => {
      this.fitModelPicker();
    };
    this.boundVisibilityChange = () => this.handleVisibilityChange();
    warmIcons();

    this.addEventListener(
      "click",
      (event) => {
        if (
          closestElement(
            event.target,
            "caffold-task-conversation",
          )
        ) {
          return;
        }
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
    this.addEventListener("caffold:task-conversation-intent", (event) => {
      event.stopPropagation();
      if (event.detail?.type === "older-history") {
        void this.loadOlderEvents({ retry: event.detail?.retry });
      } else if (event.detail?.type === "retry-detail") {
        void this.openTask(this.selectedThreadId);
      } else if (event.detail?.type === "approval") {
        void this.resolveApproval(
          event.detail.approvalId,
          event.detail.decision,
        );
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
      if (closestElement(event.target, "caffold-task-composer")) {
        return;
      }
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
        if (closestElement(event.target, "caffold-task-composer")) {
          return;
        }
        void this.handleComposerPaste(event);
      },
      true,
    );
    this.addEventListener("keydown", (event) => {
      if (closestElement(event.target, "caffold-task-composer")) {
        return;
      }
      this.handlePromptKeydown(event);
    });
    this.addEventListener(
      "submit",
      (event) => {
        if (closestElement(event.target, "caffold-task-composer")) {
          return;
        }
        const form = closestElement(event.target, "form[data-task-form]");
        if (!form) {
          return;
        }

        event.preventDefault();
        const formName = form.dataset.taskForm;
        void this.handleForm(formName, form).catch((error) => {
          if (formName === "follow-up") {
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
    this.deactivate();
  }

  prepare(threadId, options = {}) {
    this.ensureRendered();
    const targetThreadId = `${threadId ?? ""}`.trim();
    if (!targetThreadId) {
      this.deactivate();
      return;
    }
    if (
      options.preserveLoadedTask &&
      this.selectedThreadId === targetThreadId &&
      taskDetailThreadId(this.taskDetail) === targetThreadId
    ) {
      this.view = "detail";
      this.hidden = false;
      this.error = null;
      this.detailLoadError = null;
      this.activateThreadEvents(targetThreadId);
      this.render();
      return;
    }

    if (this.selectedThreadId !== targetThreadId) {
      this.detailLoadGeneration += 1;
      this.historyRequestToken += 1;
      this.interruptActionToken += 1;
      this.approvalActionToken += 1;
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
    this.hidden = false;
    this.selectedThreadId = targetThreadId;
    this.activateThreadEvents(targetThreadId);
    this.followUpDraft =
      this.followUpDraftByThread.get(targetThreadId) ?? "";
    this.followUpImages = [
      ...(this.followUpImagesByThread.get(targetThreadId) ?? []),
    ];
    this.taskDetail =
      taskDetailThreadId(this.taskDetail) === targetThreadId
        ? this.taskDetail
        : null;
    this.eventsPage =
      taskDetailThreadId(this.taskDetail) === targetThreadId
        ? this.eventsPage
        : { nextCursor: null };
    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.render();
  }

  async open(threadId, options = {}) {
    const targetThreadId = `${threadId ?? ""}`.trim();
    this.prepare(targetThreadId, options);
    if (!targetThreadId) {
      return null;
    }
    if (
      options.preserveLoadedTask &&
      taskDetailThreadId(this.taskDetail) === targetThreadId
    ) {
      this.loading = false;
      this.loadTaskGithubStatus(this.taskDetail.task);
      this.loadModelOptions();
      this.observeTaskSettings(this.taskDetail);
      this.loadPermissionOptions(this.activeCwdPath());
      this.connectStream(targetThreadId);
      return this.taskDetail;
    }
    return await this.openTask(targetThreadId);
  }

  adoptCreatedDetail(detail) {
    const threadId = taskDetailThreadId(detail);
    if (!threadId || !detail?.task) {
      return false;
    }
    this.detailLoadGeneration += 1;
    this.selectedThreadId = threadId;
    this.view = "detail";
    this.hidden = false;
    this.acceptTaskDetailRevision(threadId, detail.revision);
    this.taskDetail = detail;
    this.observeTaskSettings(detail);
    this.setThreadEvents(threadId, detail.events ?? []);
    this.eventsPage = detail.eventsPage ?? { nextCursor: null };
    this.conversationUpdateKind = "bottom";
    this.emitTaskSnapshot();
    this.render();
    this.connectStream(threadId);
    return true;
  }

  deactivate() {
    this.detailLoadGeneration += 1;
    this.historyRequestToken += 1;
    this.interruptActionToken += 1;
    this.approvalActionToken += 1;
    this.initialConversationLoad = null;
    this.closeStream();
    this.unsubscribeTaskDiffWatch();
    this.hidden = true;
  }

  setContinuationState(state = {}) {
    this.continuationStateValue = {
      loading: Boolean(state.loading),
      error: state.error ?? null,
    };
    if (this.taskDetail?.managed === false) {
      this.render();
    }
  }

  currentDetail() {
    return this.taskDetail;
  }

  emitTaskSnapshot() {
    this.dispatchEvent(
      new CustomEvent("caffold:task-snapshot", {
        bubbles: true,
        composed: true,
        detail: {
          threadId: this.selectedThreadId,
          detail: this.taskDetail,
          task: this.taskDetail?.task ?? null,
        },
      }),
    );
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

  async openTask(threadId) {
    if (!threadId) {
      return null;
    }

    const loadGeneration = ++this.detailLoadGeneration;
    this.initialConversationLoad = this.conversationComponent()?.hasScrollSnapshot(threadId)
      ? null
      : { threadId, loadGeneration };
    this.view = "detail";
    this.selectedThreadId = threadId;
    this.loading = true;
    this.error = null;
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.render();
    this.connectStream(threadId);

    try {
      const detail = await getTask(threadId);
      if (loadGeneration !== this.detailLoadGeneration) {
        return null;
      }
      if (
        taskDetailThreadId(detail) !== threadId ||
        !this.acceptTaskDetailRevision(threadId, detail.revision)
      ) {
        this.finishInitialConversationLoad(threadId, loadGeneration);
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
      this.emitTaskSnapshot();
      if (detail.managed === false) {
        this.closeStream();
        this.render();
        this.finishInitialConversationLoad(threadId, loadGeneration);
        return detail;
      }
      this.conversationUpdateKind = this.isInitialConversationLoadPending(threadId)
        ? "bottom"
        : "preserve";
      this.render();
      this.finishInitialConversationLoad(threadId, loadGeneration);
      this.loadTaskGithubStatus(detail.task);
      this.loadModelOptions();
      this.loadPermissionOptions(this.activeCwdPath());
      return detail;
    } catch (error) {
      if (loadGeneration !== this.detailLoadGeneration) {
        return null;
      }
      this.loading = false;
      this.detailLoadError = error;
      this.render();
      this.finishInitialConversationLoad(threadId, loadGeneration);
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

  connectStream(threadId, { force = false } = {}) {
    if (!force && this.stream && this.selectedThreadId === threadId) {
      return;
    }
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
      this.conversationUpdateKind = this.liveConversationUpdateKind(threadId);
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
      this.emitTaskSnapshot();
    }
    this.loadTaskGithubStatus(detail.task);
    this.conversationUpdateKind = this.liveConversationUpdateKind(threadId);
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
    if (
      this.hidden ||
      document.visibilityState !== "visible" ||
      !this.selectedThreadId
    ) {
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
    const loadGeneration = this.detailLoadGeneration;
    try {
      const detail = await getTask(threadId);
      if (
        loadGeneration !== this.detailLoadGeneration ||
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
        this.emitTaskSnapshot();
      }
      this.loadTaskGithubStatus(detail.task);
      this.conversationUpdateKind = this.liveConversationUpdateKind(threadId);
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
      this.dispatchEvent(
        new CustomEvent("caffold:task-detail-intent", {
          bubbles: true,
          composed: true,
          detail: {
            type: "continue-thread",
            threadId: element.dataset.threadId,
          },
        }),
      );
      return;
    }
    if (action === "retry-stream") {
      if (this.selectedThreadId) {
        this.connectStream(this.selectedThreadId, { force: true });
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
      this.promptSubmissionSequence + 1,
    );
    const previousTask =
      taskThreadId(this.taskDetail?.task) === threadId
        ? this.taskDetail.task
        : null;
    const turnOptions = this.turnOptions("follow-up");
    const requestId = ++this.promptSubmissionSequence;
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
      this.conversationUpdateKind = "bottom";
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
        this.conversationUpdateKind = "live";
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
          this.conversationUpdateKind = "live";
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
        this.conversationUpdateKind = "preserve";
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

    const actionToken = ++this.interruptActionToken;
    const threadId = this.selectedThreadId;
    try {
      const detail = await interruptTask(threadId);
      if (
        actionToken !== this.interruptActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      if (!this.acceptTaskDetailRevision(threadId, detail.revision)) {
        return;
      }
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(
        threadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.emitTaskSnapshot();
      this.conversationUpdateKind = "live";
      this.render();
    } catch (error) {
      if (
        actionToken !== this.interruptActionToken ||
        threadId !== this.selectedThreadId
      ) {
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

    const actionToken = ++this.approvalActionToken;
    const threadId = this.selectedThreadId;
    try {
      const detail = await resolveTaskApproval(
        threadId,
        approvalId,
        decision,
      );
      if (
        actionToken !== this.approvalActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      if (!this.acceptTaskDetailRevision(threadId, detail.revision)) {
        return;
      }
      this.taskDetail = detail;
      this.observeTaskSettings(detail);
      this.setThreadEvents(
        threadId,
        mergeEvents(this.events, detail.events ?? []),
      );
      this.eventsPage = detail.eventsPage ?? this.eventsPage;
      this.emitTaskSnapshot();
      this.conversationUpdateKind = "live";
      this.render();
    } catch (error) {
      if (
        actionToken !== this.approvalActionToken ||
        threadId !== this.selectedThreadId
      ) {
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
    this.conversationUpdateKind = "preserve";
    const historyToken = ++this.historyRequestToken;
    const threadId = this.selectedThreadId;
    this.render();
    try {
      const detail = await getTask(threadId, cursor);
      if (
        historyToken !== this.historyRequestToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      if (taskDetailThreadId(detail) !== threadId || !detail?.task) {
        this.loadingOlderEvents = false;
        this.conversationUpdateKind = "preserve";
        this.render();
        return;
      }
      if (!this.acceptTaskDetailRevision(threadId, detail.revision)) {
        this.loadingOlderEvents = false;
        this.conversationUpdateKind = "preserve";
        this.render();
        return;
      }
      this.taskDetail = {
        ...detail,
        task: this.taskDetail?.task ?? detail.task,
      };
      this.setThreadEvents(
        threadId,
        mergeEvents(detail.events ?? [], this.events),
      );
      this.eventsPage = detail.eventsPage ?? { nextCursor: null };
      this.loadingOlderEvents = false;
      this.historyLoadError = null;
      this.conversationUpdateKind = "prepend";
      this.render();
    } catch (error) {
      if (
        historyToken !== this.historyRequestToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.loadingOlderEvents = false;
      this.historyLoadError = error;
      this.conversationUpdateKind = "preserve";
      this.render();
    }
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
      this.permissionOptionsLoaded = true;
    } catch (error) {
      if (requestId !== this.permissionOptionsRequestId) {
        return;
      }
      this.permissionOptions = [];
      this.permissionOptionsError = error;
      this.permissionOptionsLoaded = true;
      this.defaultPermissionMode = "askForApproval";
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

    if (this.selectedThreadId) {
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

  composerSettingsFor(formName) {
    return (
      this.composerSettingsByThread.get(this.selectedThreadId) ?? {
        model: "",
        effort: "",
      }
    );
  }

  editableComposerSettings(formName) {
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
      this.permissionOverrideThreadIds.has(this.selectedThreadId);
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
    if (form.dataset.taskForm === "follow-up") {
      this.followUpDraft = `${formData.get("prompt") ?? ""}`;
      const targetThreadId = `${threadId ?? this.selectedThreadId ?? ""}`.trim();
      if (targetThreadId) {
        this.followUpDraftByThread.set(targetThreadId, this.followUpDraft);
      }
    }
  }

  composerImages(formName) {
    return this.followUpImages;
  }

  setComposerImages(formName, images, threadId = this.selectedThreadId) {
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
    const previousComposerFocus = this.captureComposerFocus();
    const previousTaskFilePath = this.captureTaskFileBrowserPath();
    const previousTaskDiffPath = this.captureTaskDiffPath();
    const previousTaskCompareState = this.captureTaskCompareState();
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.ensureTaskShell();
    this.renderTaskContentRegion();
    this.syncComposerTextareas();
    this.restoreComposerFocus(previousComposerFocus);
    this.syncConversationSnapshot();
    this.updateTaskDetailView();
    this.syncTaskFileBrowser(previousTaskFilePath);
    this.syncTaskDiffBrowser(previousTaskDiffPath);
    this.syncTaskCompareBrowser(previousTaskCompareState);
    this.fitModelPicker();
  }

  ensureTaskShell() {
    if (this.querySelector(":scope > .tasks-detail-region")) {
      return;
    }

    this.innerHTML = `
      <div class="tasks-detail-region"></div>
    `;
  }

  conversationComponent() {
    return this.querySelector(
      ".task-conversation-pane caffold-task-conversation",
    );
  }

  isInitialConversationLoadPending(threadId = this.selectedThreadId) {
    return this.initialConversationLoad?.threadId === threadId;
  }

  liveConversationUpdateKind(threadId = this.selectedThreadId) {
    return this.isInitialConversationLoadPending(threadId) ? "bottom" : "live";
  }

  finishInitialConversationLoad(threadId, loadGeneration) {
    if (
      this.initialConversationLoad?.threadId === threadId &&
      this.initialConversationLoad.loadGeneration === loadGeneration
    ) {
      this.initialConversationLoad = null;
    }
  }

  syncConversationSnapshot() {
    const conversation = this.conversationComponent();
    const task = this.taskDetail?.task ?? null;
    const taskThreadIdValue = task?.threadId ?? task?.id ?? "";
    if (!conversation) {
      this.conversationUpdateKind = null;
      return;
    }
    if (!task || taskThreadIdValue !== this.selectedThreadId) {
      this.conversationUpdateKind = null;
      return;
    }
    conversation.setSnapshot({
      threadId: this.selectedThreadId,
      task,
      events: this.events,
      eventsPage: this.eventsPage,
      loading: Boolean(this.taskDetail?.historyLoading),
      loadingOlder: this.loadingOlderEvents,
      detailError: this.detailLoadError,
      historyError: this.historyLoadError,
      transportState: this.streamState,
      updateKind: this.conversationUpdateKind,
    });
    this.conversationUpdateKind = null;
  }

  renderTaskContentRegion() {
    const region = this.querySelector(".tasks-detail-region");
    if (!region) {
      return;
    }
    const currentDetail = region.querySelector(":scope > .task-detail");
    const threadId = this.taskDetail?.task?.threadId ?? this.taskDetail?.task?.id ?? "";
    if (this.view === "detail" && currentDetail) {
      const template = document.createElement("template");
      template.innerHTML = this.renderBody().trim();
      const nextRoot = template.content.firstElementChild;
      const nextDetail = nextRoot?.matches(".task-detail") ? nextRoot : null;
      if (!nextDetail || !threadId) {
        currentDetail.hidden = true;
        const placeholder = document.createElement("div");
        placeholder.className = "task-detail-placeholder";
        placeholder.append(...template.content.childNodes);
        region
          .querySelector(":scope > .task-detail-placeholder")
          ?.replaceWith(placeholder);
        if (!region.querySelector(":scope > .task-detail-placeholder")) {
          region.append(placeholder);
        }
        return;
      }
      region.querySelector(":scope > .task-detail-placeholder")?.remove();
      currentDetail.hidden = false;
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
        const currentTaskConversation = currentConversation.querySelector(
          ":scope > caffold-task-conversation",
        );
        const nextTaskConversation = nextConversation.querySelector(
          ":scope > caffold-task-conversation",
        );
        if (currentTaskConversation && nextTaskConversation) {
          [...currentConversation.children].forEach((child) => {
            if (child !== currentTaskConversation) {
              child.remove();
            }
          });
          [...nextConversation.children].forEach((child) => {
            if (child !== nextTaskConversation) {
              currentConversation.append(child);
            }
          });
        } else {
          currentConversation.replaceChildren(...nextConversation.childNodes);
        }
      }
      for (const selector of [".task-files-view", ".task-diff-view"]) {
        const currentSubview = currentDetail.querySelector(`:scope > ${selector}`);
        const nextSubview = nextDetail.querySelector(`:scope > ${selector}`);
        if (currentSubview && nextSubview) {
          currentSubview.replaceWith(nextSubview);
        }
      }
      currentDetail.dataset.threadId = threadId;
      currentDetail.dataset.taskDetailView = this.taskDetailView;
      return;
    }

    region.innerHTML = this.renderBody();
  }

  captureComposerFocus() {
    const textarea = closestElement(document.activeElement, "textarea[name='prompt']");
    if (
      !textarea ||
      !this.contains(textarea) ||
      closestElement(textarea, "caffold-task-composer")
    ) {
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
      `.tasks-detail-region form[data-task-form="${CSS.escape(previousFocus.formName)}"] textarea[name="prompt"]`,
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

    this.taskDetailView = nextView;
    this.updateTaskDetailView();
    this.syncTaskFileBrowser();
    this.syncTaskDiffBrowser();
    this.syncTaskCompareBrowser();
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

  activeCwdPath() {
    return this.selectedTaskContextPath() || ".";
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
    this.querySelectorAll(
      ".tasks-detail-region textarea[name='prompt']",
    ).forEach((textarea) => syncComposerTextarea(textarea));
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
    if (this.view === "detail") {
      return this.renderTaskDetail();
    }
    return "";
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
    const transportBlocked = isTaskTransportStale(this.streamState);
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
      ".tasks-detail-region .task-model-picker.is-open .task-model-popover",
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
    return `
      <div class="task-detail" data-thread-id="${escapeHtml(task.threadId ?? task.id)}" data-task-detail-view="${escapeHtml(this.taskDetailView)}" data-task-availability="${escapeHtml(this.streamState)}">
        ${this.renderTaskDetailSummary(task)}
        <section class="task-conversation-pane" aria-label="Task conversation">
          <caffold-task-conversation></caffold-task-conversation>
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
    const continuation = this.continuationStateValue;
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

if (!customElements.get("caffold-task-detail")) {
  customElements.define("caffold-task-detail", CaffoldTaskDetail);
}

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
