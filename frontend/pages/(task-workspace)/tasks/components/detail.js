import {
  archiveTask,
  getTask,
  interruptTask,
  markTaskSeen,
  resolveTaskApproval,
  sendTaskPrompt,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { routeDomain } from "../../../../navigation-routes.js";
import "./composer.js";
import "./detail/conversation.js";
import "./detail/conversation/command-dialog.js";
import "./detail/(git)/layout.js";
import "./detail/(github)/layout.js";
import "./detail/review.js";
import "./detail/summary.js";
import "./task-transport-overlay.js";
import { TaskDetailStream } from "./detail/stream.js";
import {
  PROMPT_SUBMISSION_STATE,
  TASK_TRANSPORT_STATE,
  classifyPromptFailure,
  isTaskActivelyWorking,
  isTaskTransportStale,
  promptSubmissionState,
  taskActiveFlagLabel,
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
import { cleanLogicalPath } from "../task-format.js";
import {
  taskDetailThreadId,
  taskRepositoryPath,
  taskThreadId,
} from "../task-list-model.js";

const CLEAN_COMPOSER_CACHE_LIMIT = 6;
const CLEAN_REVIEW_CACHE_LIMIT = 6;

class CaffoldTaskDetail extends HTMLElement {
  connectedCallback() {
    const reconnecting = Boolean(this.rendered);
    this.ensureRendered();
    if (reconnecting) {
      this.render();
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.view = "detail";
    this.taskDetail = null;
    this.taskDetailRevisionByThread = new Map();
    this.events = [];
    this.eventsThreadId = "";
    this.eventsByThread = new Map();
    this.eventsPage = { nextCursor: null };
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.loading = false;
    this.loadingOlderEvents = false;
    this.selectedThreadId = "";
    this.detailStream = new TaskDetailStream({
      onTaskSync: (message) => this.applyTaskStreamSync(message),
      onTaskEvent: (message) => this.applyTaskStreamEvent(message),
      onRefresh: (threadId, isCurrent, { recovery } = {}) =>
        this.refreshSelectedTask(threadId, isCurrent, {
          resetRevision: recovery,
        }),
      onStateChange: (state, previousState) =>
        this.handleStreamStateChange(state, previousState),
    });
    this.detailLoadGeneration = 0;
    this.seenRequestKeys = new Set();
    this.historyRequestToken = 0;
    this.interruptActionToken = 0;
    this.interruptStateValue = { loading: false, error: null };
    this.archiveActionToken = 0;
    this.approvalActionToken = 0;
    this.promptSubmissionSequence = 0;
    this.archiveStateValue = { loading: false, error: null };
    this.conversationUpdateKind = null;
    this.initialConversationLoad = null;
    this.followUpRequests = new Map();
    this.followUpComposers = new Map();
    this.followUpComposerLastUsed = new Map();
    this.followUpComposerUseSequence = 0;
    this.activeFollowUpComposerThreadId = "";
    this.reviewComponents = new Map();
    this.reviewLastUsed = new Map();
    this.reviewUseSequence = 0;
    this.activeReviewThreadId = "";
    this.gitLayoutInstance = null;
    this.githubLayoutInstance = null;
    this.domainActivationFingerprint = "";
    this.taskRoute = null;
    this.reviewView = "conversation";
    this.taskContentRenderKey = "";

    this.addEventListener(
      "click",
      (event) => {
        if (
          closestElement(
            event.target,
            "caffold-task-detail-summary, caffold-task-conversation, caffold-task-composer, caffold-task-review, caffold-task-git-layout, caffold-task-github-layout",
          )
        ) {
          return;
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
      } else if (event.detail?.type === "command-output") {
        this.commandDialog()?.openCommand(
          event.detail.command,
          event.detail.commandKey,
        );
      }
    });
    this.addEventListener("caffold:task-command-dialog-closed", (event) => {
      event.stopPropagation();
      const returnFocusKey = `${event.detail?.returnFocusKey ?? ""}`;
      if (returnFocusKey) {
        this.conversationComponent()?.focusCommandOutputAction(returnFocusKey);
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
    this.addEventListener("caffold:task-composer-intent", (event) => {
      const composer = closestElement(event.target, "caffold-task-composer");
      if (
        !composer ||
        composer !== this.followUpComposer() ||
        event.detail?.type !== "interrupt"
      ) {
        return;
      }
      event.stopPropagation();
      void this.interruptSelectedTask();
    });
    this.addEventListener("caffold:task-composer-layout-change", (event) => {
      const composer = closestElement(event.target, "caffold-task-composer");
      if (!composer || composer !== this.followUpComposer()) {
        return;
      }
      event.stopPropagation();
      this.conversationComponent()?.reconcileViewportResize();
    });
    this.addEventListener("caffold:task-review-route-intent", (event) => {
      const review = closestElement(event.target, "caffold-task-review");
      if (!review || review !== this.taskReview()) {
        return;
      }
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent("caffold:task-detail-intent", {
          bubbles: true,
          composed: true,
          detail: {
            type: "review-route",
            route: event.detail?.route,
            replace: Boolean(event.detail?.replace),
          },
        }),
      );
    });
    this.addEventListener("caffold:request-git-route", (event) => {
      if (!this.gitLayoutInstance || !this.gitLayoutInstance.contains(event.target)) {
        return;
      }
      event.stopPropagation();
      this.requestDomainRoute(event.detail?.route, event.detail?.options);
    });
    this.addEventListener("caffold:request-github-route", (event) => {
      if (
        !this.githubLayoutInstance ||
        !this.githubLayoutInstance.contains(event.target)
      ) {
        return;
      }
      event.stopPropagation();
      this.requestDomainRoute(event.detail?.route, event.detail?.options);
    });
    this.addEventListener("caffold:change-compare-refs", (event) => {
      if (!this.gitLayoutInstance || !this.gitLayoutInstance.contains(event.target)) {
        return;
      }
      event.stopPropagation();
      this.requestDomainRoute(
        this.gitLayoutInstance.routeForCompareRefs(
          event.detail?.baseRef,
          event.detail?.headRef,
        ),
      );
    });
    this.addEventListener("caffold:refresh-git-review", (event) => {
      if (!this.gitLayoutInstance || !this.gitLayoutInstance.contains(event.target)) {
        return;
      }
      event.stopPropagation();
      void this.gitLayoutInstance.refresh();
    });
    this.addEventListener("caffold:task-detail-summary-intent", (event) => {
      const summary = closestElement(
        event.target,
        "caffold-task-detail-summary",
      );
      if (!summary || summary !== this.taskSummary()) {
        return;
      }
      event.stopPropagation();
      this.handleSummaryIntent(event.detail);
    });
    this.render();
  }

  disconnectedCallback() {
    this.deactivate();
    this.disposeFollowUpComposers();
    this.disposeReviews();
    this.disposeDomainChildren();
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
      this.taskRoute = normalizeTaskRoute(options.route, targetThreadId);
      const nextReviewView = taskDetailSurface(this.taskRoute);
      if (this.reviewView !== nextReviewView) {
        this.deactivateSelectedChild(this.reviewView);
      }
      if (this.reviewView === "conversation" && nextReviewView !== "conversation") {
        this.conversationComponent()?.setActive(false);
      }
      this.reviewView = nextReviewView;
      this.detailLoadError = null;
      this.activateThreadEvents(targetThreadId);
      this.render();
      return;
    }

    if (this.selectedThreadId !== targetThreadId) {
      this.deactivateFollowUpComposer();
      this.detailLoadGeneration += 1;
      this.historyRequestToken += 1;
      this.interruptActionToken += 1;
      this.interruptStateValue = { loading: false, error: null };
      this.archiveActionToken += 1;
      this.approvalActionToken += 1;
      this.archiveStateValue = { loading: false, error: null };
      this.loadingOlderEvents = false;
      this.deactivateReview({ prune: false });
      this.disposeDomainChildren();
      this.reviewView = "conversation";
      this.detailStream.deactivate();
    }
    this.view = "detail";
    this.hidden = false;
    this.selectedThreadId = targetThreadId;
    this.taskRoute = normalizeTaskRoute(options.route, targetThreadId);
    this.reviewView = taskDetailSurface(this.taskRoute);
    this.activateThreadEvents(targetThreadId);
    this.taskDetail =
      taskDetailThreadId(this.taskDetail) === targetThreadId
        ? this.taskDetail
        : null;
    this.eventsPage =
      taskDetailThreadId(this.taskDetail) === targetThreadId
        ? this.eventsPage
        : { nextCursor: null };
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
      this.detailStream.activate(targetThreadId);
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
    this.interruptActionToken += 1;
    this.interruptStateValue = { loading: false, error: null };
    this.selectedThreadId = threadId;
    this.view = "detail";
    this.hidden = false;
    if (
      !this.applyCanonicalTaskDetail(threadId, detail, {
        resetRevision: true,
        updateKind: "bottom",
        clearHistoryError: true,
      })
    ) {
      return false;
    }
    this.detailStream.activate(threadId);
    return true;
  }

  deactivate({ retainComposerDom = false } = {}) {
    this.detailLoadGeneration += 1;
    this.historyRequestToken += 1;
    this.interruptActionToken += 1;
    this.interruptStateValue = { loading: false, error: null };
    this.archiveActionToken += 1;
    this.approvalActionToken += 1;
    this.archiveStateValue = { loading: false, error: null };
    this.loadingOlderEvents = false;
    this.initialConversationLoad = null;
    this.detailStream.deactivate();
    if (retainComposerDom) {
      this.endFollowUpComposerEditingLifetime(
        this.activeFollowUpComposerThreadId,
        this.followUpComposer(),
      );
    } else {
      this.deactivateFollowUpComposer();
    }
    this.deactivateReview();
    this.deactivateDomainChildren();
    this.taskSummary()?.deactivate();
    this.commandDialog()?.dismiss({ restoreFocus: false });
    this.hidden = true;
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
    this.detailLoadError = null;
    this.historyLoadError = null;
    this.render();
    const detailRequest = getTask(threadId);
    this.detailStream.activate(threadId);

    try {
      const detail = await detailRequest;
      if (loadGeneration !== this.detailLoadGeneration) {
        return null;
      }
      const updateKind = this.isInitialConversationLoadPending(threadId)
        ? "bottom"
        : "preserve";
      if (
        !this.applyCanonicalTaskDetail(threadId, detail, {
          updateKind,
          clearHistoryError: true,
        })
      ) {
        this.finishInitialConversationLoad(threadId, loadGeneration);
        return null;
      }
      this.finishInitialConversationLoad(threadId, loadGeneration);
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
    const currentEvents = this.eventsByThread.get(threadId) ?? [];
    // Canonical sync rebuilds JSON records even when their visible state is
    // unchanged. Preserve identity so each child can keep its render boundary.
    const stableEvents = sameStructuredValue(currentEvents, nextEvents)
      ? currentEvents
      : nextEvents;
    this.eventsByThread.set(threadId, stableEvents);
    if (threadId !== this.selectedThreadId) {
      return;
    }
    this.eventsThreadId = threadId;
    this.events = stableEvents;
  }

  applyTaskStreamSync(message) {
    const threadId = `${message?.threadId ?? ""}`;
    const detail = message?.detail;
    this.applyCanonicalTaskDetail(threadId, detail, {
      revision: message.revision,
      resetRevision: message.reason === "stream-bootstrap",
      detailError: message.error,
      updateKind: this.liveConversationUpdateKind(threadId),
    });
  }

  applyTaskStreamEvent(message) {
    const threadId = `${message?.threadId ?? ""}`;
    const entry = withEventFileLinks(message?.event, message?.fileLinks);
    if (
      threadId !== this.selectedThreadId ||
      !entry ||
      entry.threadId !== threadId ||
      !this.acceptTaskDetailRevision(threadId, message.revision)
    ) {
      return;
    }
    this.setThreadEvents(threadId, upsertEvent(this.events, entry));
    this.conversationUpdateKind = this.liveConversationUpdateKind(threadId);
    this.render();
  }

  applyCanonicalTaskDetail(
    threadId,
    detail,
    {
      revision = detail?.revision,
      resetRevision = false,
      preserveCurrentTask = false,
      preferCurrentEvents = false,
      updateKind = "preserve",
      detailError = null,
      clearHistoryError = false,
      reconcilePrompt = true,
    } = {},
  ) {
    if (
      threadId !== this.selectedThreadId ||
      taskDetailThreadId(detail) !== threadId
    ) {
      return false;
    }
    if (resetRevision) {
      // Session revisions are process-local, so a reconnect after a server
      // restart can authoritatively bootstrap at a lower revision.
      this.taskDetailRevisionByThread.delete(threadId);
    }
    if (!this.acceptTaskDetailRevision(threadId, revision)) {
      return false;
    }
    if (reconcilePrompt) {
      this.acknowledgeFollowUpFromCanonicalDetail(threadId, detail);
    }
    const currentTask =
      taskDetailThreadId(this.taskDetail) === threadId
        ? this.taskDetail?.task
        : null;
    const nextTask = preserveCurrentTask
      ? currentTask ?? detail.task
      : detail.task;
    const stableTask =
      currentTask && sameStructuredValue(currentTask, nextTask)
        ? currentTask
        : nextTask;
    if (!isTaskActivelyWorking(stableTask) || !stableTask?.activeTurn?.id) {
      this.interruptStateValue = { loading: false, error: null };
    }
    this.taskDetail = {
      ...detail,
      task: stableTask,
    };
    const currentEvents = this.eventsByThread.get(threadId) ?? [];
    const incomingEvents = withDetailFileLinks(
      detail.events ?? [],
      detail.fileLinks,
    );
    this.setThreadEvents(
      threadId,
      preferCurrentEvents
        ? mergeEvents(incomingEvents, currentEvents)
        : mergeEvents(currentEvents, incomingEvents),
    );
    this.eventsPage = mergeTaskEventsPage(this.eventsPage, detail);
    const canonicalError =
      detailError instanceof Error
        ? detailError
        : detailError
          ? new Error(`${detailError}`)
          : null;
    this.loading = detail?.syncState === "loading" && !canonicalError;
    this.detailLoadError = canonicalError;
    if (clearHistoryError) {
      this.historyLoadError = null;
    }
    if (!preserveCurrentTask && this.taskDetail?.task) {
      this.emitTaskSnapshot();
    }
    this.conversationUpdateKind = updateKind;
    this.render();
    this.markDisplayedTaskSeen(threadId, this.taskDetail?.task);
    return true;
  }

  markDisplayedTaskSeen(threadId, task) {
    if (!task?.unseen || taskThreadId(task) !== threadId) {
      return;
    }
    const completionKey =
      task.lastCompletedMs ?? task.recencyMs ?? task.updatedMs ?? "unknown";
    const requestKey = `${threadId}:${completionKey}`;
    if (this.seenRequestKeys.has(requestKey)) {
      return;
    }
    this.seenRequestKeys.add(requestKey);
    void markTaskSeen(threadId)
      .then((canonicalTask) => {
        if (
          threadId !== this.selectedThreadId ||
          taskDetailThreadId(this.taskDetail) !== threadId ||
          !canonicalTask
        ) {
          return;
        }
        this.taskDetail = {
          ...this.taskDetail,
          task: canonicalTask,
        };
        this.emitTaskSnapshot();
        this.render();
      })
      .catch(() => {
        this.seenRequestKeys.delete(requestKey);
      });
  }

  acknowledgeFollowUpFromCanonicalDetail(threadId, detail) {
    const request = this.followUpRequests.get(threadId);
    if (!request) {
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
    request.canonicalConfirmed = true;
    this.releaseConfirmedFollowUpOverrides(request);
    request.composer?.resolveSubmission(request.submissionId, {
      status: "accepted",
    });
    if (this.followUpRequests.get(threadId) === request) {
      this.followUpRequests.delete(threadId);
    }
  }

  releaseConfirmedFollowUpOverrides(request) {
    if (
      request?.overridesReleased ||
      !request?.canonicalConfirmed ||
      request?.resetOverridesOnCanonical !== true
    ) {
      return;
    }
    request.composer?.resetOverrides();
    request.overridesReleased = true;
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

  handleStreamStateChange(state, previousState) {
    if (
      this.view === "detail" &&
      (isVisibleStreamState(previousState) || isVisibleStreamState(state))
    ) {
      this.render();
    }
  }

  get streamState() {
    return this.detailStream?.state ?? TASK_TRANSPORT_STATE.IDLE;
  }

  retryStream() {
    if (!this.selectedThreadId) {
      return;
    }
    this.detailStream.activate(this.selectedThreadId, { force: true });
    this.render();
  }

  async refreshSelectedTask(
    threadId,
    isCurrent = () => true,
    { resetRevision = false } = {},
  ) {
    const loadGeneration = this.detailLoadGeneration;
    if (resetRevision) {
      if (
        !isCurrent() ||
        loadGeneration !== this.detailLoadGeneration ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.taskDetailRevisionByThread.delete(threadId);
    }
    const detail = await getTask(threadId);
    if (
      !isCurrent() ||
      loadGeneration !== this.detailLoadGeneration ||
      threadId !== this.selectedThreadId
    ) {
      return;
    }
    if (this.applyCanonicalTaskDetail(threadId, detail, {
      updateKind: this.liveConversationUpdateKind(threadId),
    })) {
      return true;
    }
    const revision = Number(detail?.revision);
    const currentRevision = this.taskDetailRevisionByThread.get(threadId) ?? 0;
    return (
      taskDetailThreadId(detail) === threadId &&
      Number.isFinite(revision) &&
      revision > 0 &&
      currentRevision > revision
    );
  }

  handleAction(action, element) {
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
    if (action === "approval") {
      this.resolveApproval(element.dataset.approvalId, element.dataset.decision);
    }
  }

  handleSummaryIntent(intent = {}) {
    const action = intent.type;
    if (action === "open-git-tool" || action === "open-github-tool") {
      this.openTaskReviewRoute(action, intent.reviewKind);
      return;
    }
    if (action === "open-review") {
      this.requestReviewRoute({ review: true });
      return;
    }
    if (action === "open-review-scope") {
      this.requestReviewRoute({
        review: true,
        scope: intent.reviewScope,
      });
      return;
    }
    if (action === "open-conversation") {
      this.requestReviewRoute({ review: false });
      return;
    }
    if (action === "archive") {
      void this.archiveSelectedTask();
    }
  }

  requestReviewRoute(options = {}) {
    if (!this.selectedThreadId) {
      return;
    }
    const preservedReviewRoute = this.reviewComponents
      .get(this.selectedThreadId)
      ?.currentTaskRoute?.();
    let route = options.review
      ? preservedReviewRoute ?? {
          kind: "tasks",
          threadId: this.selectedThreadId,
          review: true,
          reviewScope: "working",
          reviewNavigator: this.taskDetail?.task?.worktree ? "changes" : "files",
          reviewViewer: this.taskDetail?.task?.worktree ? "diff" : "source",
          path: "",
          baseRef: "",
        }
      : { kind: "tasks", threadId: this.selectedThreadId };
    if (options.review && ["working", "branch"].includes(options.scope)) {
      route = {
        ...route,
        review: true,
        reviewScope: options.scope,
      };
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "review-route", route, replace: false },
      }),
    );
  }

  openTaskReviewRoute(action, kind) {
    const task = this.taskDetail?.task;
    const threadId = taskThreadId(task);
    if (!threadId || !taskWorktreeRootPath(task) || !kind) {
      return;
    }
    if (kind === "diff") {
      this.requestReviewRoute({ review: true, scope: "working" });
      return;
    }
    const route = kind === "compare"
      ? { kind, threadId, baseRef: "", headRef: "", path: "" }
      : kind === "log"
        ? { kind, threadId, page: 1, sha: "", path: "" }
        : kind === "issues"
          ? { kind, threadId, page: 1, number: null }
          : { kind: "pulls", threadId, page: 1, number: null, files: false, path: "" };
    this.requestDomainRoute(route);
  }

  requestDomainRoute(route, options = {}) {
    if (!route || !this.selectedThreadId) {
      return;
    }
    const rootPath = taskWorktreeRootPath(this.taskDetail?.task);
    const taskRoute = {
      ...route,
      ...(route.path
        ? { path: taskRelativePath(rootPath, route.path) }
        : {}),
      threadId: this.selectedThreadId,
    };
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: "domain-route",
          route: taskRoute,
          replace: Boolean(options?.replace),
        },
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
    if (
      this.selectedThreadId !== threadId ||
      taskThreadId(this.taskDetail?.task) !== threadId ||
      this.followUpComposers.get(threadId) !== composer ||
      this.followUpComposer() !== composer
    ) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error(
          "This prompt belongs to a task that is no longer selected.",
        ),
      });
      return;
    }
    if (isTaskTransportStale(this.detailStream.state)) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error(
          "Caffold server is unavailable. Wait for the task to reconnect.",
        ),
      });
      return;
    }
    if (
      this.followUpRequests.get(threadId)?.state ===
      PROMPT_SUBMISSION_STATE.SENDING
    ) {
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
      canonicalConfirmed: false,
      resetOverridesOnCanonical: null,
      overridesReleased: false,
    };
    this.followUpRequests.set(threadId, followUpRequest);
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
      followUpRequest.resetOverridesOnCanonical = !response?.steered;
      this.releaseConfirmedFollowUpOverrides(followUpRequest);
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
      composer.resolveSubmission(submissionId, {
        status: "accepted",
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
          this.conversationUpdateKind = "preserve";
        }
      }
    } finally {
      if (
        this.followUpRequests.get(threadId) === followUpRequest &&
        followUpRequest.state !== PROMPT_SUBMISSION_STATE.ACCEPTED
      ) {
        this.followUpRequests.delete(threadId);
      }
      if (this.activeFollowUpComposerThreadId !== threadId) {
        this.endFollowUpComposerEditingLifetime(threadId, composer);
      }
      this.pruneFollowUpComposerCache();
      if (threadId === this.selectedThreadId) {
        this.render();
      }
    }
  }

  async interruptSelectedTask() {
    const task = this.taskDetail?.task ?? null;
    if (
      !this.selectedThreadId ||
      this.interruptStateValue.loading ||
      !isTaskActivelyWorking(task) ||
      !task?.activeTurn?.id ||
      isTaskTransportStale(this.detailStream.state)
    ) {
      return;
    }

    const actionToken = ++this.interruptActionToken;
    const threadId = this.selectedThreadId;
    this.interruptStateValue = { loading: true, error: null };
    this.syncFollowUpComposer();
    try {
      const detail = await interruptTask(threadId);
      if (
        actionToken !== this.interruptActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.interruptStateValue = { loading: false, error: null };
      if (
        !this.applyCanonicalTaskDetail(threadId, detail, {
          updateKind: "live",
        })
      ) {
        this.syncFollowUpComposer();
        return;
      }
    } catch (error) {
      if (
        actionToken !== this.interruptActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.interruptStateValue = { loading: false, error };
      this.syncFollowUpComposer();
    }
  }

  async archiveSelectedTask() {
    if (
      !this.selectedThreadId ||
      this.archiveStateValue.loading ||
      isTaskTransportStale(this.detailStream.state)
    ) {
      return;
    }
    const actionToken = ++this.archiveActionToken;
    const threadId = this.selectedThreadId;
    this.archiveStateValue = { loading: true, error: null };
    this.syncTaskSummary();
    try {
      const task = await archiveTask(threadId);
      if (
        actionToken !== this.archiveActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.archiveStateValue = { loading: false, error: null };
      this.dispatchEvent(
        new CustomEvent("caffold:task-detail-intent", {
          bubbles: true,
          composed: true,
          detail: { type: "task-archived", task },
        }),
      );
    } catch (error) {
      if (
        actionToken !== this.archiveActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.archiveStateValue = { loading: false, error };
      this.syncTaskSummary();
    }
  }

  async resolveApproval(approvalId, decision) {
    if (
      !this.selectedThreadId ||
      !approvalId ||
      !decision ||
      isTaskTransportStale(this.detailStream.state)
    ) {
      return;
    }

    const actionToken = ++this.approvalActionToken;
    const threadId = this.selectedThreadId;
    this.conversationComponent()?.setApprovalError(approvalId, null);
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
      if (
        !this.applyCanonicalTaskDetail(threadId, detail, {
          updateKind: "live",
        })
      ) {
        return;
      }
    } catch (error) {
      if (
        actionToken !== this.approvalActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.conversationComponent()?.setApprovalError(approvalId, error);
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
      this.loadingOlderEvents = false;
      if (
        !detail?.task ||
        !this.applyCanonicalTaskDetail(threadId, detail, {
          preserveCurrentTask: true,
          preferCurrentEvents: true,
          updateKind: "prepend",
          clearHistoryError: true,
          reconcilePrompt: false,
        })
      ) {
        this.conversationUpdateKind = "preserve";
        this.render();
        return;
      }
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

  render() {
    this.setAttribute("data-task-detail-view", this.reviewView);
    this.ensureTaskShell();
    this.renderTaskContentRegion();
    this.commandDialog()?.setThreadId(this.selectedThreadId);
    this.syncTaskSummary();
    this.syncFollowUpComposer();
    this.conversationComponent()?.setActive(
      this.reviewView === "conversation",
    );
    if (this.reviewView === "conversation") {
      this.syncConversationSnapshot();
    }
    this.syncTaskReview();
    this.syncDomainChildren();
  }

  ensureTaskShell() {
    if (this.querySelector(":scope > .tasks-detail-region")) {
      return;
    }

    this.innerHTML = `
      <div class="tasks-detail-region"></div>
    `;
    this.taskContentRenderKey = "";
  }

  conversationComponent() {
    return this.querySelector(
      ".task-conversation-pane caffold-task-conversation",
    );
  }

  commandDialog() {
    return this.querySelector(
      ".task-conversation-pane caffold-task-command-dialog",
    );
  }

  taskSummary() {
    return this.querySelector(
      ".task-detail > caffold-task-detail-summary",
    );
  }

  followUpComposer() {
    return this.activeFollowUpComposerThreadId
      ? this.followUpComposers.get(this.activeFollowUpComposerThreadId) ?? null
      : null;
  }

  followUpComposerSlot() {
    return this.querySelector(
      ".task-conversation-pane .task-follow-up-composer-slot",
    );
  }

  ensureFollowUpComposer(threadId) {
    let composer = this.followUpComposers.get(threadId);
    if (composer) {
      return composer;
    }
    composer = document.createElement("caffold-task-composer");
    composer.dataset.threadId = threadId;
    this.followUpComposers.set(threadId, composer);
    this.followUpComposerLastUsed.set(
      threadId,
      ++this.followUpComposerUseSequence,
    );
    return composer;
  }

  activateFollowUpComposer(threadId) {
    const composer = this.followUpComposers.get(threadId);
    const slot = this.followUpComposerSlot();
    if (!composer || !slot) {
      return null;
    }
    if (
      this.activeFollowUpComposerThreadId &&
      this.activeFollowUpComposerThreadId !== threadId
    ) {
      this.deactivateFollowUpComposer({ prune: false });
    }
    this.activeFollowUpComposerThreadId = threadId;
    this.followUpComposerLastUsed.set(
      threadId,
      ++this.followUpComposerUseSequence,
    );
    if (composer.parentElement !== slot) {
      slot.replaceChildren(composer);
    }
    this.pruneFollowUpComposerCache();
    return composer;
  }

  deactivateFollowUpComposer({ prune = true } = {}) {
    const threadId = this.activeFollowUpComposerThreadId;
    if (!threadId) {
      return;
    }
    const composer = this.followUpComposers.get(threadId);
    this.endFollowUpComposerEditingLifetime(threadId, composer);
    composer?.remove();
    this.followUpComposerLastUsed.set(
      threadId,
      ++this.followUpComposerUseSequence,
    );
    this.activeFollowUpComposerThreadId = "";
    if (prune) {
      this.pruneFollowUpComposerCache();
    }
  }

  endFollowUpComposerEditingLifetime(threadId, composer) {
    composer?.endEditingLifetime({
      preserveOptions: this.followUpRequests.has(threadId),
    });
  }

  shouldRetainFollowUpComposer(threadId, composer) {
    if (
      composer.hasRestorableState() ||
      this.followUpRequests.has(threadId)
    ) {
      return true;
    }
    return (this.eventsByThread.get(threadId) ?? []).some(
      (event) =>
        event?.type === "user_message" &&
        promptSubmissionState(event) ===
          PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN,
    );
  }

  pruneFollowUpComposerCache() {
    const cleanInactive = [...this.followUpComposers.entries()]
      .filter(
        ([threadId, composer]) =>
          threadId !== this.activeFollowUpComposerThreadId &&
          !this.shouldRetainFollowUpComposer(threadId, composer),
      )
      .sort(
        ([leftThreadId], [rightThreadId]) =>
          (this.followUpComposerLastUsed.get(leftThreadId) ?? 0) -
          (this.followUpComposerLastUsed.get(rightThreadId) ?? 0),
      );
    for (
      let index = 0;
      index < cleanInactive.length - CLEAN_COMPOSER_CACHE_LIMIT;
      index += 1
    ) {
      const [threadId, composer] = cleanInactive[index];
      composer.remove();
      this.followUpComposers.delete(threadId);
      this.followUpComposerLastUsed.delete(threadId);
    }
  }

  disposeFollowUpComposers() {
    for (const composer of this.followUpComposers.values()) {
      composer.remove();
    }
    this.followUpComposers.clear();
    this.followUpComposerLastUsed.clear();
    this.followUpComposerUseSequence = 0;
    this.activeFollowUpComposerThreadId = "";
  }

  taskReview() {
    return this.activeReviewThreadId
      ? this.reviewComponents.get(this.activeReviewThreadId) ?? null
      : null;
  }

  reviewSlot() {
    return this.querySelector(".task-detail > .task-review-slot");
  }

  ensureReview(threadId) {
    let review = this.reviewComponents.get(threadId);
    if (!review) {
      review = document.createElement("caffold-task-review");
      review.dataset.threadId = threadId;
      this.reviewComponents.set(threadId, review);
    }
    this.reviewLastUsed.set(threadId, ++this.reviewUseSequence);
    return review;
  }

  activateReview(threadId) {
    const slot = this.reviewSlot();
    if (!slot) {
      return null;
    }
    if (this.activeReviewThreadId && this.activeReviewThreadId !== threadId) {
      this.deactivateReview({ prune: false });
    }
    const review = this.ensureReview(threadId);
    this.activeReviewThreadId = threadId;
    if (review.parentElement !== slot) {
      slot.replaceChildren(review);
    }
    this.pruneReviewCache();
    return review;
  }

  deactivateReview({ prune = true } = {}) {
    const threadId = this.activeReviewThreadId;
    if (!threadId) {
      return;
    }
    this.reviewComponents.get(threadId)?.remove();
    this.reviewLastUsed.set(threadId, ++this.reviewUseSequence);
    this.activeReviewThreadId = "";
    if (prune) {
      this.pruneReviewCache();
    }
  }

  pruneReviewCache() {
    const inactive = [...this.reviewComponents.keys()]
      .filter((threadId) => threadId !== this.activeReviewThreadId)
      .sort(
        (left, right) =>
          (this.reviewLastUsed.get(left) ?? 0) -
          (this.reviewLastUsed.get(right) ?? 0),
      );
    const excess = Math.max(
      0,
      this.reviewComponents.size - CLEAN_REVIEW_CACHE_LIMIT,
    );
    for (let index = 0; index < excess; index += 1) {
      const threadId = inactive[index];
      this.reviewComponents.get(threadId)?.remove();
      this.reviewComponents.delete(threadId);
      this.reviewLastUsed.delete(threadId);
    }
  }

  disposeReviews() {
    for (const review of this.reviewComponents.values()) {
      review.remove();
    }
    this.reviewComponents.clear();
    this.reviewLastUsed.clear();
    this.activeReviewThreadId = "";
  }

  domainSlot(domain) {
    return this.querySelector(`.task-detail > .task-${domain}-slot`);
  }

  ensureDomainChild(domain) {
    const slot = this.domainSlot(domain);
    if (!slot) {
      return null;
    }
    if (domain === "git") {
      if (!this.gitLayoutInstance) {
        this.gitLayoutInstance = document.createElement("caffold-task-git-layout");
      }
      if (this.gitLayoutInstance.parentElement !== slot) {
        slot.replaceChildren(this.gitLayoutInstance);
      }
      return this.gitLayoutInstance;
    }
    if (!this.githubLayoutInstance) {
      this.githubLayoutInstance = document.createElement(
        "caffold-task-github-layout",
      );
    }
    if (this.githubLayoutInstance.parentElement !== slot) {
      slot.replaceChildren(this.githubLayoutInstance);
    }
    return this.githubLayoutInstance;
  }

  deactivateSelectedChild(surface = this.reviewView) {
    if (surface === "review") {
      this.deactivateReview();
    } else if (surface === "git") {
      this.gitLayoutInstance?.deactivate();
    } else if (surface === "github") {
      this.githubLayoutInstance?.deactivate();
    }
  }

  deactivateDomainChildren() {
    this.gitLayoutInstance?.deactivate();
    this.githubLayoutInstance?.deactivate();
    this.domainActivationFingerprint = "";
  }

  disposeDomainChildren() {
    this.deactivateDomainChildren();
    this.gitLayoutInstance?.remove();
    this.githubLayoutInstance?.remove();
    this.gitLayoutInstance = null;
    this.githubLayoutInstance = null;
  }

  syncDomainChildren() {
    const surface = this.reviewView;
    const gitSlot = this.domainSlot("git");
    const githubSlot = this.domainSlot("github");
    if (gitSlot) {
      gitSlot.hidden = surface !== "git";
    }
    if (githubSlot) {
      githubSlot.hidden = surface !== "github";
    }

    if (surface !== "git") {
      this.gitLayoutInstance?.deactivate();
    }
    if (surface !== "github") {
      this.githubLayoutInstance?.deactivate();
    }
    if (!["git", "github"].includes(surface)) {
      this.domainActivationFingerprint = "";
      return;
    }

    const task = this.taskDetail?.task;
    if (!task || taskThreadId(task) !== this.selectedThreadId) {
      return;
    }
    const rootPath = taskWorktreeRootPath(task);
    const child = this.ensureDomainChild(surface);
    if (!rootPath) {
      child.prepareRoute(this.taskRoute);
      child.setRouteError?.(
        this.taskRoute,
        new Error("This Task has no Git worktree."),
      );
      return;
    }

    const activationFingerprint = JSON.stringify([
      this.selectedThreadId,
      surface,
      rootPath,
      task.worktree?.branch ?? "",
      task.worktree?.headSha ?? "",
      this.taskRoute,
    ]);
    if (
      child.active &&
      this.domainActivationFingerprint === activationFingerprint
    ) {
      return;
    }
    this.domainActivationFingerprint = activationFingerprint;
    child.prepareRoute(this.taskRoute);
    const repository = {
      ...(task.worktree ?? {}),
      rootPath,
    };
    void child.activate(this.taskRoute, {
      context: { path: rootPath, repository },
      routeOptions: {
        resolvePath: (path) => joinLogicalPath(rootPath, path),
      },
    });
  }

  syncTaskSummary() {
    const summary = this.taskSummary();
    if (!summary) {
      return;
    }
    if (this.hidden) {
      summary.deactivate();
      return;
    }
    const task = this.taskDetail?.task ?? null;
    summary.setSnapshot({
      task:
        task && taskThreadId(task) === this.selectedThreadId
          ? task
          : null,
      transportState: this.detailStream.state,
      reviewView: this.reviewView,
      reviewScope:
        this.taskRoute?.reviewScope === "branch" ? "branch" : "working",
      reviewBaseRef: `${this.taskRoute?.baseRef ?? ""}`,
      contextPath: this.activeCwdPath(),
      archiveState: this.archiveStateValue,
    });
  }

  syncFollowUpComposer() {
    const task = this.taskDetail?.task ?? null;
    const threadId = taskThreadId(task);
    if (
      !task ||
      threadId !== this.selectedThreadId ||
      !this.followUpComposerSlot()
    ) {
      this.deactivateFollowUpComposer();
      return;
    }
    const composer = this.ensureFollowUpComposer(threadId);
    composer.setContext({
      mode: "follow-up",
      threadId,
      cwd: this.activeCwdPath(),
      className: "task-follow-up-form",
      placeholder: "Send another prompt to this task",
      ariaLabel: "Follow-up prompt",
      submitLabel: "Send prompt",
      disabled: isTaskTransportStale(this.detailStream.state),
      settingsLocked: isTaskActivelyWorking(task),
      turnActive: isTaskActivelyWorking(task),
      activeTurnId: `${task?.activeTurn?.id ?? ""}`,
      interrupting: this.interruptStateValue.loading,
      interruptError: `${
        this.interruptStateValue.error?.message ??
        this.interruptStateValue.error ??
        ""
      }`,
      model: `${this.taskDetail?.model ?? ""}`.trim(),
      effort: `${this.taskDetail?.reasoningEffort ?? ""}`.trim(),
      fastMode: Boolean(this.taskDetail?.fastMode),
      permissionMode: `${this.taskDetail?.permissionMode ?? ""}`.trim(),
    });
    this.activateFollowUpComposer(threadId);
  }

  syncTaskReview() {
    const task = this.taskDetail?.task ?? null;
    if (
      this.reviewView !== "review" ||
      !task ||
      taskThreadId(task) !== this.selectedThreadId
    ) {
      this.deactivateReview();
      return;
    }
    const review = this.activateReview(this.selectedThreadId);
    review?.setTaskContext({
      task,
      route: this.taskRoute,
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
      conversation.setSnapshot({
        threadId: this.selectedThreadId,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        loading: false,
        loadingOlder: false,
        detailError: null,
        historyError: null,
        transportState: this.detailStream.state,
        updateKind: null,
      });
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
      transportState: this.detailStream.state,
      updateKind: this.conversationUpdateKind,
    });
    this.conversationUpdateKind = null;
  }

  renderTaskContentRegion() {
    const region = this.querySelector(".tasks-detail-region");
    if (!region) {
      return;
    }
    const renderKey = this.taskContentKey();
    if (renderKey === this.taskContentRenderKey) {
      return;
    }
    this.taskContentRenderKey = renderKey;
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
      const nextSummary = nextDetail?.querySelector(
        ":scope > caffold-task-detail-summary",
      );
      const nextConversation = nextDetail?.querySelector(":scope > .task-conversation-pane");
      const currentSummary = currentDetail.querySelector(
        ":scope > caffold-task-detail-summary",
      );
      const currentConversation = currentDetail.querySelector(
        ":scope > .task-conversation-pane",
      );
      if (nextSummary && !currentSummary) {
        currentDetail.insertBefore(nextSummary, currentConversation);
      }
      if (nextConversation && currentConversation) {
        const stableChildren = new Map([
          [
            "conversation",
            currentConversation.querySelector(
              ":scope > caffold-task-conversation",
            ),
          ],
          [
            "command-dialog",
            currentConversation.querySelector(
              ":scope > caffold-task-command-dialog",
            ),
          ],
          [
            "composer-slot",
            currentConversation.querySelector(
              ":scope > .task-follow-up-composer-slot",
            ),
          ],
        ]);
        const stableChildKey = (child) =>
          child.matches("caffold-task-conversation")
            ? "conversation"
            : child.matches("caffold-task-command-dialog")
              ? "command-dialog"
              : child.matches(".task-follow-up-composer-slot")
                ? "composer-slot"
                : "";
        [...currentConversation.children].forEach((child) => {
          if (![...stableChildren.values()].includes(child)) {
            child.remove();
          }
        });
        let insertionPoint = currentConversation.firstElementChild;
        [...nextConversation.children].forEach((child) => {
          const desiredChild =
            stableChildren.get(stableChildKey(child)) ?? child;
          if (desiredChild === insertionPoint) {
            insertionPoint = insertionPoint.nextElementSibling;
          } else {
            currentConversation.insertBefore(desiredChild, insertionPoint);
          }
        });
      }
      const currentReviewSlot = currentDetail.querySelector(
        ":scope > .task-review-slot",
      );
      const nextReviewSlot = nextDetail.querySelector(
        ":scope > .task-review-slot",
      );
      if (!currentReviewSlot && nextReviewSlot) {
        currentDetail.append(nextReviewSlot);
      }
      for (const domain of ["git", "github"]) {
        const currentSlot = currentDetail.querySelector(
          `:scope > .task-${domain}-slot`,
        );
        const nextSlot = nextDetail.querySelector(
          `:scope > .task-${domain}-slot`,
        );
        if (!currentSlot && nextSlot) {
          currentDetail.append(nextSlot);
        }
      }
      currentDetail.dataset.threadId = threadId;
      currentDetail.dataset.taskDetailView = this.reviewView;
      return;
    }

    region.innerHTML = this.renderBody();
  }

  taskContentKey() {
    if (this.view !== "detail") {
      return `view:${this.view}`;
    }
    if (!this.hasSelectedTaskDetail()) {
      if (this.loading) {
        return `loading:${this.selectedThreadId}:${this.reviewView}`;
      }
      if (this.detailLoadError) {
        return `error:${this.selectedThreadId}:${this.reviewView}:${this.detailLoadError.message ?? this.detailLoadError}`;
      }
      return `empty:${this.selectedThreadId}`;
    }
    const task = this.taskDetail.task;
    const streamState = isVisibleStreamState(this.detailStream.state)
      ? this.detailStream.state
      : "ready";
    return [
      "detail",
      taskThreadId(task),
      this.reviewView,
      streamState,
    ].join(":");
  }


  activeCwdPath() {
    return this.selectedTaskContextPath() || ".";
  }

  selectedTaskContextPath() {
    return cleanLogicalPath(
      this.taskDetail?.task?.worktree?.rootPath || this.taskDetail?.task?.cwdPath || "",
    );
  }

  newTaskContextPath() {
    return taskRepositoryPath(this.taskDetail?.task);
  }

  get taskDetailView() {
    return this.reviewView;
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
      if (["git", "github"].includes(this.reviewView)) {
        return this.renderPendingDomain("Loading Task context...");
      }
      return `<p class="surface-message task-detail-state-message">Loading task...</p>`;
    }
    if (this.detailLoadError && !hasSelectedTaskDetail && this.view === "detail") {
      if (["git", "github"].includes(this.reviewView)) {
        return this.renderPendingDomain(
          this.detailLoadError?.message ?? "Task details are temporarily unavailable.",
          { retry: true },
        );
      }
      return this.renderTaskDetailLoadError();
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
        <p class="task-detail-error-message">${escapeHtml(this.detailLoadError?.message ?? "")}</p>
        <button type="button" class="task-secondary-button" data-task-action="retry-task-detail">Retry</button>
      </section>
    `;
  }

  renderPendingDomain(message, options = {}) {
    const title = this.reviewView === "github" ? "GitHub" : "Git";
    return `
      <section class="task-domain-pending" data-task-domain="${this.reviewView}" aria-label="${title}">
        <header><h2>${title}</h2></header>
        <div class="task-domain-pending-body" ${options.retry ? 'role="alert"' : 'role="status"'}>
          <p>${escapeHtml(message)}</p>
          ${options.retry ? '<button type="button" class="task-secondary-button" data-task-action="retry-task-detail">Retry</button>' : ""}
        </div>
      </section>
    `;
  }


  renderTaskDetail() {
    const task = this.taskDetail?.task;
    if (!task) {
      return `<p class="surface-message task-detail-state-message">${this.loading ? "Loading task..." : "Select a task."}</p>`;
    }
    return `
      <div class="task-detail" data-thread-id="${escapeHtml(task.threadId ?? task.id)}" data-task-detail-view="${escapeHtml(this.reviewView)}">
        <caffold-task-detail-summary class="task-detail-summary" role="region" aria-label="Task summary"></caffold-task-detail-summary>
        <section class="task-conversation-pane" aria-label="Task conversation">
          <caffold-task-conversation></caffold-task-conversation>
          <caffold-task-command-dialog></caffold-task-command-dialog>
          ${this.renderStreamState()}
          <div class="task-follow-up-composer-slot"></div>
        </section>
        <div class="task-review-slot"></div>
        <div class="task-domain-slot task-git-slot" hidden></div>
        <div class="task-domain-slot task-github-slot" hidden></div>
      </div>
    `;
  }

  renderStreamState() {
    if (this.detailStream.state === TASK_TRANSPORT_STATE.RECONNECTING) {
      return `
        <caffold-task-transport-overlay
          class="task-stream-state"
          state="reconnecting"
          message="Caffold server connection lost. Reconnecting..."
          data-stream-state="reconnecting"
        ></caffold-task-transport-overlay>
      `;
    }
    if (this.detailStream.state === TASK_TRANSPORT_STATE.UNAVAILABLE) {
      return `
        <caffold-task-transport-overlay
          class="task-stream-state"
          state="unavailable"
          message="Caffold server unavailable."
          data-stream-state="unavailable"
        ></caffold-task-transport-overlay>
      `;
    }
    return "";
  }

}

if (!customElements.get("caffold-task-detail")) {
  customElements.define("caffold-task-detail", CaffoldTaskDetail);
}

function isVisibleStreamState(state) {
  return isTaskTransportStale(state);
}


function taskWorktreeRootPath(task) {
  const path = `${task?.worktree?.rootPath ?? ""}`.trim();
  return path === "." ? path : cleanLogicalPath(path);
}

function withDetailFileLinks(events, fileLinks) {
  const linksByEvent = new Map();
  for (const link of Array.isArray(fileLinks) ? fileLinks : []) {
    const eventId = `${link?.eventId ?? ""}`.trim();
    if (!eventId) {
      continue;
    }
    const links = linksByEvent.get(eventId) ?? [];
    links.push(link);
    linksByEvent.set(eventId, links);
  }
  return events.map((event) =>
    withEventFileLinks(event, linksByEvent.get(`${event?.id ?? ""}`)),
  );
}

function withEventFileLinks(event, fileLinks) {
  if (!event) {
    return null;
  }
  const links = (Array.isArray(fileLinks) ? fileLinks : []).filter(
    (link) =>
      `${link?.eventId ?? ""}` === `${event.id ?? ""}` &&
      `${link?.target ?? ""}` &&
      `${link?.taskRelativePath ?? ""}`,
  );
  return links.length ? { ...event, fileLinks: links } : event;
}

function sameStructuredValue(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameStructuredValue(value, right[index]))
    );
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameStructuredValue(left[key], right[key]),
    )
  );
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

function normalizeTaskRoute(route, threadId) {
  return route?.threadId === threadId
    ? { ...route }
    : { kind: "tasks", threadId };
}

function taskDetailSurface(route) {
  const domain = routeDomain(route);
  if (domain === "git" || domain === "github") {
    return domain;
  }
  return route?.kind === "tasks" && route.review ? "review" : "conversation";
}

function joinLogicalPath(rootPath, path) {
  return [rootPath, path]
    .flatMap((value) => `${value ?? ""}`.split("/"))
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function taskRelativePath(rootPath, path) {
  const root = cleanLogicalPath(rootPath);
  const target = cleanLogicalPath(path);
  if (!root || root === "." || target === root) {
    return target === root ? "" : target;
  }
  const prefix = `${root}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : target;
}
