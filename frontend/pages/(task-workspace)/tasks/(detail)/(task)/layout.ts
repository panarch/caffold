import { html, LitElement, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  archiveTask,
  discardTaskUploads,
  forkTask,
  getTask,
  interruptTask,
  markTaskSeen,
  resolveTaskApproval,
  restoreTask,
  sendTaskPrompt,
  type Task,
  type TaskDetail,
  type TaskEvent,
  type TaskFileLink,
  type TaskResponseError,
  taskAbsence,
  taskAlreadyActive,
  taskResponseError,
  uploadTaskFile,
} from "#app/api.js";
import { mergeKeyboardNavigationContexts } from "#app/keyboard-navigation.js";
import { routeDomain } from "#app/navigation-routes.js";
import { CAFFOLD_ORIGIN_REACHABLE_EVENT } from "#app/origin-reachability.js";
import type { WorkspaceLiveUpdates } from "#app/pages/(task-workspace)/live-updates.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import "../../components/composer.js";
import type {
  CaffoldTaskComposer,
  ComposerIntentDetail,
  ComposerSubmission,
  ComposerSubmitDetail,
} from "../../components/composer.js";
import "../../components/task-absence.js";
import type {
  CaffoldTaskAbsence,
  TaskAbsenceIntent,
} from "../../components/task-absence.js";
import {
  classifyPromptFailure,
  isTaskActivelyWorking,
  isTaskTransportStale,
  PROMPT_SUBMISSION_STATE,
  promptSubmissionState,
  TASK_TRANSPORT_STATE,
  type TaskTransportState,
  taskThreadStatusType,
  withPromptSubmissionState,
} from "../../runtime-state.js";
import {
  appendOptimisticEvent,
  eventIdentityKey,
  handoffOptimisticSubmission,
  optimisticUserMessageEvent,
} from "../../task-events.js";
import { cleanLogicalPath } from "../../task-format.js";
import {
  taskDetailThreadId,
  taskRepositoryPath,
  taskThreadId,
} from "../../task-list-model.js";
import "./components/broken-delete-dialog.js";
import type {
  BrokenTaskDeleteIntent,
  CaffoldBrokenTaskDeleteDialog,
} from "./components/broken-delete-dialog.js";
import "./components/command-dialog.js";
import type { CaffoldTaskCommandDialog } from "./components/command-dialog.js";
import "./components/conversation.js";
import type {
  CaffoldTaskConversation,
  ConversationIntent,
  ConversationSnapshot,
} from "./components/conversation.js";
import "./components/current-plan.js";
import type { CaffoldTaskCurrentPlan } from "./components/current-plan.js";
import "./components/markdown-preview-dialog.js";
import type {
  CaffoldTaskMarkdownPreviewDialog,
  MarkdownPreviewRequest,
} from "./components/markdown-preview-dialog.js";
import "./components/permission-instructions-dialog.js";
import type {
  CaffoldTaskPermissionInstructionsDialog,
  TaskRequestFailedIntent,
} from "./components/permission-instructions-dialog.js";
import {
  ConversationProjection,
  projectionRevision,
} from "./layout/conversation.js";
import { ConversationHistory } from "./layout/history.js";
import {
  promptWithAttachedFiles,
  uploadFileNames,
  uploadFolderName,
  uploadPath,
} from "./layout/prompt-attachments.js";
import {
  nextPromptSubmissionNode,
  PROMPT_SUBMISSION_EVENT,
  PROMPT_SUBMISSION_NODE,
  type PromptSubmissionEvent,
  type PromptSubmissionNode,
} from "./layout/prompt-submission.js";
import { UploadDiscards } from "./layout/upload-discards.js";
import {
  type TaskDetailOutcome,
  TaskDetailSession,
  type TaskEventMessage,
  type TaskStateMessage,
  type TaskSyncMessage,
} from "./session.js";

const CLEAN_COMPOSER_CACHE_LIMIT = 6;

// The surface of the open Task that Detail shows.
type TaskDetailView = "conversation" | "review" | "git" | "github" | "terminal";

// The route Detail opened a Task on.
interface TaskRoute {
  kind: string;
  threadId?: string;
  review?: unknown;
  terminal?: unknown;
}

// A request about the open Task: whether it runs, and why the last one failed.
interface ActionState {
  loading: boolean;
  error: Error | null;
}

// What the Task screen tells its owner about the open Task: the Task once
// read, its live connection, whether it is absent, where it works, and its
// Archive and Fork requests.
export interface TaskSubjectSnapshot {
  task: Task | null;
  transportState: TaskTransportState;
  absent: boolean;
  contextPath: string;
  provider: string;
  permissionMode: string;
  archiveState: ActionState;
  forkState: ActionState;
}

type ComposerAttachment = ComposerSubmission["attachments"][number];

// One file a prompt carries, and how far its upload has gone.
interface UploadFile {
  attachment: ComposerAttachment;
  name: string;
  path: string;
  size: number;
  loaded: number;
  done: boolean;
}

// The files of one send: their folder, what stops them, and which one is
// going up.
interface PlannedUpload {
  folder: string;
  abort: AbortController;
  current: number;
  files: UploadFile[];
}

// The prompt a Task holds from Send until its own history holds it.
interface FollowUpRequest {
  submissionId: string;
  composer: CaffoldTaskComposer;
  threadId: string;
  optimisticEventId: string;
  // The user message the agent said the prompt became.
  acceptedItemId: string;
  // User messages a detail held before the agent named that one.
  detailPositionKeys: Set<string>;
  node: PromptSubmissionNode;
  upload: PlannedUpload | null;
  canonicalConfirmed: boolean;
  // Whether the Composer's one-turn choices go once the message is confirmed:
  // null until the agent answers, false for a message that steered a turn.
  resetOverridesOnCanonical: boolean | null;
  overridesReleased: boolean;
}

type UpdateKind = ConversationSnapshot["updateKind"];

/**
 * The open Task below its summary: its conversation with the dialogs over it,
 * the Current Plan and Composer that follow it, and what shows in their place
 * while the Task cannot be read.
 *
 * The Tasks Detail layout opens a Task here and reads its state right after,
 * so it draws at once wherever its state changes. The conversation pane stays
 * once drawn, hidden under whatever shows in its place, so the conversation
 * and its dialogs keep their state; each Task's Composer is kept apart and
 * moved into the pane's slot.
 */
