import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { getVoiceStatus, transcribeVoice, type VoiceStatus } from "#app/api.js";
import { busySpin } from "#app/component-styles.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { cleanLogicalPath } from "../task-format.js";
import "./composer/components/attachments.js";
import type {
  AttachmentRemoveDetail,
  CaffoldTaskComposerAttachments,
  ComposerAttachment,
} from "./composer/components/attachments.js";
import "./composer/components/context-usage.js";
import type { CaffoldTaskContextUsage } from "./composer/components/context-usage.js";
import "./composer/components/voice-level-meter.js";
import type { CaffoldVoiceLevelMeter } from "./composer/components/voice-level-meter.js";
import {
  formatRecordingDuration,
  VoiceRecorder,
  voiceCaptureSupport,
} from "./composer/voice-recorder.js";
import "./task-turn-options.js";
import type {
  CaffoldTaskTurnOptions,
  TurnOptionsContext,
  TurnOptionsSnapshot,
  TurnSubmissionOptions,
} from "./task-turn-options.js";

export interface OpenSettingsDetail {
  section: string;
}

// Where the Composer sends and how it reads. A follow-up Composer belongs to
// one Task; `provider` through `permissionMode` are what that Task or the
// New Task surface last ran under.
export interface ComposerContext {
  mode: "create" | "follow-up";
  threadId: string;
  className?: string;
  cwd: string;
  placeholder: string;
  ariaLabel: string;
  submitLabel: string;
  cancel: boolean;
  disabled: boolean;
  settingsLocked: boolean;
  requestError: string;
  turnActive: boolean;
  uploading: boolean;
  interrupting: boolean;
  interruptError: string;
  provider?: string;
  model?: string;
  effort?: string;
  fastMode: boolean;
  permissionMode?: string;
}

// A prompt sent from here and not yet accepted or handed over.
export interface ComposerSubmission {
  submissionId: string;
  threadId: string;
  prompt: string;
  attachments: ComposerAttachment[];
  options: Partial<TurnSubmissionOptions>;
  restorePromptFocusOnRejection: boolean;
}

// What the Composer hands its owner to send.
export type ComposerSubmitDetail = Omit<
  ComposerSubmission,
  "restorePromptFocusOnRejection"
>;

export interface ComposerIntentDetail {
  type: "cancel" | "interrupt";
}

// How the owner answered a submission. Only a rejected one comes back to the
// draft.
export interface SubmissionResult {
  status?: "accepted" | "rejected" | "outcome-unknown";
  error?: Error | string | null;
  resetOverrides?: boolean;
  resetOptions?: boolean;
}

type VoicePhase =
  | "checking"
  | "unavailable"
  | "notReady"
  | "idle"
  | "error"
  | "requesting"
  | "recording"
  | "transcribing";

interface VoiceState {
  phase: VoicePhase;
  error: string;
  ready: boolean;
  maxRecordingSeconds: number;
  elapsedSeconds: number;
  recordingLimitReached: boolean;
}

// The draft: what is written, where its caret was, what goes with it, and
// which submission it is waiting on.
interface Draft {
  prompt: string;
  attachments: ComposerAttachment[];
  attachmentError: string;
  selectionStart: number;
  selectionEnd: number;
  activeSubmissionId: string;
}

interface Submission {
  id: string;
  prompt: string;
  attachments: ComposerAttachment[];
  options: Partial<TurnSubmissionOptions>;
  restorePromptFocusOnRejection: boolean;
}

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
const TOO_MANY_ATTACHMENTS = `Attach up to ${MAX_ATTACHMENTS} files.`;
const DEFAULT_MAX_RECORDING_SECONDS = 5 * 60;
const VOICE_PHASE_EDGES = new Map<VoicePhase, ReadonlySet<VoicePhase>>([
  ["checking", new Set(["unavailable", "notReady", "idle", "error"])],
  ["unavailable", new Set()],
  ["notReady", new Set(["checking"])],
  ["idle", new Set(["requesting", "checking"])],
  ["error", new Set(["requesting", "checking"])],
  ["requesting", new Set(["recording", "error", "idle"])],
  ["recording", new Set(["transcribing", "idle"])],
  ["transcribing", new Set(["idle", "notReady", "error"])],
]);
const VOICE_STATUS_REFRESH_PHASES = new Set<VoicePhase>([
  "checking",
  "notReady",
  "idle",
  "error",
]);
const VOICE_BUSY_PHASES = new Set<VoicePhase>([
  "requesting",
  "recording",
  "transcribing",
]);
// The phases the voice button shows a spinner for.
const VOICE_WAITING_PHASES = new Set<VoicePhase>([
  "checking",
  "requesting",
  "transcribing",
]);
// Pictures every agent can be shown. Anything else is attached as a file the
// agent opens by its path.
const IMAGE_INPUT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

await busySpin.register(
  "caffold-task-composer",
  "> .task-composer > .task-composer-panel > .task-composer-toolbar > .task-composer-actions > .task-composer-render-region > .task-voice-button.is-busy > .task-voice-icon",
);

/**
 * The prompt field, its attachments, voice input, the turn options, and the
 * action that sends or stops.
 *
 * Its owner hands it the context and answers each submission; the draft, the
 * pictures, and the recording are its own. The Composer draws wherever its
 * state changes, because its owner and the keyboard modes read it right after.
 * The prompt field holds what the person typed, so the Composer writes it only
 * when its draft says otherwise, and not while an input method is composing.
 */
@customElement("caffold-task-composer")
export class CaffoldTaskComposer extends LitElement {
  // Whether files are being dragged over the Composer.
  @state()
  private accessor dropTarget = false;

