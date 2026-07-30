import {
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
    this.followUpRequest = null;
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
    this.boundVisibilityChange = () => this.handleVisibilityChange();
    warmIcons();

    this.addEventListener(
      "click",
      (event) => {
        if (
          closestElement(
            event.target,
            "caffold-task-conversation, caffold-task-composer",
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
    this.addEventListener("caffold:task-composer-submit", (event) => {
      const composer = closestElement(event.target, "caffold-task-composer");
      if (!composer || composer !== this.followUpComposer()) {
        return;
      }
      event.stopPropagation();
      void this.sendFollowUpSubmission(composer, event.detail).catch((error) => {
        const submissionId = `${event.detail?.submissionId ?? ""}`;
        composer.resolveSubmission(submissionId, {
          status: "rejected",
          error,
        });
      });
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
    document.addEventListener("visibilitychange", this.boundVisibilityChange);
  }

  detachGlobalListeners() {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
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
    request.composer?.resolveSubmission(request.submissionId, {
      status: "accepted",
    });
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

  async sendFollowUpSubmission(composer, submission = {}) {
    const submissionId = `${submission.submissionId ?? ""}`;
    const threadId = `${submission.threadId ?? this.selectedThreadId ?? ""}`.trim();
    const prompt = `${submission.prompt ?? ""}`.trim();
    const images = [...(submission.images ?? [])];
    const attachments = [...(submission.attachments ?? [])];
    if (!submissionId || !threadId || (!prompt && !images.length)) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error("Could not identify this task prompt."),
      });
      return;
    }
    if (this.selectedThreadId !== threadId) {
      this.selectedThreadId = threadId;
      this.activateThreadEvents(threadId);
    }
    if (isTaskTransportStale(this.streamState)) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error(
          "Caffold server is unavailable. Wait for the task to reconnect.",
        ),
      });
      return;
    }
    if (this.followUpRequest?.threadId === threadId) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error("A prompt is already being submitted for this task."),
      });
      return;
    }

    const previousTask =
      taskThreadId(this.taskDetail?.task) === threadId
        ? this.taskDetail.task
        : null;
    const active = isTaskActivelyWorking(previousTask);
    const options = active
      ? {
          activeTurnId: previousTask?.activeTurn?.id ?? null,
        }
      : {
          ...(submission.options ?? {}),
          activeTurnId: null,
        };
    const requestId = ++this.promptSubmissionSequence;
    const optimisticEvent = optimisticUserMessageEvent(
      threadId,
      prompt,
      attachments,
      requestId,
    );
    const followUpRequest = {
      submissionId,
      composer,
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
    this.error = null;
    this.setThreadEvents(
      threadId,
      mergeEvents(this.eventsByThread.get(threadId) ?? [], [optimisticEvent]),
    );
    this.conversationUpdateKind = "bottom";
    this.render();

    try {
      const response = await sendTaskPrompt(
        threadId,
        prompt,
        options,
        images,
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
        composer.resetOverrides(threadId);
      }
      composer.resolveSubmission(submissionId, {
        status: "accepted",
        resetOverrides: !response?.steered,
      });
      if (threadId === this.selectedThreadId) {
        this.conversationUpdateKind = "live";
      }
    } catch (error) {
      if (followUpRequest.state === PROMPT_SUBMISSION_STATE.ACCEPTED) {
        return;
      }
      const failureState = classifyPromptFailure(error);
      followUpRequest.state = failureState;
      if (failureState === PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN) {
        this.setThreadEvents(
          threadId,
          (this.eventsByThread.get(threadId) ?? []).map((event) =>
            event.id === optimisticEvent.id
              ? withPromptSubmissionState(event, failureState)
              : event,
          ),
        );
        composer.resolveSubmission(submissionId, {
          status: "outcome-unknown",
          error,
        });
        if (threadId === this.selectedThreadId) {
          this.error = error;
          this.conversationUpdateKind = "live";
        }
      } else {
        this.setThreadEvents(
          threadId,
          (this.eventsByThread.get(threadId) ?? []).filter(
            (event) => event.id !== optimisticEvent.id,
          ),
        );
        composer.resolveSubmission(submissionId, {
          status: "rejected",
          error,
        });
        if (threadId === this.selectedThreadId) {
          this.error = error;
          this.conversationUpdateKind = "preserve";
        }
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


  render() {
    const previousTaskFilePath = this.captureTaskFileBrowserPath();
    const previousTaskDiffPath = this.captureTaskDiffPath();
    const previousTaskCompareState = this.captureTaskCompareState();
    this.setAttribute("data-task-detail-view", this.taskDetailView);
    this.ensureTaskShell();
    this.renderTaskContentRegion();
    this.syncConversationSnapshot();
    this.syncFollowUpComposer();
    this.updateTaskDetailView();
    this.syncTaskFileBrowser(previousTaskFilePath);
    this.syncTaskDiffBrowser(previousTaskDiffPath);
    this.syncTaskCompareBrowser(previousTaskCompareState);
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

  followUpComposer() {
    return this.querySelector(
      ".task-conversation-pane caffold-task-composer",
    );
  }

  syncFollowUpComposer() {
    const composer = this.followUpComposer();
    const task = this.taskDetail?.task ?? null;
    const threadId = taskThreadId(task);
    if (!composer || !task || threadId !== this.selectedThreadId) {
      return;
    }
    composer.setContext({
      mode: "follow-up",
      stateKey: threadId,
      threadId,
      cwd: this.activeCwdPath(),
      className: "task-follow-up-form",
      placeholder: "Send another prompt to this task",
      ariaLabel: "Follow-up prompt",
      submitLabel: "Send prompt",
      disabled: isTaskTransportStale(this.streamState),
      settingsLocked: isTaskActivelyWorking(task),
      model: `${this.taskDetail?.model ?? ""}`.trim(),
      effort: `${this.taskDetail?.reasoningEffort ?? ""}`.trim(),
      permissionMode: `${this.taskDetail?.permissionMode ?? ""}`.trim(),
      requestError: this.error?.message ?? "",
    });
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
        if (this.detailLoadError && !this.taskDetail?.task) {
          currentDetail.remove();
        } else {
          currentDetail.hidden = true;
        }
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
        const stableChildren = new Map(
          ["caffold-task-conversation", "caffold-task-composer"].map((tag) => [
            tag,
            currentConversation.querySelector(`:scope > ${tag}`),
          ]),
        );
        [...currentConversation.children].forEach((child) => {
          if (![...stableChildren.values()].includes(child)) {
            child.remove();
          }
        });
        let insertionPoint = currentConversation.firstElementChild;
        [...nextConversation.children].forEach((child) => {
          const desiredChild = stableChildren.get(child.localName) ?? child;
          if (desiredChild === insertionPoint) {
            insertionPoint = insertionPoint.nextElementSibling;
          } else {
            currentConversation.insertBefore(desiredChild, insertionPoint);
          }
        });
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
          <caffold-task-composer></caffold-task-composer>
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