@customElement("caffold-task-detail")
export class CaffoldTaskDetail extends LitElement {
  private reviewView: TaskDetailView = "conversation";
  private taskDetail: TaskDetail | null = null;
  private readonly taskDetailRevisionByThread = new Map<string, number>();
  private readonly projectionsByThread = new Map<
    string,
    ConversationProjection
  >();
  private events: TaskEvent[] = [];
  private eventsThreadId = "";
  private readonly eventsByThread = new Map<string, TaskEvent[]>();
  private detailLoadError: TaskResponseError | null = null;
  loading = false;
  private selectedThreadId = "";
  private liveUpdates: WorkspaceLiveUpdates | null = null;
  private managedTask: { threadId: string; title?: string } | null = null;
  private readonly detailSession: TaskDetailSession = new TaskDetailSession({
    subscribe: (threadId, listener) => {
      if (!this.liveUpdates) {
        throw new Error("Workspace live updates are unavailable.");
      }
      return this.liveUpdates.subscribeTaskDetail(threadId, listener);
    },
    onTaskSync: (message) => this.applyTaskStreamSync(message),
    onTaskState: (message) => this.applyTaskStreamState(message),
    onTaskEvent: (message) => this.applyTaskStreamEvent(message),
    onFallbackDetail: (detail, context) =>
      this.applyTaskFallbackDetail(detail, context),
    onStateChange: (state, previousState) =>
      this.handleStreamStateChange(state, previousState),
    onSubjectAbsent: () => this.handleSubjectAbsent(),
  });
  private readonly seenRequestKeys = new Set<string>();
  private readonly history: ConversationHistory = new ConversationHistory({
    load: (threadId, cursor, options) =>
      getTask(threadId, cursor, options).catch((error) => {
        this.reportTaskAbsence(threadId, error);
        throw error;
      }),
    apply: (detail, { threadId, cursor }) =>
      this.applyCanonicalTaskDetail(threadId, detail, {
        preserveCurrentTask: true,
        historyPage: true,
        historyCursor: cursor,
        updateKind: "prepend",
        reconcilePrompt: false,
      }),
    change: () => {
      if (this.applyingCanonicalDetail) {
        return;
      }
      this.conversationUpdateKind = "preserve";
      this.draw();
    },
  });
  private applyingCanonicalDetail = false;
  private interruptActionToken = 0;
  private interruptStateValue: ActionState = { loading: false, error: null };
  private archiveActionToken = 0;
  private forkActionToken = 0;
  private approvalActionToken = 0;
  private promptSubmissionSequence = 0;
  private archiveStateValue: ActionState = { loading: false, error: null };
  private forkStateValue: ActionState = { loading: false, error: null };
  private restoreActionToken = 0;
  private restoreStateValue: ActionState = { loading: false, error: null };
  private absentTaskTitle = "";
  private conversationUpdateKind: UpdateKind = null;
  private initialConversationLoad: { threadId: string } | null = null;
  private readonly followUpRequests = new Map<string, FollowUpRequest>();
  private readonly uploadDiscards = new UploadDiscards({
    discard: discardTaskUploads,
  });
  private readonly originReachable = () => this.uploadDiscards.reachable();
  private readonly followUpComposers = new Map<string, CaffoldTaskComposer>();
  private readonly followUpComposerLastUsed = new Map<string, number>();
  private followUpComposerUseSequence = 0;
  private activeFollowUpComposerThreadId = "";
  // The conversation pane once drawn: the Task and surface it last showed.
  private pane: { threadId: string; view: TaskDetailView } | null = null;
  // What shows in the pane's place, or null where the pane shows.
  private notice: TemplateResult | typeof nothing | null = nothing;
  private readonly hints = new ActionHints(this);
  private readonly conversationPane = new DrawnRef<HTMLElement>(this);
  private readonly conversationComponent =
    new DrawnRef<CaffoldTaskConversation>(this);
  private readonly commandDialog = new DrawnRef<CaffoldTaskCommandDialog>(this);
  private readonly markdownPreviewDialog =
    new DrawnRef<CaffoldTaskMarkdownPreviewDialog>(this);
  private readonly permissionInstructionsDialog =
    new DrawnRef<CaffoldTaskPermissionInstructionsDialog>(this);
  private readonly currentPlanComponent = new DrawnRef<CaffoldTaskCurrentPlan>(
    this,
  );
  private readonly followUpComposerSlot = new DrawnRef<HTMLDivElement>(this);
  private readonly brokenDeleteDialog =
    new DrawnRef<CaffoldBrokenTaskDeleteDialog>(this);
  private readonly absenceNotice = new DrawnRef<CaffoldTaskAbsence>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.originReachable,
    );
    this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(
      CAFFOLD_ORIGIN_REACHABLE_EVENT,
      this.originReachable,
    );
    this.deactivate();
    this.disposeFollowUpComposers();
  }

  setLiveUpdates(liveUpdates: WorkspaceLiveUpdates | null | undefined) {
    this.performUpdate();
    this.liveUpdates = liveUpdates ?? null;
    this.currentPlanComponent.value?.setLiveUpdates(this.liveUpdates);
  }

  prepare(
    threadId: string | null | undefined,
    options: { preserveLoadedTask?: boolean; route?: TaskRoute | null } = {},
  ) {
    this.performUpdate();
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
      this.hidden = false;
      const nextReviewView = taskDetailSurface(options.route, targetThreadId);
      if (
        this.reviewView === "conversation" &&
        nextReviewView !== "conversation"
      ) {
        this.conversationComponent.value?.setActive(false);
      }
      this.reviewView = nextReviewView;
      this.detailLoadError = null;
      this.activateThreadEvents(targetThreadId);
      this.draw();
      return;
    }

    if (this.selectedThreadId !== targetThreadId) {
      this.brokenDeleteDialog.value?.reset();
      this.deactivateFollowUpComposer();
      this.history.deactivate();
      this.interruptActionToken += 1;
      this.interruptStateValue = { loading: false, error: null };
      this.archiveActionToken += 1;
      this.forkActionToken += 1;
      this.approvalActionToken += 1;
      this.archiveStateValue = { loading: false, error: null };
      this.forkStateValue = { loading: false, error: null };
      this.restoreActionToken += 1;
      this.restoreStateValue = { loading: false, error: null };
      this.absentTaskTitle = "";
      this.reviewView = "conversation";
      this.detailSession.deactivate();
    }
    this.hidden = false;
    this.selectedThreadId = targetThreadId;
    this.history.activate(targetThreadId);
    this.reviewView = taskDetailSurface(options.route, targetThreadId);
    this.activateThreadEvents(targetThreadId);
    this.taskDetail =
      taskDetailThreadId(this.taskDetail) === targetThreadId
        ? this.taskDetail
        : null;
    this.detailLoadError = null;
    this.draw();
  }

  async open(
    threadId: string | null | undefined,
    options: { preserveLoadedTask?: boolean; route?: TaskRoute | null } = {},
  ) {
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
      void this.detailSession.attach(targetThreadId);
      return this.taskDetail;
    }
    return await this.openTask(targetThreadId);
  }

  adoptCreatedDetail(
    detail: TaskDetail | null | undefined,
    submission?: Partial<ComposerSubmission> | null,
  ) {
    const threadId = taskDetailThreadId(detail);
    if (!threadId || !detail?.task) {
      return false;
    }
    // Creation hands Detail a new Task before its route opens. Bind that Task
    // through the ordinary identity transition so no request or pagination
    // state from the previously selected Task can be applied to it.
    this.prepare(threadId);
    if (
      !this.applyCanonicalTaskDetail(threadId, detail, {
        resetRevision: true,
        updateKind: "bottom",
      })
    ) {
      return false;
    }
    if (submission && !this.submitCreatedTaskPrompt(threadId, submission)) {
      return false;
    }
    void this.detailSession.attach(threadId);
    return true;
  }

  // Move the browser-owned initial submission into the new Task before its
  // route takes over. From this point on it is an ordinary prompt request: the
  // same optimistic event, exact accepted item identity, failure classifier,
  // composer restoration, and reconciliation used by every later message.
  private submitCreatedTaskPrompt(
    threadId: string,
    submission: Partial<ComposerSubmission>,
  ) {
    const composer = this.followUpComposer();
    if (
      !composer ||
      this.followUpComposers.get(threadId) !== composer ||
      this.selectedThreadId !== threadId
    ) {
      return false;
    }
    const adopted = composer.adoptSubmission({
      ...submission,
      threadId,
    });
    if (!adopted) {
      return false;
    }
    void this.sendFollowUpSubmission(composer, adopted).catch((error) => {
      composer.resolveSubmission(adopted.submissionId, {
        status: "rejected",
        error,
      });
    });
    return true;
  }

  deactivate({ retainComposerDom = false } = {}) {
    this.endTaskRequests();
    this.restoreActionToken += 1;
    this.restoreStateValue = { loading: false, error: null };
    this.detailSession.deactivate();
    if (retainComposerDom) {
      this.endFollowUpComposerEditingLifetime(
        this.activeFollowUpComposerThreadId,
        this.followUpComposer(),
      );
    } else {
      this.deactivateFollowUpComposer();
    }
    this.currentPlanComponent.value?.deactivate();
    this.hidden = true;
  }

  // Ends what the open Task's surfaces have in flight: its requests, older
  // history, and the dialogs opened over its conversation.
  private endTaskRequests() {
    this.brokenDeleteDialog.value?.reset();
    this.history.deactivate();
    this.interruptActionToken += 1;
    this.interruptStateValue = { loading: false, error: null };
    this.archiveActionToken += 1;
    this.forkActionToken += 1;
    this.approvalActionToken += 1;
    this.archiveStateValue = { loading: false, error: null };
    this.forkStateValue = { loading: false, error: null };
    this.initialConversationLoad = null;
    this.commandDialog.value?.dismiss();
    this.markdownPreviewDialog.value?.dismiss();
    this.permissionInstructionsDialog.value?.dismiss();
  }

  currentDetail() {
    return this.taskDetail;
  }

  detailSnapshot(): TaskSubjectSnapshot {
    const task = this.taskDetail?.task ?? null;
    return {
      task: task && taskThreadId(task) === this.selectedThreadId ? task : null,
      transportState: this.detailSession.state,
      absent: Boolean(this.detailSession.absence),
      contextPath: this.activeCwdPath(),
      provider: `${this.taskDetail?.provider ?? ""}`.trim(),
      permissionMode: this.followUpComposer()?.selectedPermissionMode() ?? "",
      archiveState: this.archiveStateValue,
      forkState: this.forkStateValue,
    };
  }

  actionHintScope() {
    const scopeId = `task:${this.selectedThreadId}`;
    const own = this.hints.scope({ scopeId, clipRoots: [this] });
    if (this.hidden || !this.selectedThreadId) {
      return emptyActionHintScope();
    }
    const notice = this.absenceNotice.value;
    if (notice) {
      return notice.actionHintScope({
        scopeId: `${scopeId}:absence`,
        clipRoots: [this],
      });
    }
    const pane = this.conversationPane.value;
    if (this.notice !== null || this.reviewView !== "conversation" || !pane) {
      return own;
    }
    const composer = this.followUpComposer();
    const slot = this.followUpComposerSlot.value;
    const clipRoots = [this, pane];
    return mergeActionHintScopes(
      composer && slot && composer.parentElement === slot
        ? mergeActionHintScopes(
            composer.actionHintScope({ scopeId, clipRoots }),
            { mutationRoots: [slot] },
          )
        : null,
      this.conversationComponent.value?.actionHintScope({
        scopeId: `${scopeId}:conversation`,
        clipRoots,
      }),
      this.currentPlanComponent.value?.actionHintScope({
        scopeId: `${scopeId}:current-plan`,
        clipRoots,
      }),
    );
  }

  scrollSurfaceScope() {
    if (
      this.hidden ||
      this.reviewView !== "conversation" ||
      !this.selectedThreadId ||
      !hasScrollLayoutBox(this)
    ) {
      return emptyScrollSurfaceScope();
    }
    const conversation = this.conversationComponent.value;
    return conversation && hasScrollLayoutBox(conversation)
      ? conversation.scrollSurfaceScope()
      : emptyScrollSurfaceScope();
  }

  keyboardNavigationContexts() {
    const deletionContexts =
      this.brokenDeleteDialog.value?.keyboardNavigationContexts() ?? [];
    if (
      this.hidden ||
      this.reviewView !== "conversation" ||
      !this.selectedThreadId
    ) {
      return deletionContexts;
    }
    const composer = this.followUpComposer();
    const slot = this.followUpComposerSlot.value;
    return mergeKeyboardNavigationContexts(
      deletionContexts,
      composer && slot && composer.parentElement === slot
        ? composer.keyboardNavigationContexts({
            scopeId: `task:${this.selectedThreadId}`,
          })
        : [],
      this.currentPlanComponent.value?.keyboardNavigationContexts() ?? [],
      this.commandDialog.value?.keyboardNavigationContexts() ?? [],
      this.markdownPreviewDialog.value?.keyboardNavigationContexts() ?? [],
      this.permissionInstructionsDialog.value?.keyboardNavigationContexts() ??
        [],
    );
  }

  private async openTask(threadId: string) {
    if (!threadId) {
      return null;
    }

    this.initialConversationLoad =
      this.conversationComponent.value?.hasScrollSnapshot(threadId)
        ? null
        : { threadId };
    this.selectedThreadId = threadId;
    this.loading = true;
    this.detailLoadError = null;
    this.draw();
    const outcome = await this.detailSession.open(threadId);
    if (outcome.stale || threadId !== this.selectedThreadId) {
      return null;
    }
    if (outcome.ok) {
      this.finishInitialConversationLoad(threadId);
      return outcome.detail ?? this.taskDetail;
    }
    if (outcome.absence) {
      return null;
    }
    this.loading = false;
    this.detailLoadError = (outcome.error ??
      new Error("Task details could not finish loading.")) as TaskResponseError;
    this.draw();
    this.finishInitialConversationLoad(threadId);
    return null;
  }

  private rememberActiveThreadEvents() {
    if (!this.eventsThreadId || this.events.length === 0) {
      return;
    }

    this.eventsByThread.set(this.eventsThreadId, this.events);
  }

  private activateThreadEvents(threadId: string) {
    if (this.eventsThreadId === threadId) {
      return;
    }

    this.rememberActiveThreadEvents();
    this.eventsThreadId = threadId;
    this.events = threadId
      ? [...(this.eventsByThread.get(threadId) ?? [])]
      : [];
  }

  private setThreadEvents(threadId: string, events: TaskEvent[]) {
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

  private applyTaskStreamSync(message: TaskSyncMessage) {
    const threadId = `${message?.threadId ?? ""}`;
    const detail = message?.detail;
    const preserveReadableDetail =
      !message.error &&
      message.reason === "stream-bootstrap" &&
      !detail?.task &&
      taskDetailThreadId(this.taskDetail) === threadId &&
      Boolean(this.taskDetail?.task);
    const applied = preserveReadableDetail
      ? this.applyTaskStreamBaseline(
          threadId,
          message.revision,
          detail?.eventRevision,
        )
      : this.applyCanonicalTaskDetail(threadId, detail, {
          revision: message.revision,
          resetRevision: message.reason === "stream-bootstrap",
          detailError: message.error,
          updateKind: this.liveConversationUpdateKind(threadId),
        });
    if (!applied) {
      return false;
    }
    return true;
  }

  // A change beside the conversation: the Task's status, title, settings, or
  // context. The conversation is left as it is; its items arrive as events.
  private applyTaskStreamState(message: TaskStateMessage) {
    const threadId = `${message?.threadId ?? ""}`;
    const current = this.taskDetail;
    if (
      threadId !== this.selectedThreadId ||
      !current ||
      taskDetailThreadId(current) !== threadId ||
      !message.task ||
      !this.acceptTaskDetailRevision(threadId, message.revision)
    ) {
      return false;
    }
    const currentTask = current.task;
    const task =
      currentTask && sameStructuredValue(currentTask, message.task)
        ? currentTask
        : message.task;
    if (!isTaskActivelyWorking(task) || !task?.activeTurn?.id) {
      this.interruptStateValue = { loading: false, error: null };
    }
    this.taskDetail = {
      ...current,
      revision: message.revision,
      task,
      provider: message.provider,
      permissionMode: message.permissionMode,
      model: message.model,
      reasoningEffort: message.reasoningEffort,
      fastMode: message.fastMode,
      context: message.context,
    };
    this.draw();
    this.markDisplayedTaskSeen(threadId, task);
    return true;
  }

  private applyTaskFallbackDetail(
    detail: TaskDetail,
    { threadId, recovery }: { threadId: string; recovery: boolean },
  ) {
    return this.applyCanonicalTaskDetail(threadId, detail, {
      resetRevision: recovery,
      updateKind: recovery
        ? "live"
        : this.isInitialConversationLoadPending(threadId)
          ? "bottom"
          : "preserve",
    });
  }

  private applyTaskStreamBaseline(
    threadId: string,
    revision: number | undefined,
    eventRevision: number | undefined,
  ) {
    if (threadId !== this.selectedThreadId) {
      return false;
    }
    this.taskDetailRevisionByThread.delete(threadId);
    this.projectionFor(threadId).reset();
    this.history.activate(threadId);
    return (
      this.acceptTaskDetailRevision(threadId, revision) &&
      projectionRevision(eventRevision) !== null
    );
  }

  private projectionFor(threadId: string) {
    let projection = this.projectionsByThread.get(threadId);
    if (!projection) {
      projection = new ConversationProjection();
      this.projectionsByThread.set(threadId, projection);
    }
    return projection;
  }

  private applyTaskStreamEvent(message: TaskEventMessage) {
    const threadId = `${message?.threadId ?? ""}`;
    const entry = withEventFileLinks(message?.event, message?.fileLinks);
    if (
      threadId !== this.selectedThreadId ||
      !entry ||
      entry.threadId !== threadId
    ) {
      return;
    }
    const events = this.projectionFor(threadId).delta(
      this.events,
      entry,
      message.eventRevision,
    );
    if (!events) return;
    this.setThreadEvents(threadId, events);
    this.reconcilePendingPrompt(threadId, [entry]);
    this.conversationUpdateKind = this.liveConversationUpdateKind(threadId);
    this.draw();
  }

  private applyCanonicalTaskDetail(
    threadId: string,
    detail: TaskDetail | null | undefined,
    {
      revision = detail?.revision,
      resetRevision = false,
      preserveCurrentTask = false,
      historyPage = false,
      historyCursor = null,
      updateKind = "preserve",
      detailError = null,
      reconcilePrompt = true,
    }: {
      revision?: number;
      resetRevision?: boolean;
      preserveCurrentTask?: boolean;
      historyPage?: boolean;
      historyCursor?: string | null;
      updateKind?: UpdateKind;
      detailError?: unknown;
      reconcilePrompt?: boolean;
    } = {},
  ) {
    if (
      threadId !== this.selectedThreadId ||
      !detail ||
      taskDetailThreadId(detail) !== threadId
    ) {
      return false;
    }
    if (resetRevision) {
      // Session revisions are process-local, so a reconnect after a server
      // restart can authoritatively bootstrap at a lower revision.
      this.taskDetailRevisionByThread.delete(threadId);
      this.projectionFor(threadId).reset();
      this.history.activate(threadId);
    }
    const incomingEvents = withDetailFileLinks(
      detail.events ?? [],
      detail.fileLinks,
    );
    const events = this.projectionFor(threadId).snapshot(
      this.eventsByThread.get(threadId) ?? [],
      { ...detail, events: incomingEvents },
    );
    if (!events) return false;
    this.setThreadEvents(threadId, events);
    const acceptMetadata =
      !historyPage && this.acceptTaskDetailRevision(threadId, revision);
    if (!historyPage)
      this.rememberPendingPromptDetailPositions(threadId, events);
    if (reconcilePrompt) this.reconcilePendingPrompt(threadId, events);
    const currentTask =
      taskDetailThreadId(this.taskDetail) === threadId
        ? this.taskDetail?.task
        : null;
    const nextTask =
      preserveCurrentTask || !acceptMetadata
        ? (currentTask ?? detail.task)
        : detail.task;
    const stableTask =
      currentTask && sameStructuredValue(currentTask, nextTask)
        ? currentTask
        : nextTask;
    if (!isTaskActivelyWorking(stableTask) || !stableTask?.activeTurn?.id) {
      this.interruptStateValue = { loading: false, error: null };
    }
    if (acceptMetadata || !this.taskDetail) {
      this.taskDetail = { ...detail, task: stableTask };
    }
    // The answer renders once below with its own update kind, so a history
    // change it causes does not render first and move the conversation.
    this.applyingCanonicalDetail = true;
    try {
      this.history.accept(detail, historyCursor, this.events);
    } finally {
      this.applyingCanonicalDetail = false;
    }
    const canonicalError = detailError ? taskResponseError(detailError) : null;
    if (acceptMetadata) {
      this.loading = detail?.syncState === "loading" && !canonicalError;
      this.detailLoadError = canonicalError;
    }
    this.conversationUpdateKind = updateKind;
    this.draw();
    this.markDisplayedTaskSeen(threadId, this.taskDetail?.task);
    return true;
  }

  private markDisplayedTaskSeen(
    threadId: string,
    task: Task | null | undefined,
  ) {
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
        const current = this.taskDetail;
        if (
          threadId !== this.selectedThreadId ||
          !current ||
          taskDetailThreadId(current) !== threadId ||
          !canonicalTask
        ) {
          return;
        }
        this.taskDetail = {
          ...current,
          task: canonicalTask,
        };
        this.draw();
      })
      .catch((error) => {
        this.seenRequestKeys.delete(requestKey);
        this.reportTaskAbsence(threadId, error);
      });
  }

  // Detail positions remain identifiable if its event arrives before the HTTP
  // response says which exact user item this request became.
  private rememberPendingPromptDetailPositions(
    threadId: string,
    events: TaskEvent[],
  ) {
    const request = this.followUpRequests.get(threadId);
    if (!request) {
      return;
    }
    for (const event of events) {
      if (event?.type !== "user_message" || event.payload?.optimistic) {
        continue;
      }
      const key = eventIdentityKey(event);
      if (key) {
        request.detailPositionKeys.add(key);
      }
    }
  }

  // What arriving events say about the prompt this Task is still holding.
  // Detail and single stream events are delivered independently, so either
  // one may confirm the exact accepted item identity first.
  private reconcilePendingPrompt(threadId: string, events: TaskEvent[]) {
    const request = this.followUpRequests.get(threadId);
    if (!request) {
      return;
    }

    // Every prompt is confirmed only by the item identity returned for that
    // request. Its words are presentation and another client may submit the
    // same ones.
    const confirmedEvent = events.find((event) => {
      if (event?.type !== "user_message" || event.payload?.optimistic) {
        return false;
      }
      return (
        request.acceptedItemId &&
        event.payload?.itemId === request.acceptedItemId
      );
    });
    if (confirmedEvent) {
      this.acknowledgePendingPrompt(
        threadId,
        request,
        confirmedEvent,
        !request.detailPositionKeys.has(eventIdentityKey(confirmedEvent)),
      );
      return;
    }
  }

  private acknowledgePendingPrompt(
    threadId: string,
    request: FollowUpRequest,
    confirmedEvent: TaskEvent,
    handoffPosition: boolean,
  ) {
    if (
      !this.advancePromptSubmission(
        threadId,
        request,
        PROMPT_SUBMISSION_EVENT.CANONICAL_CONFIRMED,
      )
    ) {
      return;
    }
    request.canonicalConfirmed = true;
    const currentEvents = this.eventsByThread.get(threadId) ?? [];
    this.setThreadEvents(
      threadId,
      handoffPosition
        ? handoffOptimisticSubmission(
            currentEvents,
            request.optimisticEventId,
            confirmedEvent,
          )
        : currentEvents.filter(
            (event) => event.id !== request.optimisticEventId,
          ),
    );
    this.releaseConfirmedFollowUpOverrides(request);
    request.composer.resolveSubmission(request.submissionId, {
      status: "accepted",
    });
  }

  private releaseConfirmedFollowUpOverrides(request: FollowUpRequest) {
    if (
      request.overridesReleased ||
      !request.canonicalConfirmed ||
      request.resetOverridesOnCanonical !== true
    ) {
      return;
    }
    request.composer.resetOverrides();
    request.overridesReleased = true;
  }

  private acceptTaskDetailRevision(
    threadId: string,
    revision: number | undefined,
  ) {
    const value = Number(revision);
    if (!threadId || !Number.isFinite(value) || value <= 0) {
      return true;
    }
    const current = this.taskDetailRevisionByThread.get(threadId) ?? 0;
    if (value < current) {
      return false;
    }
    this.taskDetailRevisionByThread.set(threadId, value);
    return true;
  }

  private handleStreamStateChange(
    state: TaskTransportState,
    previousState: TaskTransportState,
  ) {
    if (isTaskTransportStale(previousState) || isTaskTransportStale(state)) {
      this.draw();
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-detail-transport-change", {
        bubbles: true,
        composed: true,
        detail: { state },
      }),
    );
  }

  get streamState() {
    return this.detailSession?.state ?? TASK_TRANSPORT_STATE.IDLE;
  }

  retryStream() {
    if (!this.selectedThreadId) {
      return;
    }
    if (this.loading && !this.taskDetail?.task) {
      void this.openTask(this.selectedThreadId);
      return;
    }
    this.liveUpdates?.retry();
    void this.detailSession.retry();
    this.draw();
  }

  suspendForeground() {
    this.history.deactivate();
    this.detailSession.suspend();
  }

  reconcileVisibleSurface() {
    if (this.reviewView === "conversation") {
      this.conversationComponent.value?.reconcileViewportResize();
    }
  }

  async recoverForeground(): Promise<TaskDetailOutcome> {
    if (!this.selectedThreadId) {
      return { ok: true, skipped: true };
    }
    const outcome = await this.detailSession.recover();
    if (!outcome.ok && !outcome.stale && !outcome.absence) {
      throw outcome.error ?? new Error("Task detail recovery failed.");
    }
    return outcome;
  }

  // The open Task is archived or Caffold cannot find it. What it showed
  // closes, whichever of its surfaces was in front, and the notice takes the
  // conversation's place.
  private handleSubjectAbsent() {
    this.endTaskRequests();
    this.absentTaskTitle =
      this.taskDetail?.task?.title ||
      (taskThreadId(this.managedTask) === this.selectedThreadId
        ? this.managedTask?.title
        : "") ||
      this.absentTaskTitle;
    this.taskDetail = null;
    this.loading = false;
    this.detailLoadError = null;
    this.draw();
  }

  // Any request about the open Task that finds it archived or missing says so
  // for the whole conversation, through the conversation session.
  private reportTaskAbsence(threadId: string, error: unknown) {
    const absence = taskAbsence(error);
    if (absence) {
      this.detailSession.subjectGone(threadId, absence);
    }
    return Boolean(absence);
  }

  // Restore from the notice. A Task already restored elsewhere just opens; one
  // deleted meanwhile turns the notice to not found.
  private async restoreAbsentTask() {
    const threadId = this.selectedThreadId;
    if (
      !threadId ||
      this.restoreStateValue.loading ||
      !this.detailSession.absence
    ) {
      return;
    }
    const actionToken = ++this.restoreActionToken;
    this.restoreStateValue = { loading: true, error: null };
    this.draw();
    try {
      const response = await restoreTask(threadId);
      if (actionToken !== this.restoreActionToken) {
        return;
      }
      this.restoreStateValue = { loading: false, error: null };
      this.dispatchEvent(
        new CustomEvent("caffold:task-detail-intent", {
          bubbles: true,
          composed: true,
          detail: {
            type: "task-restored",
            task: response?.task,
            activeTopPlacement: response?.activeTopPlacement,
          },
        }),
      );
      this.reopenTask(threadId);
    } catch (error) {
      if (actionToken !== this.restoreActionToken) {
        return;
      }
      this.restoreStateValue = { loading: false, error: null };
      if (taskAlreadyActive(error)) {
        this.reopenTask(threadId);
        return;
      }
      if (!this.reportTaskAbsence(threadId, error)) {
        this.restoreStateValue = { loading: false, error: error as Error };
      }
      this.draw();
    }
  }

  // An active Task again: older history starts over, as on a fresh open.
  private reopenTask(threadId: string) {
    this.history.activate(threadId);
    void this.openTask(threadId);
  }

  private async sendFollowUpSubmission(
    composer: CaffoldTaskComposer,
    submission: Partial<ComposerSubmitDetail> = {},
  ) {
    const submissionId = `${submission.submissionId ?? ""}`;
    const threadId =
      `${submission.threadId ?? this.selectedThreadId ?? ""}`.trim();
    const prompt = `${submission.prompt ?? ""}`.trim();
    const attachments = [...(submission.attachments ?? [])];
    if (!submissionId || !threadId || (!prompt && !attachments.length)) {
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
    if (isTaskTransportStale(this.detailSession.state)) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error(
          "Caffold server is unavailable. Wait for the task to reconnect.",
        ),
      });
      return;
    }
    const node = nextPromptSubmissionNode(
      this.followUpRequests.get(threadId)?.node ?? PROMPT_SUBMISSION_NODE.IDLE,
      attachments.length
        ? PROMPT_SUBMISSION_EVENT.SUBMIT_WITH_FILES
        : PROMPT_SUBMISSION_EVENT.SUBMIT,
    );
    if (!node) {
      composer.resolveSubmission(submissionId, {
        status: "rejected",
        error: new Error("A prompt is already being submitted for this task."),
      });
      return;
    }

    const upload = attachments.length ? plannedUpload(attachments) : null;
    const paths = upload?.files.map((file) => file.path) ?? [];
    const text = upload ? promptWithAttachedFiles(prompt, paths) : prompt;
    const imagePaths =
      upload?.files
        .filter((file) => file.attachment.imageInput)
        .map((file) => file.path) ?? [];
    const previousTask =
      taskThreadId(this.taskDetail?.task) === threadId
        ? (this.taskDetail?.task ?? null)
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
      text,
      attachments.filter((attachment) => attachment.imageInput),
      requestId,
      paths,
    );
    const followUpRequest: FollowUpRequest = {
      submissionId,
      composer,
      threadId,
      optimisticEventId: optimisticEvent.id,
      acceptedItemId: "",
      detailPositionKeys: new Set(),
      node,
      upload,
      canonicalConfirmed: false,
      resetOverridesOnCanonical: null,
      overridesReleased: false,
    };
    this.followUpRequests.set(threadId, followUpRequest);
    this.setThreadEvents(
      threadId,
      appendOptimisticEvent(
        this.eventsByThread.get(threadId) ?? [],
        optimisticEvent,
      ),
    );
    this.conversationUpdateKind = "bottom";
    this.draw();

    try {
      if (upload && !(await this.uploadPromptFiles(followUpRequest, upload))) {
        return;
      }
      const response = await sendTaskPrompt(
        threadId,
        text,
        options,
        imagePaths,
      );
      if (response?.threadId !== threadId) {
        throw new Error("The agent accepted the prompt for a different task.");
      }
      if (!`${response?.userMessageId ?? ""}`) {
        throw new Error(
          "The agent accepted the prompt without identifying its user message.",
        );
      }
      this.advancePromptSubmission(
        threadId,
        followUpRequest,
        PROMPT_SUBMISSION_EVENT.PROMPT_ACCEPTED,
      );
      followUpRequest.acceptedItemId = `${response.userMessageId}`;
      followUpRequest.resetOverridesOnCanonical = !response?.steered;
      this.releaseConfirmedFollowUpOverrides(followUpRequest);
      this.reconcilePendingPrompt(
        threadId,
        this.eventsByThread.get(threadId) ?? [],
      );
      this.setThreadEvents(
        threadId,
        (this.eventsByThread.get(threadId) ?? []).map((event) =>
          event.id === optimisticEvent.id
            ? withPromptSubmissionState(event, PROMPT_SUBMISSION_STATE.ACCEPTED)
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
      this.reportTaskAbsence(threadId, error);
      if (followUpRequest.node === PROMPT_SUBMISSION_NODE.UPLOADING) {
        if (
          this.advancePromptSubmission(
            threadId,
            followUpRequest,
            PROMPT_SUBMISSION_EVENT.UPLOAD_FAILED,
          )
        ) {
          this.withdrawPromptSubmission(
            followUpRequest,
            uploadFailure(error, upload),
          );
        }
        return;
      }
      if (followUpRequest.node !== PROMPT_SUBMISSION_NODE.SENDING) {
        return;
      }
      const failureState = classifyPromptFailure(error);
      if (failureState === PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN) {
        this.advancePromptSubmission(
          threadId,
          followUpRequest,
          PROMPT_SUBMISSION_EVENT.PROMPT_OUTCOME_UNKNOWN,
        );
        // The agent may have the message, and be reading its files.
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
          error: error as Error,
        });
        if (threadId === this.selectedThreadId) {
          this.conversationUpdateKind = "live";
        }
      } else {
        this.advancePromptSubmission(
          threadId,
          followUpRequest,
          PROMPT_SUBMISSION_EVENT.PROMPT_REJECTED,
        );
        this.withdrawPromptSubmission(followUpRequest, error as Error);
      }
    } finally {
      if (this.activeFollowUpComposerThreadId !== threadId) {
        this.endFollowUpComposerEditingLifetime(threadId, composer);
      }
      this.pruneFollowUpComposerCache();
      if (threadId === this.selectedThreadId) {
        this.draw();
      }
    }
  }

  // The one place a pending prompt's node changes. False when the event does
  // not belong to where the prompt is, or the prompt is no longer the Task's.
  private advancePromptSubmission(
    threadId: string,
    request: FollowUpRequest,
    event: PromptSubmissionEvent,
  ) {
    if (this.followUpRequests.get(threadId) !== request) {
      return false;
    }
    const next = nextPromptSubmissionNode(request.node, event);
    if (!next) {
      return false;
    }
    request.node = next;
    if (next === PROMPT_SUBMISSION_NODE.IDLE) {
      this.followUpRequests.delete(threadId);
    }
    return true;
  }

  // Up one file at a time, in the order they were attached. False when the
  // prompt was stopped meanwhile, which already settled it.
  private async uploadPromptFiles(
    request: FollowUpRequest,
    upload: PlannedUpload,
  ) {
    const { threadId } = request;
    for (const [index, file] of upload.files.entries()) {
      upload.current = index;
      await uploadTaskFile(
        threadId,
        upload.folder,
        file.name,
        file.attachment.file,
        {
          signal: upload.abort.signal,
          onProgress: (loaded) => {
            file.loaded = Math.min(loaded, file.size);
            this.showUploadProgress(request, upload);
          },
        },
      );
      const last = index === upload.files.length - 1;
      if (
        !this.advancePromptSubmission(
          threadId,
          request,
          last
            ? PROMPT_SUBMISSION_EVENT.FILES_UPLOADED
            : PROMPT_SUBMISSION_EVENT.FILE_UPLOADED,
        )
      ) {
        return false;
      }
      file.loaded = file.size;
      file.done = true;
      this.showUploadProgress(request, upload);
      this.setThreadEvents(
        threadId,
        (this.eventsByThread.get(threadId) ?? []).map((event) =>
          event.id === request.optimisticEventId
            ? withUploadedLines(event, upload, last)
            : event,
        ),
      );
      if (last) {
        this.conversationComponent.value?.setPromptUploadProgress(
          request.optimisticEventId,
          null,
        );
      }
      if (threadId === this.selectedThreadId) {
        this.conversationUpdateKind = "live";
        this.draw();
      }
    }
    return true;
  }

  private showUploadProgress(request: FollowUpRequest, upload: PlannedUpload) {
    const { files } = upload;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const loaded = files.reduce((sum, file) => sum + file.loaded, 0);
    const percent = total
      ? Math.floor((loaded / total) * 100)
      : Math.floor(
          (files.filter((file) => file.done).length / files.length) * 100,
        );
    this.conversationComponent.value?.setPromptUploadProgress(
      request.optimisticEventId,
      {
        percent,
        lines: files.map((file) =>
          file.done ? 1 : file.size ? file.loaded / file.size : 0,
        ),
      },
    );
  }

  // Take back a message still uploading. Its files never reached the agent.
  private stopPromptUpload(threadId: string) {
    const request = this.followUpRequests.get(threadId);
    if (
      request?.node !== PROMPT_SUBMISSION_NODE.UPLOADING ||
      !this.advancePromptSubmission(
        threadId,
        request,
        PROMPT_SUBMISSION_EVENT.STOP,
      )
    ) {
      return false;
    }
    request.upload?.abort.abort();
    this.withdrawPromptSubmission(request, null);
    this.draw();
    return true;
  }

  // A message the agent never received leaves the conversation and returns
  // to the Composer, and the files uploaded for it go.
  private withdrawPromptSubmission(
    request: FollowUpRequest,
    error: Error | null,
  ) {
    const { threadId } = request;
    if (request.upload) {
      this.conversationComponent.value?.setPromptUploadProgress(
        request.optimisticEventId,
        null,
      );
      this.uploadDiscards.discard(threadId, request.upload.folder);
    }
    this.setThreadEvents(
      threadId,
      (this.eventsByThread.get(threadId) ?? []).filter(
        (event) => event.id !== request.optimisticEventId,
      ),
    );
    request.composer.resolveSubmission(request.submissionId, {
      status: "rejected",
      error,
    });
    if (threadId === this.selectedThreadId) {
      this.conversationUpdateKind = "preserve";
    }
  }

  private async interruptSelectedTask() {
    const task = this.taskDetail?.task ?? null;
    if (
      !this.selectedThreadId ||
      this.interruptStateValue.loading ||
      !isTaskActivelyWorking(task) ||
      isTaskTransportStale(this.detailSession.state)
    ) {
      return;
    }

    const actionToken = ++this.interruptActionToken;
    const threadId = this.selectedThreadId;
    this.interruptStateValue = { loading: true, error: null };
    this.syncFollowUpComposer();
    try {
      const { cancelledPrompts, ...detail } = await interruptTask(threadId);
      if (
        actionToken !== this.interruptActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.interruptStateValue = { loading: false, error: null };
      this.followUpComposer()?.restoreCancelledPrompts(cancelledPrompts);
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
      this.interruptStateValue = { loading: false, error: error as Error };
      if (this.reportTaskAbsence(threadId, error)) {
        return;
      }
      this.syncFollowUpComposer();
    }
  }

  async archiveSelectedTask() {
    if (
      !this.selectedThreadId ||
      this.archiveStateValue.loading ||
      this.forkStateValue.loading
    ) {
      return;
    }
    const actionToken = ++this.archiveActionToken;
    const threadId = this.selectedThreadId;
    this.archiveStateValue = { loading: true, error: null };
    this.emitSubjectSnapshot();
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
      const failure = error as TaskResponseError;
      this.archiveStateValue = { loading: false, error: failure };
      if (this.reportTaskAbsence(threadId, failure)) {
        return;
      }
      if (Array.isArray(failure.allowedActions)) {
        this.detailLoadError = failure;
        this.loading = false;
        this.draw();
      } else this.emitSubjectSnapshot();
    }
  }

  async forkSelectedTask() {
    const task = this.taskDetail?.task ?? null;
    if (
      !this.selectedThreadId ||
      this.forkStateValue.loading ||
      this.archiveStateValue.loading ||
      `${this.taskDetail?.provider ?? ""}` !== "codex" ||
      taskThreadStatusType(task) !== "idle" ||
      isTaskTransportStale(this.detailSession.state)
    ) {
      return;
    }
    const actionToken = ++this.forkActionToken;
    const threadId = this.selectedThreadId;
    this.forkStateValue = { loading: true, error: null };
    this.emitSubjectSnapshot();
    try {
      const created = await forkTask(threadId);
      if (
        actionToken !== this.forkActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      const childThreadId = taskDetailThreadId(created?.detail);
      if (
        !childThreadId ||
        childThreadId === threadId ||
        !created.detail.task
      ) {
        throw new Error("Codex did not return a distinct forked Task.");
      }
      this.forkStateValue = { loading: false, error: null };
      const handoff = { created, submission: null, adopted: false };
      this.dispatchEvent(
        new CustomEvent("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error("The forked Task could not be opened.");
      }
    } catch (error) {
      if (
        actionToken !== this.forkActionToken ||
        threadId !== this.selectedThreadId
      ) {
        return;
      }
      this.forkStateValue = { loading: false, error: error as Error };
      if (this.reportTaskAbsence(threadId, error)) {
        return;
      }
      this.emitSubjectSnapshot();
    }
  }

  private async resolveApproval(approvalId: string, decision: string) {
    if (
      !this.selectedThreadId ||
      !approvalId ||
      !decision ||
      isTaskTransportStale(this.detailSession.state)
    ) {
      return;
    }

    const actionToken = ++this.approvalActionToken;
    const threadId = this.selectedThreadId;
    this.conversationComponent.value?.setApprovalError(approvalId, null);
    try {
      const detail = await resolveTaskApproval(threadId, approvalId, decision);
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
      if (this.reportTaskAbsence(threadId, error)) {
        return;
      }
      this.conversationComponent.value?.setApprovalError(
        approvalId,
        error as Error,
      );
    }
  }

  get eventsPage() {
    return { nextCursor: this.history?.cursor ?? null };
  }

  get loadingOlderEvents() {
    return this.history?.state === "loading";
  }

  get historyLoadError() {
    return this.history?.error ?? null;
  }

  private loadOlderEvents(options: { retry?: boolean } = {}) {
    return this.history.request(options);
  }

  // The region draws, then each child is handed what it shows, and the owner
  // hears the open Task's state.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.brokenDeleteDialog.value?.setContext({
      threadId: this.selectedThreadId,
      title:
        taskThreadId(this.managedTask) === this.selectedThreadId
          ? this.managedTask?.title
          : this.taskDetail?.task?.title,
      error: this.detailLoadError,
    });
    this.commandDialog.value?.setThreadId(this.selectedThreadId);
    this.markdownPreviewDialog.value?.setThreadId(this.selectedThreadId);
    this.permissionInstructionsDialog.value?.setThreadId(this.selectedThreadId);
    const absence = this.detailSession.absence;
    if (absence) {
      this.absenceNotice.value?.setSnapshot({
        absence,
        title: this.absentTaskTitle,
        restoring: this.restoreStateValue.loading,
        error: this.restoreStateValue.error,
      });
    }
    this.syncCurrentPlan();
    this.syncFollowUpComposer();
    this.conversationComponent.value?.setActive(
      this.reviewView === "conversation",
    );
    if (this.reviewView === "conversation") {
      this.syncConversationSnapshot();
    }
    this.emitSubjectSnapshot();
  }

  private emitSubjectSnapshot() {
    this.dispatchEvent(
      new CustomEvent<TaskSubjectSnapshot>("caffold:task-subject-snapshot", {
        bubbles: true,
        composed: true,
        detail: this.detailSnapshot(),
      }),
    );
  }

  // One retained phrase covers both waits of an opening conversation: Task
  // details not yet read, then history not yet read. Staying shown across the
  // two keeps its delay and animation from starting over. It sits over the
  // middle of Detail, so a conversation already on screen while its history
  // is read goes without it.
  private waitsForConversation() {
    if (this.reviewView !== "conversation") {
      return false;
    }
    const shownDetail =
      this.hasSelectedTaskDetail() &&
      !Array.isArray(this.detailLoadError?.allowedActions);
    return shownDetail
      ? Boolean(this.taskDetail?.historyLoading) && this.events.length === 0
      : this.loading;
  }

  setManagedTask(task: { threadId: string; title?: string } | null) {
    this.managedTask = task;
    this.brokenDeleteDialog.value?.setContext({
      threadId: this.selectedThreadId,
      title: task?.title,
      error: this.detailLoadError,
    });
  }

  /** Show what this Task's own prompts settled. */
  openPermissionInstructions(opener?: Element | null) {
    this.permissionInstructionsDialog.value?.open({
      threadId: this.selectedThreadId,
      opener,
    });
  }

  private followUpComposer() {
    return this.activeFollowUpComposerThreadId
      ? (this.followUpComposers.get(this.activeFollowUpComposerThreadId) ??
          null)
      : null;
  }

  private ensureFollowUpComposer(threadId: string) {
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

  private activateFollowUpComposer(threadId: string) {
    const composer = this.followUpComposers.get(threadId);
    const slot = this.followUpComposerSlot.value;
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

  private deactivateFollowUpComposer({ prune = true } = {}) {
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

  private endFollowUpComposerEditingLifetime(
    threadId: string,
    composer: CaffoldTaskComposer | null | undefined,
  ) {
    composer?.endEditingLifetime({
      preserveOptions: this.followUpRequests.has(threadId),
    });
  }

  private shouldRetainFollowUpComposer(
    threadId: string,
    composer: CaffoldTaskComposer,
  ) {
    if (composer.hasRestorableState() || this.followUpRequests.has(threadId)) {
      return true;
    }
    return (this.eventsByThread.get(threadId) ?? []).some(
      (event) =>
        event?.type === "user_message" &&
        promptSubmissionState(event) ===
          PROMPT_SUBMISSION_STATE.OUTCOME_UNKNOWN,
    );
  }

  private pruneFollowUpComposerCache() {
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

  private disposeFollowUpComposers() {
    for (const composer of this.followUpComposers.values()) {
      composer.remove();
    }
    this.followUpComposers.clear();
    this.followUpComposerLastUsed.clear();
    this.followUpComposerUseSequence = 0;
    this.activeFollowUpComposerThreadId = "";
  }

  private syncFollowUpComposer() {
    const task = this.taskDetail?.task ?? null;
    const threadId = taskThreadId(task);
    if (
      !task ||
      threadId !== this.selectedThreadId ||
      !this.followUpComposerSlot.value
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
      disabled: isTaskTransportStale(this.detailSession.state),
      settingsLocked: isTaskActivelyWorking(task),
      turnActive: isTaskActivelyWorking(task),
      uploading:
        this.followUpRequests.get(threadId)?.node ===
        PROMPT_SUBMISSION_NODE.UPLOADING,
      interrupting: this.interruptStateValue.loading,
      interruptError: `${
        this.interruptStateValue.error?.message ??
        this.interruptStateValue.error ??
        ""
      }`,
      provider: `${this.taskDetail?.provider ?? ""}`.trim(),
      model: `${this.taskDetail?.model ?? ""}`.trim(),
      effort: `${this.taskDetail?.reasoningEffort ?? ""}`.trim(),
      fastMode: Boolean(this.taskDetail?.fastMode),
      permissionMode: `${this.taskDetail?.permissionMode ?? ""}`.trim(),
    });
    composer.setContextUsage(this.taskDetail?.context ?? null);
    this.activateFollowUpComposer(threadId);
  }

  private syncCurrentPlan() {
    const currentPlan = this.currentPlanComponent.value;
    const task = this.taskDetail?.task ?? null;
    const threadId = taskThreadId(task);
    if (!currentPlan) {
      return;
    }
    currentPlan.setLiveUpdates(this.liveUpdates);
    if (
      this.reviewView !== "conversation" ||
      !task ||
      threadId !== this.selectedThreadId
    ) {
      currentPlan.deactivate();
      return;
    }
    currentPlan.setContext({
      threadId,
      cwd: this.currentPlanCwdPath(),
      rootPath: this.selectedTaskContextPath() || this.currentPlanCwdPath(),
    });
  }

  private currentPlanCwdPath() {
    const cwdPath = this.taskDetail?.task?.cwdPath;
    if (typeof cwdPath !== "string") {
      return "";
    }
    return cleanLogicalPath(cwdPath) || ".";
  }

  private isInitialConversationLoadPending(threadId = this.selectedThreadId) {
    return this.initialConversationLoad?.threadId === threadId;
  }

  private liveConversationUpdateKind(threadId = this.selectedThreadId) {
    return this.isInitialConversationLoadPending(threadId) ? "bottom" : "live";
  }

  private finishInitialConversationLoad(threadId: string) {
    if (this.initialConversationLoad?.threadId === threadId) {
      this.initialConversationLoad = null;
    }
  }

  private syncConversationSnapshot() {
    const conversation = this.conversationComponent.value;
    const task = this.taskDetail?.task ?? null;
    if (!conversation) {
      this.conversationUpdateKind = null;
      return;
    }
    if (!task || taskThreadId(task) !== this.selectedThreadId) {
      conversation.setSnapshot({
        threadId: this.selectedThreadId,
        task: null,
        events: [],
        eventsPage: { nextCursor: null },
        loadingOlder: false,
        detailError: null,
        historyError: null,
        transportState: this.detailSession.state,
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
      loadingOlder: this.loadingOlderEvents,
      detailError: isTaskTransportStale(this.detailSession.state)
        ? null
        : this.detailLoadError,
      historyError: this.historyLoadError,
      transportState: this.detailSession.state,
      updateKind: this.conversationUpdateKind,
    });
    this.conversationUpdateKind = null;
  }

  private activeCwdPath() {
    return this.selectedTaskContextPath() || ".";
  }

  selectedTaskContextPath() {
    return cleanLogicalPath(
      this.taskDetail?.task?.worktree?.rootPath ||
        this.taskDetail?.task?.cwdPath ||
        "",
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
      this.selectedThreadId &&
        this.taskDetail?.task?.threadId === this.selectedThreadId,
    );
  }

  protected override willUpdate() {
    this.notice = this.regionNotice();
    const task = this.taskDetail?.task;
    if (this.notice === null && task) {
      this.pane = { threadId: taskThreadId(task), view: this.reviewView };
    }
  }

  protected override updated() {
    if (this.dataset.taskDetailView !== this.reviewView) {
      this.dataset.taskDetailView = this.reviewView;
    }
  }

  override render() {
    const notice = this.notice;
    const pane = this.pane;
    const conversation =
      pane &&
      html`<div
        class="task-detail"
        data-thread-id=${pane.threadId}
        data-task-detail-view=${pane.view}
        ?hidden=${notice !== null}
      >
        <section
          ${drawn(this.conversationPane)}
          class="task-conversation-pane"
          aria-label="Task conversation"
        >
          <caffold-task-conversation
            ${drawn(this.conversationComponent)}
            @caffold:task-conversation-intent=${this.conversationIntent}
            @caffold:task-markdown-preview-intent=${this.previewMarkdown}
          ></caffold-task-conversation>
          <caffold-task-command-dialog
            ${drawn(this.commandDialog)}
          ></caffold-task-command-dialog>
          <caffold-task-markdown-preview-dialog
            ${drawn(this.markdownPreviewDialog)}
          ></caffold-task-markdown-preview-dialog>
          <caffold-task-permission-instructions-dialog
            ${drawn(this.permissionInstructionsDialog)}
            @caffold:task-detail-intent=${this.permissionIntent}
          ></caffold-task-permission-instructions-dialog>
          <div class="task-follow-up-composer-dock">
            <caffold-task-current-plan
              ${drawn(this.currentPlanComponent)}
            ></caffold-task-current-plan>
            <div
              ${drawn(this.followUpComposerSlot)}
              class="task-follow-up-composer-slot"
              @caffold:task-composer-submit=${this.composerSubmit}
              @caffold:task-composer-intent=${this.composerIntent}
              @caffold:task-composer-layout-change=${this.composerResized}
              @caffold:task-turn-options-change=${this.turnOptionsChanged}
            ></div>
          </div>
        </section>
      </div>`;
    return html`
      <div class="tasks-detail-region">${
        conversation
          ? html`${conversation}${
              notice === null
                ? nothing
                : html`<div class="task-detail-placeholder">${notice}</div>`
            }`
          : notice
      }</div>
      <caffold-loading-text ?hidden=${!this.waitsForConversation()}
        >Loading conversation…</caffold-loading-text
      >
      <caffold-broken-task-delete-dialog
        ${drawn(this.brokenDeleteDialog)}
        @caffold:task-detail-intent=${this.brokenDeleteIntent}
      ></caffold-broken-task-delete-dialog>
    `;
  }

  // What shows in the conversation's place: why the Task is absent, its
  // loading or failure, or that there is no Task. Null where the
  // conversation shows.
  private regionNotice() {
    if (this.detailSession.absence) {
      return html`<caffold-task-absence
        ${drawn(this.absenceNotice)}
        @caffold:task-absence-intent=${this.absenceIntent}
      ></caffold-task-absence>`;
    }
    const error = this.detailLoadError;
    const readable =
      this.hasSelectedTaskDetail() && !Array.isArray(error?.allowedActions);
    const domain = this.reviewView === "git" || this.reviewView === "github";
    if (this.loading && !readable) {
      return domain
        ? this.pendingDomainTemplate("Loading Task context...", false)
        : nothing;
    }
    if (error && !readable) {
      if (domain) {
        return this.pendingDomainTemplate(
          error.message ?? "Task details are temporarily unavailable.",
          true,
        );
      }
      return html`<section class="task-detail-load-error" role="alert">
        <p>${
          Array.isArray(error.allowedActions)
            ? "The task worktree is unavailable."
            : "Task details are temporarily unavailable."
        }</p>
        <p class="task-detail-error-message">${error.message}</p>
        ${this.loadErrorAction()}
      </section>`;
    }
    return this.taskDetail?.task
      ? null
      : html`<p class="surface-message task-detail-state-message"
          >Select a task.</p
        >`;
  }

  // What may still be done with a Task that could not be read: what the
  // server allows, or Retry when it named nothing.
  private loadErrorAction() {
    const actions = this.detailLoadError?.allowedActions;
    if (actions?.includes("deleteTask")) {
      return html`<button
        ${this.hints.button({
          id: "load-error",
          label: "Delete task",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-secondary-button"
        data-task-action="delete-broken-task"
        @click=${this.deleteBrokenTask}
      >Delete task</button>`;
    }
    if (!actions || actions.includes("retry")) {
      return html`<button
        ${this.hints.button({
          id: "load-error",
          label: "Retry",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-secondary-button"
        data-task-action="retry-task-detail"
        @click=${this.retryTaskDetail}
      >Retry</button>`;
    }
    return nothing;
  }

  // Git or GitHub before the Task they belong to could be read.
  private pendingDomainTemplate(message: string, error: boolean) {
    const title = this.reviewView === "github" ? "GitHub" : "Git";
    return html`<section
      class="task-domain-pending"
      data-task-domain=${this.reviewView}
      aria-label=${title}
    >
      <header><h2>${title}</h2></header>
      <div class="task-domain-pending-body" role=${error ? "alert" : nothing}>
        <p>${
          error
            ? message
            : html`<caffold-loading-text>${message}</caffold-loading-text>`
        }</p>
        ${error ? this.loadErrorAction() : nothing}
      </div>
    </section>`;
  }

  private deleteBrokenTask() {
    this.brokenDeleteDialog.value?.openTask();
  }

  private retryTaskDetail() {
    if (this.selectedThreadId) {
      void this.openTask(this.selectedThreadId);
    }
  }

  private conversationIntent(event: CustomEvent<ConversationIntent>) {
    event.stopPropagation();
    const intent = event.detail;
    switch (intent?.type) {
      case "older-history":
        void this.loadOlderEvents({ retry: intent.retry });
        break;
      case "retry-detail":
        void this.openTask(this.selectedThreadId);
        break;
      case "approval":
        void this.resolveApproval(intent.approvalId, intent.decision);
        break;
      case "command-output":
        this.commandDialog.value?.openCommand(intent.command);
        break;
      case "suggested-prompt":
        this.followUpComposer()?.appendSuggestedPrompt(intent.prompt);
        break;
    }
  }

  private previewMarkdown(event: CustomEvent<MarkdownPreviewRequest>) {
    event.stopPropagation();
    this.markdownPreviewDialog.value?.openMarkdown(event.detail);
  }

  private permissionIntent(event: CustomEvent<TaskRequestFailedIntent>) {
    if (event.detail?.type !== "task-request-failed") {
      return;
    }
    event.stopPropagation();
    this.reportTaskAbsence(event.detail.threadId, event.detail.error);
  }

  private brokenDeleteIntent(event: CustomEvent<BrokenTaskDeleteIntent>) {
    if (event.detail?.type !== "broken-delete-error") {
      return;
    }
    event.stopPropagation();
    this.detailLoadError = event.detail.error as TaskResponseError;
    this.loading = false;
    this.draw();
  }

  private absenceIntent(event: CustomEvent<TaskAbsenceIntent>) {
    event.stopPropagation();
    if (event.detail?.type === "restore") {
      void this.restoreAbsentTask();
    }
  }

  // The events below come from the Composer in the slot.
  private composerSubmit(event: CustomEvent<ComposerSubmitDetail>) {
    const composer = this.followUpComposer();
    if (!composer || !this.fromComposer(event, composer)) {
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
  }

  private composerIntent(event: CustomEvent<ComposerIntentDetail>) {
    const composer = this.followUpComposer();
    if (
      !composer ||
      !this.fromComposer(event, composer) ||
      event.detail?.type !== "interrupt"
    ) {
      return;
    }
    event.stopPropagation();
    // Stop takes back a message still uploading, and stops the turn as well
    // when one is running.
    this.stopPromptUpload(this.selectedThreadId);
    void this.interruptSelectedTask();
  }

  private composerResized(event: Event) {
    const composer = this.followUpComposer();
    if (!composer || !this.fromComposer(event, composer)) {
      return;
    }
    event.stopPropagation();
    this.conversationComponent.value?.reconcileViewportResize();
  }

  // Task actions show what the next turn's approval mode settles, so the
  // subject snapshot is published again when that mode changes.
  private turnOptionsChanged(event: Event) {
    const composer = this.followUpComposer();
    if (!composer || !this.fromComposer(event, composer)) {
      return;
    }
    this.emitSubjectSnapshot();
  }

  // Whether an event comes from the Composer this Task shows, rather than one
  // nested in it.
  private fromComposer(event: Event, composer: CaffoldTaskComposer) {
    return (
      event.target instanceof Element &&
      event.target.closest("caffold-task-composer") === composer
    );
  }
}

// Where each attached file goes when the prompt is sent: one folder for the
// send, and a name within it no other file of the send has.
function plannedUpload(attachments: ComposerAttachment[]): PlannedUpload {
  const folder = uploadFolderName();
  const names = uploadFileNames(
    attachments.map((attachment) => attachment.name),
  );
  return {
    folder,
    abort: new AbortController(),
    current: 0,
    files: attachments.map((attachment, index) => ({
      attachment,
      name: names[index],
      path: uploadPath(folder, names[index]),
      size: attachment.size ?? attachment.file?.size ?? 0,
      loaded: 0,
      done: false,
    })),
  };
}

function withUploadedLines(
  event: TaskEvent,
  upload: PlannedUpload,
  finished: boolean,
): TaskEvent {
  const { upload: _lines, ...payload } = event.payload ?? {};
  return {
    ...event,
    payload: finished
      ? { ...payload, submissionState: PROMPT_SUBMISSION_STATE.SENDING }
      : {
          ...payload,
          upload: {
            lines: upload.files.map((file) => ({
              path: file.path,
              done: file.done,
            })),
          },
        },
  };
}

function uploadFailure(error: unknown, upload: PlannedUpload | null) {
  const cause = error as TaskResponseError | null;
  const name = upload?.files[upload.current]?.name ?? "a file";
  const failure: TaskResponseError = new Error(
    `Could not upload ${name}: ${cause?.message ?? error}`,
  );
  failure.code = cause?.code;
  failure.status = cause?.status;
  return failure;
}

function withDetailFileLinks(
  events: TaskEvent[],
  fileLinks: TaskFileLink[] | undefined,
) {
  const linksByEvent = new Map<string, TaskFileLink[]>();
  for (const link of Array.isArray(fileLinks) ? fileLinks : []) {
    const eventId = `${link?.eventId ?? ""}`.trim();
    if (!eventId) {
      continue;
    }
    const links = linksByEvent.get(eventId) ?? [];
    links.push(link);
    linksByEvent.set(eventId, links);
  }
  return events.map(
    (event) =>
      withEventFileLinks(event, linksByEvent.get(`${event?.id ?? ""}`)) ??
      event,
  );
}

function withEventFileLinks(
  event: TaskEvent | null | undefined,
  fileLinks: TaskFileLink[] | undefined,
) {
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

function sameStructuredValue(left: unknown, right: unknown): boolean {
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
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        sameStructuredValue(leftRecord[key], rightRecord[key]),
    )
  );
}

// The surface a route shows for this Task: the conversation, unless the
// route is this Task's and names another of its surfaces.
function taskDetailSurface(
  route: TaskRoute | null | undefined,
  threadId: string,
): TaskDetailView {
  if (route?.threadId !== threadId) {
    return "conversation";
  }
  const domain = routeDomain(route);
  if (domain === "git" || domain === "github") {
    return domain;
  }
  if (route.kind === "tasks" && route.terminal) {
    return "terminal";
  }
  return route.kind === "tasks" && route.review ? "review" : "conversation";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail": CaffoldTaskDetail;
  }
}