  context: ComposerContext = {
    mode: "create",
    threadId: "",
    cwd: ".",
    placeholder: "",
    ariaLabel: "Task prompt",
    submitLabel: "Send prompt",
    cancel: false,
    disabled: false,
    settingsLocked: false,
    requestError: "",
    turnActive: false,
    uploading: false,
    interrupting: false,
    interruptError: "",
    fastMode: false,
  };
  voice: VoiceState = {
    phase: "checking",
    error: "",
    ready: false,
    maxRecordingSeconds: DEFAULT_MAX_RECORDING_SECONDS,
    elapsedSeconds: 0,
    recordingLimitReached: false,
  };
  private state: Draft = createDraft();
  private boundThreadId = "";
  private readonly activeSubmissions = new Map<string, Submission>();
  private submissionSequence = 0;
  private voiceStatusRequestId = 0;
  private voiceOperationId = 0;
  private voiceRecorder: VoiceRecorder | null = null;
  private voiceRequest: AbortController | null = null;
  // Where a transcript goes: the draft and its caret as they were when the
  // microphone was pressed.
  private voiceInsertion: {
    prompt: string;
    start: number;
    end: number;
  } | null = null;
  private compositionActive = false;
  // Whether the Composer drew while an input method was composing, which
  // leaves the prompt field to be read again once it ends.
  private drewWhileComposing = false;
  private compositionTimer: number | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly promptField = new DrawnRef<HTMLTextAreaElement>(this);
  private readonly attachmentStrip =
    new DrawnRef<CaffoldTaskComposerAttachments>(this);
  private readonly fileInput = new DrawnRef<HTMLInputElement>(this);
  private readonly optionsControl = new DrawnRef<CaffoldTaskTurnOptions>(this);
  private readonly usagePie = new DrawnRef<CaffoldTaskContextUsage>(this);
  private readonly levelMeter = new DrawnRef<CaffoldVoiceLevelMeter>(this);
  private readonly primaryButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly voiceSettingsChanged = () => {
    if (VOICE_STATUS_REFRESH_PHASES.has(this.voice.phase)) {
      void this.loadVoiceStatus();
    }
  };
  private readonly dragOver = (event: DragEvent) => this.handleDragover(event);
  private readonly dragLeave = (event: DragEvent) =>
    this.handleDragleave(event);
  private readonly drop = (event: DragEvent) => {
    void this.handleDrop(event);
  };

  override createRenderRoot() {
    return this;
  }

  // A drop anywhere on the Composer, its padding included, attaches.
  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener("dragover", this.dragOver);
    this.addEventListener("dragleave", this.dragLeave);
    this.addEventListener("drop", this.drop);
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    window.addEventListener(
      "caffold:voice-settings-changed",
      this.voiceSettingsChanged,
    );
    void warmIcons();
    this.draw();
    void this.loadVoiceStatus();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.captureCurrentState();
    this.removeEventListener("dragover", this.dragOver);
    this.removeEventListener("dragleave", this.dragLeave);
    this.removeEventListener("drop", this.drop);
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.removeEventListener(
      "caffold:voice-settings-changed",
      this.voiceSettingsChanged,
    );
    this.voiceStatusRequestId += 1;
    this.voiceOperationId += 1;
    this.voiceRequest?.abort();
    this.voiceRequest = null;
    void this.voiceRecorder?.cancel();
    this.voiceRecorder = null;
    if (VOICE_BUSY_PHASES.has(this.voice.phase)) {
      this.setVoicePhase("idle");
    }
    this.compositionActive = false;
    this.drewWhileComposing = false;
    window.clearTimeout(this.compositionTimer ?? undefined);
    this.compositionTimer = null;
  }

  setContext(context: Partial<ComposerContext> = {}) {
    const nextMode = context.mode ?? this.context.mode;
    const nextThreadId = (context.threadId ?? this.context.threadId).trim();
    if (nextMode === "follow-up" && nextThreadId) {
      if (this.boundThreadId && this.boundThreadId !== nextThreadId) {
        throw new Error(
          `Task Composer is already bound to thread ${this.boundThreadId}.`,
        );
      }
      this.boundThreadId = nextThreadId;
    }
    this.captureCurrentState();
    const nextContext: ComposerContext = {
      ...this.context,
      ...context,
      mode: nextMode,
      threadId: nextThreadId,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd),
      disabled: Boolean(context.disabled),
      settingsLocked: Boolean(context.settingsLocked),
      turnActive: Boolean(context.turnActive),
      uploading: Boolean(context.uploading),
      interrupting: Boolean(context.interrupting),
      requestError: Object.hasOwn(context, "requestError")
        ? (context.requestError ?? "")
        : this.context.requestError,
      interruptError: Object.hasOwn(context, "interruptError")
        ? (context.interruptError ?? "")
        : this.context.interruptError,
    };
    const contextChanged = !shallowEqual(this.context, nextContext);
    this.context = nextContext;
    if (!contextChanged) {
      this.syncTurnOptionsContext();
      return false;
    }
    this.draw();
    return true;
  }

  resolveSubmission(submissionId: string, result: SubmissionResult = {}) {
    const submission = this.activeSubmissions.get(submissionId);
    if (!submission) {
      return false;
    }
    this.activeSubmissions.delete(submissionId);
    if (this.state.activeSubmissionId === submissionId) {
      this.state.activeSubmissionId = "";
    }
    const rejected = result.status === "rejected";
    if (rejected) {
      this.restoreAheadOfDraft([submission.prompt], submission.attachments);
    }
    if (result.resetOverrides) {
      this.turnOptions()?.resetOverrides();
    }
    if (result.resetOptions) {
      this.resetTurnOptions();
    }
    this.context.requestError =
      result.error instanceof Error
        ? result.error.message
        : (result.error ?? "");
    this.draw();
    if (rejected && submission.restorePromptFocusOnRejection) {
      this.focus();
    }
    return true;
  }

  // Give back the messages a stop cancelled before the agent took them in,
  // in the order they were sent and ahead of anything written since, so they
  // can be sent again.
  restoreCancelledPrompts(prompts: Array<{ prompt?: string } | null> = []) {
    if (!prompts.length) {
      return false;
    }
    this.restoreAheadOfDraft(
      prompts.map((sent) => sent?.prompt ?? ""),
      [],
    );
    this.draw();
    return true;
  }

  // A request the agent suggested goes after whatever is being written, so
  // nothing typed is lost, and waits there to be read and sent.
  appendSuggestedPrompt(prompt: string) {
    if (!prompt.trim() || this.promptFieldLocked()) {
      return false;
    }
    this.captureCurrentState();
    const draft = this.state.prompt.trimEnd();
    this.state.prompt = draft ? `${draft}\n\n${prompt}` : prompt;
    this.state.selectionStart = this.state.prompt.length;
    this.state.selectionEnd = this.state.prompt.length;
    this.draw();
    this.focus();
    return true;
  }

  // Remove an in-flight submission from this composer without accepting or
  // rejecting it. The returned value is the complete browser-owned request,
  // ready for another composer to adopt while a create-then-submit flow moves
  // from the New Task surface into the Task that was just created.
  takeSubmission(submissionId: string) {
    const submission = this.activeSubmissions.get(submissionId);
    if (!submission) {
      return null;
    }
    this.activeSubmissions.delete(submissionId);
    if (this.state.activeSubmissionId === submissionId) {
      this.state.activeSubmissionId = "";
    }
    this.context.requestError = "";
    this.draw();
    return submissionDetail(submission, this.context.threadId);
  }

  submissionSnapshot(submissionId: string) {
    const submission = this.activeSubmissions.get(submissionId);
    return submission
      ? submissionDetail(submission, this.context.threadId)
      : null;
  }

  // Take ownership of a submission that another surface was holding.
  //
  // The message and its selected options remain here until the ordinary
  // prompt request is accepted. A rejection can therefore restore the exact
  // draft in the valid empty Task instead of sending the person back to New.
  adoptSubmission(value: Partial<ComposerSubmission> = {}) {
    if (this.activeSubmissionFor()) {
      return null;
    }
    const submission = adoptedSubmission(value);
    if (!submission) {
      return null;
    }
    this.activeSubmissions.set(submission.id, submission);
    this.state.activeSubmissionId = submission.id;
    this.state.prompt = "";
    this.state.attachments = [];
    this.state.attachmentError = "";
    this.context.requestError = "";
    const turnOptionsContext = this.turnOptionsContext();
    this.turnOptions()?.reset({
      ...turnOptionsContext,
      initialSelection: {
        ...turnOptionsContext.initialSelection,
        ...submission.options,
      },
    });
    this.turnOptions()?.holdSubmissionOptions(submission.options);
    this.draw();
    return submissionDetail(submission, this.context.threadId);
  }

  resetOverrides() {
    this.turnOptions()?.resetOverrides();
  }

  // The approval mode a turn sent from here would run under, for an owner that
  // presents that posture outside the Composer. Nothing until the agent's own
  // list of modes has answered.
  selectedPermissionMode() {
    return this.turnOptions()?.snapshot().permissionMode ?? "";
  }

  hasMeaningfulDraft() {
    this.captureCurrentState();
    return Boolean(
      this.state.prompt.trim() ||
        this.state.attachments.length ||
        this.activeSubmissionFor(),
    );
  }

  endEditingLifetime({ preserveOptions = false } = {}) {
    this.turnOptions()?.hidePopovers();
    if (preserveOptions || this.hasMeaningfulDraft()) {
      return false;
    }
    this.resetTurnOptions();
    return true;
  }

  hasRestorableState() {
    this.captureCurrentState();
    return Boolean(
      this.state.prompt.trim() ||
        this.state.attachments.length ||
        this.state.attachmentError ||
        this.activeSubmissionFor() ||
        this.context.requestError,
    );
  }

  override focus() {
    const textarea = this.promptField.value;
    textarea?.focus();
    textarea?.setSelectionRange(
      this.state.selectionStart,
      this.state.selectionEnd,
    );
  }

  // How full the Task's context is, as the agent last said, or null. The pie
  // takes it without the Composer drawing again.
  setContextUsage(
    context: { usedTokens?: unknown; windowTokens?: unknown } | null,
  ) {
    this.contextUsage?.setSnapshot(context);
  }

  turnOptions() {
    return this.optionsControl.value ?? null;
  }

  actionHintScope({ scopeId = "", ...pull }: ActionHintPull = {}) {
    const own = { ...pull, scopeId: `task-composer:${scopeId}` };
    const composer = this.hints.scope(own);
    return mergeActionHintScopes(
      composer,
      this.turnOptions()?.actionHintScope({ ...pull, scopeId }),
      this.attachmentStrip.value?.actionHintScope(own),
      this.contextUsage?.actionHintScope(own),
    );
  }

  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    return this.turnOptions()?.keyboardNavigationContexts({ scopeId }) ?? [];
  }

  // Whether the prompt field takes no text now: voice input is filling it, or
  // a new Task is being created from it. A Task that cannot be reached still
  // takes text; only sending waits for it.
  promptFieldLocked() {
    return (
      VOICE_BUSY_PHASES.has(this.voice.phase) ||
      (Boolean(this.activeSubmissionFor()) && this.context.mode === "create")
    );
  }

  primaryActionView() {
    const submitting = Boolean(this.activeSubmissionFor());
    const hasDraft = Boolean(
      this.state.prompt.trim() || this.state.attachments.length,
    );
    const voicePhase = this.voice.phase;
    const transportBlocked = this.context.disabled;
    const optionsReady = Boolean(this.turnOptions()?.readyForSubmission());
    const send = ({
      disabled = false,
      label = this.context.submitLabel,
    }: {
      disabled?: boolean;
      label?: string;
    } = {}) => ({
      kind: "send" as const,
      icon: "ArrowUp",
      label,
      title: transportBlocked
        ? "Caffold server is reconnecting."
        : disabled && submitting
          ? "Sending prompt"
          : label,
      disabled: transportBlocked || disabled || !optionsReady,
    });
    const stop = ({
      disabled = false,
      label = "Stop current turn",
      title = label,
    }: {
      disabled?: boolean;
      label?: string;
      title?: string;
    } = {}) => ({
      kind: "stop" as const,
      icon: "Square",
      label,
      title: transportBlocked ? "Caffold server is reconnecting." : title,
      disabled: transportBlocked || disabled,
    });

    if (voicePhase === "recording") {
      return send({
        disabled: submitting,
        label: "Finish voice input and send",
      });
    }
    // A message still uploading has not reached the agent, so stopping takes
    // it back — and stops the turn too when one is running.
    if (this.context.uploading && !this.context.interrupting) {
      return stop({
        label: this.context.turnActive ? "Stop current turn" : "Cancel upload",
      });
    }
    if (submitting) {
      return send({ disabled: true });
    }
    if (voicePhase === "requesting" || voicePhase === "transcribing") {
      return send({ disabled: true });
    }
    if (this.context.interrupting) {
      return stop({ disabled: true, title: "Stopping current turn" });
    }
    if (hasDraft) {
      return send();
    }
    if (this.context.mode === "follow-up" && this.context.turnActive) {
      return stop();
    }
    return send({ disabled: true });
  }

  override render() {
    const { context, state, voice } = this;
    const submitting = Boolean(this.activeSubmissionFor());
    const voiceBusy = VOICE_BUSY_PHASES.has(voice.phase);
    const creating = submitting && context.mode === "create";
    const fieldDisabled = this.promptFieldLocked();
    const recording = voice.phase === "recording";
    const voiceStatus = voiceStatusMessage(voice);
    const voiceAlert = ["error", "unavailable", "notReady"].includes(
      voice.phase,
    );
    const voiceLabel = voiceActionLabel(voice.phase, voice.ready);
    const voiceIcon = recording
      ? "Square"
      : VOICE_WAITING_PHASES.has(voice.phase)
        ? "LoaderCircle"
        : "Mic";
    const duration = formatRecordingDuration(voice.elapsedSeconds);
    const durationShown =
      recording ||
      (voice.phase === "transcribing" && voice.recordingLimitReached);
    const options = this.turnOptions()?.snapshot();
    const action = this.primaryActionView();
    const busy = submitting || voiceBusy || context.interrupting;
    return html`
      <form
        class=${`task-composer ${context.className ?? ""}`.trim()}
        data-task-form=${context.mode}
        data-voice-state=${voice.phase}
        data-thread-id=${context.threadId || nothing}
        aria-busy=${busy ? "true" : "false"}
        @submit=${this.handleSubmit}
      >
        <div class="task-composer-panel" ?data-drop-target=${this.dropTarget}>
          <caffold-task-composer-attachments
            ${drawn(this.attachmentStrip)}
            @caffold:task-composer-attachment-remove=${this.removeAttachment}
          ></caffold-task-composer-attachments>
          <textarea
            ${drawn(this.promptField)}
            ${this.hints.textbox({
              id: "prompt",
              label:
                context.mode === "create"
                  ? "Edit new task prompt"
                  : "Edit follow-up prompt",
              action: ACTION_HINT_ACTION.PROMPT_FOCUS,
              // Focusing the Composer puts the caret back where the draft
              // left it.
              control: () => this,
              when: !fieldDisabled,
            })}
            name="prompt"
            rows="1"
            placeholder=${context.placeholder}
            aria-label=${context.ariaLabel}
            ?disabled=${fieldDisabled}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
            @compositionstart=${this.compositionStarted}
            @compositionend=${this.compositionEnded}
            @paste=${this.handlePaste}
          ></textarea>
          <div
            class="task-composer-render-region"
            data-composer-region="create-status"
          >${
            creating
              ? html`<p
                  class="task-composer-create-status"
                  role="status"
                >Starting the task...</p>`
              : nothing
          }</div>
          <div
            class="task-composer-render-region"
            data-composer-region="voice-status"
          >${
            voiceStatus
              ? html`<p
                  class=${`task-composer-voice-status ${
                    voiceAlert ? "is-error" : ""
                  }`}
                  role=${voiceAlert ? "alert" : "status"}
                >${voiceStatus}</p>`
              : nothing
          }</div>
          <div
            class="task-composer-render-region"
            data-composer-region="interrupt-error"
          >${
            context.interruptError
              ? html`<p
                  class="task-composer-interrupt-error"
                  role="alert"
                >${context.interruptError}</p>`
              : nothing
          }</div>
          <div
            class="task-composer-render-region"
            data-composer-region="attachment-error"
          >${
            state.attachmentError
              ? html`<p
                  class="task-composer-attachment-error"
                  role="alert"
                >${state.attachmentError}</p>`
              : nothing
          }</div>
          <div
            class="task-composer-render-region"
            data-composer-region="request-error"
          >${
            context.requestError
              ? html`<p
                  class="task-composer-request-error"
                  role="alert"
                >${context.requestError}</p>`
              : nothing
          }</div>
          <input type="hidden" name="model" .value=${options?.model ?? ""}>
          <input type="hidden" name="effort" .value=${options?.effort ?? ""}>
          <input
            type="hidden"
            name="fastMode"
            .value=${options?.fastMode ? "true" : "false"}
          >
          <input
            type="hidden"
            name="permissionMode"
            .value=${options?.permissionMode ?? ""}
          >
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              <button
                ${this.hints.button({
                  id: "attach",
                  label: "Attach files",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                class="task-composer-attach-button"
                data-composer-action="attach"
                aria-label="Attach files"
                title="Attach files"
                ?disabled=${fieldDisabled || !this.acceptsAttachments()}
                @click=${this.handleAction}
              >${inlineIcon(
                "Paperclip",
                "Attach files",
                "task-composer-attach-icon",
              )}</button>
              <input
                ${drawn(this.fileInput)}
                type="file"
                multiple
                hidden
                data-composer-file-input
                @change=${this.handleFileChoice}
              >
              <div
                class="task-composer-render-region"
                data-composer-region="cancel"
              >${
                context.cancel
                  ? html`<button
                      ${this.hints.button({
                        id: "cancel",
                        label: "Cancel",
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                      })}
                      type="button"
                      class="task-toolbar-button"
                      data-composer-action="cancel"
                      @click=${this.handleAction}
                    >Cancel</button>`
                  : nothing
              }</div>
              <caffold-task-turn-options
                ${drawn(this.optionsControl)}
                @caffold:task-turn-options-change=${this.turnOptionsChanged}
              ></caffold-task-turn-options>
            </div>
            <div class="task-composer-actions">
              <caffold-task-context-usage
                ${drawn(this.usagePie)}
                ?hidden=${context.mode !== "follow-up"}
              ></caffold-task-context-usage>
              <div
                class="task-composer-render-region"
                data-composer-region="actions"
              >
                <caffold-voice-level-meter
                  ${drawn(this.levelMeter)}
                  ?hidden=${!recording}
                ></caffold-voice-level-meter>
                <span
                  class=${
                    voice.recordingLimitReached
                      ? "task-voice-elapsed is-limit"
                      : "task-voice-elapsed"
                  }
                  role="timer"
                  aria-label=${`Recording duration ${duration}`}
                  ?hidden=${!durationShown}
                >${duration}</span>
                <button
                  ${this.hints.button({
                    id: "cancel-voice",
                    label: "Cancel voice input",
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                  })}
                  type="button"
                  class="task-voice-cancel-button"
                  data-composer-action="cancel-voice"
                  aria-label="Cancel voice input"
                  title="Cancel voice input"
                  ?hidden=${!voiceBusy}
                  @click=${this.handleAction}
                >${inlineIcon(
                  "X",
                  "Cancel voice input",
                  "task-voice-cancel-icon",
                )}</button>
                <button
                  ${this.hints.button({
                    id: "voice",
                    label: voiceLabel,
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                  })}
                  type="button"
                  class=${voiceButtonClasses(voice.phase)}
                  data-composer-action="voice"
                  aria-label=${voiceLabel}
                  title=${voiceLabel}
                  ?disabled=${this.voiceDisabled() && !recording}
                  @pointerdown=${this.holdVoiceInsertion}
                  @click=${this.handleAction}
                >${inlineIcon(
                  voiceIcon,
                  voiceLabel,
                  "task-voice-icon",
                )}</button>
                <button
                  ${drawn(this.primaryButton)}
                  ${this.hints.button({
                    // Send and Stop take turns on one button; a key offered
                    // for one does not press the other.
                    id: `primary:${action.kind}`,
                    label: action.label,
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                  })}
                  class="task-primary-action-button"
                  type=${action.kind === "send" ? "submit" : "button"}
                  data-primary-action=${action.kind}
                  data-composer-action=${
                    action.kind === "stop" ? "interrupt" : nothing
                  }
                  data-primary-action-icon=${action.icon}
                  aria-label=${action.label}
                  title=${action.title}
                  ?disabled=${action.disabled}
                  @click=${this.handleAction}
                >${inlineIcon(
                  action.icon,
                  action.label,
                  "task-primary-action-icon",
                )}</button>
              </div>
            </div>
          </div>
        </div>
      </form>
    `;
  }

  // After each drawing the attachments and the prompt field catch up.
  override updated() {
    if (this.dataset.composerMode !== this.context.mode) {
      this.dataset.composerMode = this.context.mode;
    }
    this.attachmentStrip.value?.setAttachments(this.state.attachments);
    this.syncPromptField();
  }

  // An owner that sizes around the Composer hears that it may have changed.
  // The recording clock is drawn by a Lit update alone, as it changes no size.
  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.syncTurnOptionsContext();
    this.notifyLayoutChange();
  }

  private syncPromptField() {
    const textarea = this.promptField.value;
    if (!textarea) {
      return;
    }
    if (this.compositionActive) {
      this.drewWhileComposing = true;
      return;
    }
    if (textarea.value === this.state.prompt) {
      return;
    }
    const focused = document.activeElement === textarea;
    const { selectionStart, selectionEnd } = textarea;
    textarea.value = this.state.prompt;
    if (focused) {
      textarea.setSelectionRange(selectionStart, selectionEnd);
    }
  }

  private turnOptionsContext(): TurnOptionsContext {
    const submitting = Boolean(this.activeSubmissionFor());
    const requestLocked =
      submitting ||
      this.context.disabled ||
      VOICE_BUSY_PHASES.has(this.voice.phase) ||
      this.context.interrupting;
    return {
      cwd: this.context.cwd,
      // A follow-up belongs to a Task that already has an agent; a new Task
      // does not, and every agent's models are on offer.
      provider: this.context.provider ?? "",
      initialSelection: {
        model: this.context.model ?? "",
        effort: this.context.effort ?? "",
        fastMode: this.context.fastMode,
        permissionMode: this.context.permissionMode ?? "",
      },
      locked: requestLocked || this.context.settingsLocked,
      placement: this.context.mode === "follow-up" ? "above" : "below",
    };
  }

  // The turn options take the context from here rather than from the
  // template: a new directory or agent asks them for another list.
  private syncTurnOptionsContext() {
    this.turnOptions()?.setContext(this.turnOptionsContext());
  }

  private resetTurnOptions() {
    this.turnOptions()?.reset(this.turnOptionsContext());
  }

  private turnOptionsChanged(event: CustomEvent<TurnOptionsSnapshot>) {
    if (event.target === this.turnOptions()) {
      this.draw();
    }
  }

  // Messages that never reached the agent go back in the order they were
  // sent, ahead of whatever was written since.
  private restoreAheadOfDraft(
    prompts: string[],
    attachments: ComposerAttachment[],
  ) {
    this.captureCurrentState();
    const state = this.state;
    state.prompt = [...prompts, state.prompt]
      .filter((text) => text.trim())
      .join("\n\n");
    state.selectionStart = state.prompt.length;
    state.selectionEnd = state.prompt.length;
    const restored = [...attachments, ...state.attachments];
    state.attachments = restored.slice(0, MAX_ATTACHMENTS);
    state.attachmentError =
      restored.length > MAX_ATTACHMENTS ? TOO_MANY_ATTACHMENTS : "";
  }

  private activeSubmissionFor() {
    const submissionId = this.state.activeSubmissionId;
    return submissionId
      ? (this.activeSubmissions.get(submissionId) ?? null)
      : null;
  }

  private captureCurrentState() {
    const textarea = this.promptField.value;
    if (!textarea) {
      return;
    }
    this.state.prompt = textarea.value;
    this.state.selectionStart = textarea.selectionStart;
    this.state.selectionEnd = textarea.selectionEnd;
  }

  private async loadVoiceStatus() {
    const support = voiceCaptureSupport();
    if (!support.supported) {
      this.setVoicePhase("unavailable");
      this.voice.error = support.message;
      this.draw();
      return;
    }
    const requestId = ++this.voiceStatusRequestId;
    this.setVoicePhase("checking");
    this.voice.error = "";
    this.draw();
    try {
      const response = await getVoiceStatus();
      if (requestId !== this.voiceStatusRequestId) {
        return;
      }
      this.applyVoiceStatus(response);
      this.setVoicePhase(this.voice.ready ? "idle" : "notReady");
    } catch (error) {
      if (requestId !== this.voiceStatusRequestId) {
        return;
      }
      this.setVoicePhase("error");
      this.voice.error =
        error instanceof Error ? error.message : "Voice input is unavailable.";
    }
    this.draw();
  }

  private setVoicePhase(next: VoicePhase) {
    const current = this.voice.phase;
    if (next === current) {
      return;
    }
    if (!VOICE_PHASE_EDGES.get(current)?.has(next)) {
      throw new Error(`Invalid voice input transition: ${current} -> ${next}`);
    }
    this.voice.phase = next;
  }

  private applyVoiceStatus(response: VoiceStatus) {
    this.voice.ready = response.ready === true;
    this.voice.maxRecordingSeconds =
      Number.isFinite(response.maxRecordingSeconds) &&
      response.maxRecordingSeconds > 0
        ? response.maxRecordingSeconds
        : DEFAULT_MAX_RECORDING_SECONDS;
  }

  private voiceDisabled() {
    return (
      Boolean(this.activeSubmissionFor()) ||
      this.context.disabled ||
      this.context.interrupting ||
      VOICE_WAITING_PHASES.has(this.voice.phase) ||
      this.voice.phase === "unavailable"
    );
  }

  private handleInput() {
    this.captureCurrentState();
    this.draw();
  }

  private handleKeydown(event: KeyboardEvent) {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing
    ) {
      return;
    }
    const textarea = this.promptField.value;
    const form = textarea?.form;
    if (
      !textarea ||
      !form ||
      (!textarea.value.trim() && !this.state.attachments.length)
    ) {
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  }

  private compositionStarted() {
    window.clearTimeout(this.compositionTimer ?? undefined);
    this.compositionTimer = null;
    this.compositionActive = true;
  }

  // The field is read again once the input method has let go of it.
  private compositionEnded() {
    this.compositionActive = false;
    window.clearTimeout(this.compositionTimer ?? undefined);
    this.compositionTimer = window.setTimeout(() => {
      this.compositionTimer = null;
      if (
        !this.isConnected ||
        this.compositionActive ||
        !this.drewWhileComposing
      ) {
        return;
      }
      this.drewWhileComposing = false;
      this.captureCurrentState();
      this.draw();
    }, 0);
  }

  // The click is the action's alone. Stop can turn into Send in place while
  // it is handled, and the browser must not then submit as well.
  private handleAction(event: Event) {
    const action = event.currentTarget;
    const type =
      action instanceof HTMLElement ? action.dataset.composerAction : undefined;
    if (!type) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (type === "voice") {
      void this.handleVoiceAction();
    } else if (type === "cancel-voice") {
      void this.cancelVoiceInput();
    } else if (type === "cancel" || type === "interrupt") {
      this.dispatchEvent(
        new CustomEvent<ComposerIntentDetail>("caffold:task-composer-intent", {
          bubbles: true,
          composed: true,
          detail: { type },
        }),
      );
    } else if (type === "attach") {
      this.fileInput.value?.click();
    }
  }

  private removeAttachment(event: CustomEvent<AttachmentRemoveDetail>) {
    if (event.target !== this.attachmentStrip.value) {
      return;
    }
    event.stopPropagation();
    this.state.attachments = this.state.attachments.filter(
      (attachment) => attachment.id !== event.detail.attachmentId,
    );
    this.state.attachmentError = "";
    this.draw();
  }

  // Pressing the microphone moves focus away from the prompt, so the place a
  // transcript goes is taken as the press begins.
  private holdVoiceInsertion() {
    if (!this.voice.ready || !["idle", "error"].includes(this.voice.phase)) {
      return;
    }
    const textarea = this.promptField.value;
    if (!textarea) {
      return;
    }
    this.state.prompt = textarea.value;
    if (document.activeElement === textarea) {
      this.state.selectionStart = textarea.selectionStart;
      this.state.selectionEnd = textarea.selectionEnd;
    }
    this.voiceInsertion = {
      prompt: this.state.prompt,
      start: this.state.selectionStart,
      end: this.state.selectionEnd,
    };
  }

  private async handleVoiceAction() {
    const phase = this.voice.phase;
    if (phase === "recording") {
      await this.stopVoiceRecording();
      return;
    }
    if (phase === "notReady" || (phase === "error" && !this.voice.ready)) {
      this.dispatchEvent(
        new CustomEvent<OpenSettingsDetail>("caffold:open-settings", {
          bubbles: true,
          composed: true,
          detail: { section: "voice" },
        }),
      );
      return;
    }
    if (phase === "idle" || phase === "error") {
      await this.startVoiceRecording();
    }
  }

  private async startVoiceRecording() {
    this.voiceInsertion ??= {
      prompt: this.state.prompt,
      start: this.state.selectionStart,
      end: this.state.selectionEnd,
    };
    const operationId = ++this.voiceOperationId;
    this.voice.elapsedSeconds = 0;
    this.voice.recordingLimitReached = false;
    const recorder = new VoiceRecorder({
      maxSeconds: this.voice.maxRecordingSeconds,
      onElapsed: (elapsedSeconds) => {
        if (operationId === this.voiceOperationId) {
          this.voice.elapsedSeconds = elapsedSeconds;
          this.voice.recordingLimitReached =
            elapsedSeconds >= this.voice.maxRecordingSeconds;
          this.requestUpdate();
        }
      },
      onLevel: (level) => {
        if (operationId === this.voiceOperationId) {
          this.levelMeter.value?.setLevel(level);
        }
      },
      onLimit: () => {
        if (operationId === this.voiceOperationId) {
          void this.stopVoiceRecording();
        }
      },
    });
    this.voiceRecorder = recorder;
    this.levelMeter.value?.reset();
    this.setVoicePhase("requesting");
    this.voice.error = "";
    this.draw();
    try {
      await recorder.start();
      if (operationId !== this.voiceOperationId) {
        await recorder.cancel();
        return;
      }
      this.setVoicePhase("recording");
      this.draw();
    } catch (error) {
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.voiceRecorder = null;
      this.setVoicePhase("error");
      this.voice.error = voiceCaptureError(error);
      this.draw();
    }
  }

  private async stopVoiceRecording({ submitAfterTranscription = false } = {}) {
    if (this.voice.phase !== "recording" || !this.voiceRecorder) {
      return;
    }
    const operationId = this.voiceOperationId;
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    this.setVoicePhase("transcribing");
    this.draw();
    let shouldSubmit = false;
    try {
      const recording = await recorder.stop();
      if (operationId !== this.voiceOperationId) {
        return;
      }
      const request = new AbortController();
      this.voiceRequest = request;
      const response = await transcribeVoice(recording, request.signal);
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.voiceRequest = null;
      const transcript = response.text.trim();
      if (!transcript) {
        throw new Error("No speech was detected in the recording.");
      }
      this.insertVoiceTranscript(transcript);
      this.setVoicePhase("idle");
      this.voice.error = "";
      this.voice.elapsedSeconds = 0;
      this.voice.recordingLimitReached = false;
      this.voiceInsertion = null;
      shouldSubmit = submitAfterTranscription;
    } catch (error) {
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.voiceRequest = null;
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "voice_provider_not_ready"
      ) {
        this.voice.ready = false;
        this.setVoicePhase("notReady");
      } else {
        this.setVoicePhase("error");
      }
      this.voice.error =
        error instanceof Error
          ? error.message
          : "Could not transcribe the recording.";
      this.voice.elapsedSeconds = 0;
      this.voice.recordingLimitReached = false;
    }
    this.draw();
    if (shouldSubmit) {
      const send = this.primaryButton.value;
      send?.form?.requestSubmit(send);
    }
  }

  private async cancelVoiceInput() {
    this.voiceOperationId += 1;
    this.voiceRequest?.abort();
    this.voiceRequest = null;
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    await recorder?.cancel();
    if (VOICE_BUSY_PHASES.has(this.voice.phase)) {
      this.setVoicePhase("idle");
    }
    this.voice.error = "";
    this.voice.elapsedSeconds = 0;
    this.voice.recordingLimitReached = false;
    this.voiceInsertion = null;
    this.draw();
  }

  private insertVoiceTranscript(transcript: string) {
    const state = this.state;
    const insertion = this.voiceInsertion ?? {
      prompt: state.prompt,
      start: state.prompt.length,
      end: state.prompt.length,
    };
    const prompt = insertion.prompt;
    const start = Math.max(0, Math.min(insertion.start, prompt.length));
    const end = Math.max(start, Math.min(insertion.end, prompt.length));
    const prefix = prompt.slice(0, start);
    const suffix = prompt.slice(end);
    const before = prefix && !/\s$/.test(prefix) ? " " : "";
    const after = suffix && !/^\s/.test(suffix) ? " " : "";
    const inserted = `${before}${transcript}${after}`;
    state.prompt = `${prefix}${inserted}${suffix}`;
    state.selectionStart = start + inserted.length;
    state.selectionEnd = state.selectionStart;
  }

  private async handlePaste(event: ClipboardEvent) {
    if (!this.acceptsAttachments()) {
      return;
    }
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    await this.addAttachments(files, { pasted: true });
  }

  private async handleFileChoice(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length && this.acceptsAttachments()) {
      await this.addAttachments(files);
    }
  }

  private handleDragover(event: DragEvent) {
    if (!carriesFiles(event.dataTransfer) || !this.acceptsAttachments()) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    this.dropTarget = true;
  }

  private handleDragleave(event: DragEvent) {
    const into = event.relatedTarget;
    if (!(into instanceof Node) || !this.contains(into)) {
      this.dropTarget = false;
    }
  }

  private async handleDrop(event: DragEvent) {
    const transfer = event.dataTransfer;
    if (!transfer || !carriesFiles(transfer)) {
      return;
    }
    event.preventDefault();
    this.dropTarget = false;
    if (!this.acceptsAttachments()) {
      return;
    }
    const items = Array.from(transfer.items);
    const folders = items.some((item) => item.webkitGetAsEntry()?.isDirectory);
    const files = items.length
      ? items
          .filter(
            (item) =>
              item.kind === "file" && !item.webkitGetAsEntry()?.isDirectory,
          )
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
      : Array.from(transfer.files);
    await this.addAttachments(files, {
      error: folders ? "Folders cannot be attached." : "",
    });
  }

  private acceptsAttachments() {
    return (
      !this.context.disabled &&
      !(this.context.mode === "create" && this.activeSubmissionFor())
    );
  }

  private async addAttachments(
    files: File[],
    { pasted = false, error: initialError = "" } = {},
  ) {
    const state = this.state;
    const accepted: ComposerAttachment[] = [];
    let error = initialError;
    for (const [index, file] of files.entries()) {
      if (state.attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        error = TOO_MANY_ATTACHMENTS;
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        error = `${file.name || "A file"} is larger than 5 GB.`;
        continue;
      }
      const imageInput =
        IMAGE_INPUT_TYPES.has(file.type) && file.size <= MAX_IMAGE_INPUT_BYTES;
      const ordinal = state.attachments.length + accepted.length + 1;
      const attachment: ComposerAttachment = {
        id: `attachment:${Date.now()}:${index}:${Math.random().toString(36).slice(2)}`,
        file,
        name:
          file.name ||
          (pasted && imageInput
            ? `clipboard-image-${ordinal}.${imageExtension(file.type)}`
            : `file-${ordinal}`),
        type: file.type,
        size: file.size,
        imageInput,
        dataUrl: "",
      };
      if (imageInput) {
        try {
          attachment.dataUrl = await readFileAsDataUrl(file);
        } catch {
          error = `Could not read ${attachment.name}.`;
          continue;
        }
      }
      accepted.push(attachment);
    }
    state.attachments = [...state.attachments, ...accepted];
    state.attachmentError = error;
    this.draw();
  }

  private handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    if (this.voice.phase === "recording") {
      const submitter = event.submitter;
      if (
        !this.activeSubmissionFor() &&
        !this.context.disabled &&
        submitter?.classList.contains("task-primary-action-button")
      ) {
        void this.stopVoiceRecording({ submitAfterTranscription: true });
      }
      return;
    }
    if (
      this.activeSubmissionFor() ||
      this.context.disabled ||
      !this.turnOptions()?.readyForSubmission() ||
      VOICE_BUSY_PHASES.has(this.voice.phase)
    ) {
      return;
    }
    this.captureCurrentState();
    const state = this.state;
    const prompt = state.prompt.trim();
    if (!prompt && !state.attachments.length) {
      return;
    }
    const submissionId = [
      this.context.mode,
      Date.now(),
      ++this.submissionSequence,
    ].join(":");
    const options = this.turnOptions()?.submissionOptions() ?? {
      fastMode: false,
    };
    const textarea = this.promptField.value;
    const restorePromptFocusOnRejection =
      !event.submitter && document.activeElement === textarea;
    const submission: Submission = {
      id: submissionId,
      prompt,
      attachments: [...state.attachments],
      options: { ...options },
      restorePromptFocusOnRejection,
    };
    this.activeSubmissions.set(submissionId, submission);
    state.activeSubmissionId = submissionId;
    state.prompt = "";
    state.attachments = [];
    state.attachmentError = "";
    this.context.requestError = "";
    this.turnOptions()?.hidePopovers();
    if (restorePromptFocusOnRejection) {
      textarea?.blur();
    }
    this.draw();
    this.dispatchEvent(
      new CustomEvent<ComposerSubmitDetail>("caffold:task-composer-submit", {
        bubbles: true,
        composed: true,
        detail: {
          submissionId,
          threadId: this.context.threadId,
          prompt,
          attachments: [...submission.attachments],
          options,
        },
      }),
    );
  }

  private notifyLayoutChange() {
    if (this.context.mode !== "follow-up") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-composer-layout-change", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  // Mounted once, so an open popover stays open while the agent's count moves.
  private get contextUsage() {
    this.performUpdate();
    return this.usagePie.value;
  }
}

function createDraft(): Draft {
  return {
    prompt: "",
    attachments: [],
    attachmentError: "",
    selectionStart: 0,
    selectionEnd: 0,
    activeSubmissionId: "",
  };
}

function carriesFiles(dataTransfer: DataTransfer | null) {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

function voiceButtonClasses(phase: VoicePhase) {
  if (phase === "recording") {
    return "task-voice-button is-recording";
  }
  return VOICE_WAITING_PHASES.has(phase)
    ? "task-voice-button is-busy"
    : "task-voice-button";
}

function voiceActionLabel(phase: VoicePhase, ready: boolean) {
  if (phase === "recording") {
    return "Stop recording";
  }
  if (phase === "transcribing") {
    return "Transcribing recording";
  }
  if (phase === "requesting") {
    return "Waiting for microphone access";
  }
  if (phase === "checking") {
    return "Checking voice input";
  }
  if (phase === "unavailable") {
    return "Voice input unavailable";
  }
  return ready ? "Start voice input" : "Set up voice input";
}

function voiceStatusMessage(voice: VoiceState) {
  if (voice.phase === "error" || voice.phase === "unavailable") {
    return voice.error || "Voice input is unavailable.";
  }
  if (voice.phase === "notReady") {
    return voice.error;
  }
  return "";
}

function voiceCaptureError(error: unknown) {
  const known = error instanceof Error || error instanceof DOMException;
  const name = known ? error.name : "";
  if (name === "NotAllowedError") {
    return "Microphone access was denied. Allow it in the browser settings and try again.";
  }
  if (name === "NotFoundError") {
    return "No microphone was found on this device.";
  }
  if (name === "NotReadableError") {
    return "The microphone is busy or unavailable.";
  }
  return known ? error.message : "Could not start microphone capture.";
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(`${reader.result ?? ""}`), {
      once: true,
    });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Could not read image")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

function imageExtension(type: string) {
  return IMAGE_EXTENSIONS[type] ?? "png";
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function shallowEqual(left: object, right: object) {
  const leftEntries = Object.entries(left);
  const rightRecord = new Map(Object.entries(right));
  return (
    leftEntries.length === rightRecord.size &&
    leftEntries.every(
      ([key, value]) =>
        rightRecord.has(key) && Object.is(value, rightRecord.get(key)),
    )
  );
}

function submissionDetail(
  submission: Submission,
  threadId: string,
): ComposerSubmission {
  return {
    submissionId: submission.id,
    threadId,
    prompt: submission.prompt,
    attachments: [...submission.attachments],
    options: { ...submission.options },
    restorePromptFocusOnRejection: submission.restorePromptFocusOnRejection,
  };
}

function adoptedSubmission(
  value: Partial<ComposerSubmission> & { id?: string },
): Submission | null {
  const id = (value.submissionId ?? value.id ?? "").trim();
  const prompt = (value.prompt ?? "").trim();
  const attachments = (value.attachments ?? []).map((attachment) => ({
    ...attachment,
  }));
  if (!id || (!prompt && !attachments.length)) {
    return null;
  }
  return {
    id,
    prompt,
    attachments,
    options: { ...value.options },
    restorePromptFocusOnRejection: Boolean(value.restorePromptFocusOnRejection),
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-composer": CaffoldTaskComposer;
  }

  interface HTMLElementEventMap {
    "caffold:task-composer-intent": CustomEvent<ComposerIntentDetail>;
    "caffold:task-composer-submit": CustomEvent<ComposerSubmitDetail>;
    "caffold:open-settings": CustomEvent<OpenSettingsDetail>;
  }
}
