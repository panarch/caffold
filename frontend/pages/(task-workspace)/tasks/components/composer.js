import {
  getVoiceStatus,
  installVoiceModel,
  transcribeVoice,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { cleanLogicalPath } from "../task-format.js";
import { requestTaskImagePreview } from "./image-preview-dialog.js";
import { collectComposerActionHintTargets } from "./composer/action-hints.js";
import "./task-turn-options.js";
import "./voice-level-meter.js";
import {
  formatRecordingDuration,
  VoiceRecorder,
  voiceCaptureSupport,
} from "./voice-recorder.js";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RECORDING_SECONDS = 5 * 60;
const IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function createComposerState() {
  return {
    prompt: "",
    images: [],
    imageError: "",
    selectionStart: 0,
    selectionEnd: 0,
    activeSubmissionId: "",
  };
}

class CaffoldTaskComposer extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("pointerdown", this.boundPointerdown);
    this.addEventListener("click", this.boundClick);
    this.addEventListener("input", this.boundInput);
    this.addEventListener("keydown", this.boundKeydown);
    this.addEventListener("compositionstart", this.boundCompositionStart);
    this.addEventListener("compositionend", this.boundCompositionEnd);
    this.addEventListener("paste", this.boundPaste, true);
    this.addEventListener("submit", this.boundSubmit, true);
    this.addEventListener(
      "caffold:task-turn-options-change",
      this.boundTurnOptionsChange,
    );
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
    void this.loadVoiceStatus();
  }

  disconnectedCallback() {
    this.captureCurrentState();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("pointerdown", this.boundPointerdown);
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("input", this.boundInput);
    this.removeEventListener("keydown", this.boundKeydown);
    this.removeEventListener("compositionstart", this.boundCompositionStart);
    this.removeEventListener("compositionend", this.boundCompositionEnd);
    this.removeEventListener("paste", this.boundPaste, true);
    this.removeEventListener("submit", this.boundSubmit, true);
    this.removeEventListener(
      "caffold:task-turn-options-change",
      this.boundTurnOptionsChange,
    );
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.voiceStatusRequestId += 1;
    this.voiceOperationId += 1;
    this.voiceRequest?.abort();
    this.voiceRequest = null;
    void this.voiceRecorder?.cancel();
    this.voiceRecorder = null;
    this.compositionActive = false;
    this.pendingRender = false;
    window.clearTimeout(this.compositionRenderTimer);
    this.compositionRenderTimer = null;
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.context = {
      mode: "create",
      cwd: ".",
      browseCwd: true,
      placeholder: "",
      ariaLabel: "Task prompt",
      submitLabel: "Send prompt",
      cancel: false,
      disabled: false,
      settingsLocked: false,
      requestError: "",
      turnActive: false,
      activeTurnId: "",
      interrupting: false,
      interruptError: "",
      fastMode: false,
    };
    this.state = createComposerState();
    this.boundThreadId = "";
    this.activeSubmissions = new Map();
    this.submissionSequence = 0;
    this.voice = {
      phase: "checking",
      error: "",
      modelId: "",
      modelInstalled: false,
      modelBytes: 0,
      maxRecordingSeconds: DEFAULT_MAX_RECORDING_SECONDS,
      elapsedSeconds: 0,
      recordingLimitReached: false,
    };
    this.voiceStatusRequestId = 0;
    this.voiceOperationId = 0;
    this.voiceRecorder = null;
    this.voiceRequest = null;
    this.voiceInsertion = null;
    this.compositionActive = false;
    this.pendingRender = false;
    this.compositionRenderTimer = null;
    this.boundPointerdown = (event) => this.handlePointerdown(event);
    this.boundClick = (event) => this.handleClick(event);
    this.boundInput = (event) => this.handleInput(event);
    this.boundKeydown = (event) => this.handleKeydown(event);
    this.boundCompositionStart = (event) => {
      if (closestElement(event.target, "textarea[name='prompt']")) {
        window.clearTimeout(this.compositionRenderTimer);
        this.compositionRenderTimer = null;
        this.compositionActive = true;
      }
    };
    this.boundCompositionEnd = (event) => {
      if (!closestElement(event.target, "textarea[name='prompt']")) {
        return;
      }
      this.compositionActive = false;
      window.clearTimeout(this.compositionRenderTimer);
      this.compositionRenderTimer = window.setTimeout(() => {
        this.compositionRenderTimer = null;
        if (!this.isConnected || this.compositionActive || !this.pendingRender) {
          return;
        }
        this.captureCurrentState();
        this.render();
      }, 0);
    };
    this.boundPaste = (event) => {
      void this.handlePaste(event);
    };
    this.boundSubmit = (event) => this.handleSubmit(event);
    this.boundIconsReady = () => this.render();
    this.boundTurnOptionsChange = (event) => {
      if (event.target !== this.turnOptions()) {
        return;
      }
      this.syncTurnOptionsFields();
      this.notifyLayoutChange();
    };
    warmIcons();
  }

  setContext(context = {}) {
    this.ensureState();
    const nextMode = `${context.mode ?? this.context.mode ?? "create"}`;
    const nextThreadId =
      `${context.threadId ?? this.context.threadId ?? ""}`.trim();
    if (nextMode === "follow-up" && nextThreadId) {
      if (this.boundThreadId && this.boundThreadId !== nextThreadId) {
        throw new Error(
          `Task Composer is already bound to thread ${this.boundThreadId}.`,
        );
      }
      this.boundThreadId = nextThreadId;
    }
    this.captureCurrentState();
    const nextContext = {
      ...this.context,
      ...context,
      mode: nextMode,
      threadId: nextThreadId,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd ?? "."),
      browseCwd: Object.hasOwn(context, "browseCwd")
        ? Boolean(context.browseCwd)
        : this.context.browseCwd,
      disabled: Boolean(context.disabled),
      settingsLocked: Boolean(context.settingsLocked),
      turnActive: Boolean(context.turnActive),
      activeTurnId: `${context.activeTurnId ?? ""}`.trim(),
      interrupting: Boolean(context.interrupting),
      requestError: Object.hasOwn(context, "requestError")
        ? `${context.requestError ?? ""}`
        : this.context.requestError,
      interruptError: Object.hasOwn(context, "interruptError")
        ? `${context.interruptError ?? ""}`
        : this.context.interruptError,
    };
    const contextChanged = !shallowEqual(this.context, nextContext);
    this.context = nextContext;
    if (!contextChanged) {
      this.syncTurnOptionsContext();
      return false;
    }
    this.setAttribute("data-composer-mode", this.context.mode);
    this.render();
    return true;
  }

  resolveSubmission(submissionId, result = {}) {
    this.ensureState();
    const submission = this.activeSubmissions.get(submissionId);
    if (!submission) {
      return false;
    }
    this.activeSubmissions.delete(submissionId);
    const state = this.stateFor();
    if (state.activeSubmissionId === submissionId) {
      state.activeSubmissionId = "";
    }
    if (result.status === "rejected") {
      state.prompt ||= submission.prompt;
      if (!state.images.length) {
        state.images = [...submission.images];
      }
      state.imageError = "";
    }
    if (result.resetOverrides) {
      this.turnOptions()?.resetOverrides();
    }
    if (result.resetOptions) {
      this.resetTurnOptions();
    }
    this.context.requestError = `${result.error?.message ?? result.error ?? ""}`;
    this.render();
    if (submission.restorePromptFocus) {
      this.focus();
    }
    return true;
  }

  // Remove an in-flight submission from this composer without accepting or
  // rejecting it. The returned value is the complete browser-owned request,
  // ready for another composer to adopt while a create-then-submit flow moves
  // from the New Task surface into the Task that was just created.
  takeSubmission(submissionId) {
    this.ensureState();
    const submission = this.activeSubmissions.get(submissionId);
    if (!submission) {
      return null;
    }
    this.activeSubmissions.delete(submissionId);
    const state = this.stateFor();
    if (state.activeSubmissionId === submissionId) {
      state.activeSubmissionId = "";
    }
    this.context.requestError = "";
    this.render();
    return submissionDetail(submission, this.context.threadId);
  }

  submissionSnapshot(submissionId) {
    this.ensureState();
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
  adoptSubmission(value = {}) {
    this.ensureState();
    if (this.activeSubmissionFor()) {
      return null;
    }
    const submission = normalizeAdoptedSubmission(value);
    if (!submission) {
      return null;
    }
    this.activeSubmissions.set(submission.id, submission);
    const state = this.stateFor();
    state.activeSubmissionId = submission.id;
    state.prompt = "";
    state.images = [];
    state.imageError = "";
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
    this.render();
    return submissionDetail(submission, this.context.threadId);
  }

  resetOverrides() {
    this.turnOptions()?.resetOverrides();
  }

  hasMeaningfulDraft() {
    this.captureCurrentState();
    const state = this.stateFor();
    return Boolean(
      state.prompt.trim() || state.images.length || this.activeSubmissionFor()
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
    const state = this.stateFor();
    return Boolean(
      state.prompt.trim() ||
        state.images.length ||
        state.imageError ||
        this.activeSubmissionFor() ||
        this.context.requestError,
    );
  }

  focus() {
    const textarea = this.querySelector("textarea[name='prompt']");
    textarea?.focus();
    if (textarea && Number.isInteger(this.stateFor().selectionStart)) {
      textarea.setSelectionRange(
        this.stateFor().selectionStart,
        this.stateFor().selectionEnd,
      );
    }
  }

  actionHintTargets({ scopeId, clipRoots = [] } = {}) {
    this.ensureState();
    const mode = this.context.mode;
    return collectComposerActionHintTargets({
      mode,
      scopeId,
      modelTarget: () => {
        const target = this.turnOptions()?.actionHintModelTarget({
          scopeId,
          clipRoots,
        });
        if (!target) {
          return null;
        }
        const isActionable = target.isActionable;
        return {
          ...target,
          isActionable: () =>
            this.context.mode === mode && isActionable(),
        };
      },
      permissionTarget: () => {
        const target = this.turnOptions()?.actionHintPermissionTarget({
          scopeId,
          clipRoots,
        });
        if (!target) {
          return null;
        }
        const isActionable = target.isActionable;
        return {
          ...target,
          isActionable: () =>
            this.context.mode === mode && isActionable(),
        };
      },
      promptTarget: () => {
        const textarea = this.querySelector("textarea[name='prompt']");
        return textarea
          ? {
              id: `task-composer:${scopeId}:prompt`,
              actionId: "task.prompt.focus",
              label: mode === "create"
                ? "Edit new task prompt"
                : "Edit follow-up prompt",
              controlKind: "textbox",
              control: textarea,
              anchor: textarea,
              clipRoots: [...clipRoots],
              isActionable: () =>
                this.context.mode === mode &&
                this.querySelector("textarea[name='prompt']") === textarea &&
                !textarea.disabled,
              activate: () => this.focus(),
            }
          : null;
      },
    });
  }

  keyboardNavigationContexts({ scopeId = "" } = {}) {
    this.ensureState();
    if (!COMPOSER_KEYBOARD_CONTEXT_MODES.has(this.context.mode)) {
      return [];
    }
    return this.turnOptions()?.keyboardNavigationContexts({ scopeId }) ?? [];
  }

  stateFor() {
    return this.state;
  }

  activeSubmissionFor() {
    const submissionId = this.stateFor().activeSubmissionId;
    return submissionId
      ? this.activeSubmissions.get(submissionId) ?? null
      : null;
  }

  primaryActionView() {
    const state = this.stateFor();
    const submitting = Boolean(this.activeSubmissionFor());
    const hasDraft = Boolean(state.prompt.trim() || state.images.length);
    const voicePhase = this.voice.phase;
    const transportBlocked = this.context.disabled;
    const send = (
      { disabled = false, label = this.context.submitLabel } = {},
    ) => ({
      kind: "send",
      icon: "ArrowUp",
      label,
      title: transportBlocked
        ? "Caffold server is reconnecting."
        : disabled && submitting
          ? "Sending prompt"
          : label,
      disabled: transportBlocked || disabled,
    });
    const stop = ({ disabled = false, title = "Stop current turn" } = {}) => ({
      kind: "stop",
      icon: "Square",
      label: "Stop current turn",
      title: transportBlocked ? "Caffold server is reconnecting." : title,
      disabled: transportBlocked || disabled,
    });

    if (voicePhase === "recording") {
      return send({
        disabled: submitting,
        label: "Finish voice input and send",
      });
    }
    if (submitting) {
      return send({ disabled: true });
    }
    if (["requesting", "transcribing"].includes(voicePhase)) {
      return send({ disabled: true });
    }
    if (this.context.interrupting) {
      return stop({ disabled: true, title: "Stopping current turn" });
    }
    if (hasDraft) {
      return send();
    }
    if (this.context.mode === "follow-up" && this.context.turnActive) {
      return stop({
        disabled: !this.context.activeTurnId,
        title: this.context.activeTurnId
          ? "Stop current turn"
          : "Stop is unavailable until the active turn is identified.",
      });
    }
    return send({ disabled: true });
  }

  captureCurrentState() {
    const textarea = this.querySelector("textarea[name='prompt']");
    if (!textarea) {
      return;
    }
    const state = this.stateFor();
    state.prompt = textarea.value;
    state.selectionStart = textarea.selectionStart;
    state.selectionEnd = textarea.selectionEnd;
  }

  async loadVoiceStatus() {
    const support = voiceCaptureSupport();
    if (!support.supported) {
      this.voice.phase = "unavailable";
      this.voice.error = support.message;
      this.render();
      return;
    }
    const requestId = ++this.voiceStatusRequestId;
    this.voice.phase = "checking";
    this.voice.error = "";
    this.render();
    try {
      const response = await getVoiceStatus();
      if (requestId !== this.voiceStatusRequestId) {
        return;
      }
      this.applyVoiceStatus(response);
      this.voice.phase = response?.model?.downloading ? "downloading" : "idle";
    } catch (error) {
      if (requestId !== this.voiceStatusRequestId) {
        return;
      }
      this.voice.phase = "error";
      this.voice.error = `${error?.message ?? "Voice input is unavailable."}`;
    }
    this.render();
  }

  applyVoiceStatus(response) {
    this.voice.modelId = `${response?.model?.id ?? ""}`;
    this.voice.modelInstalled = Boolean(response?.model?.installed);
    this.voice.modelBytes = Number(response?.model?.bytes ?? 0);
    const maxRecordingSeconds = Number(
      response?.maxRecordingSeconds ?? DEFAULT_MAX_RECORDING_SECONDS,
    );
    this.voice.maxRecordingSeconds =
      Number.isFinite(maxRecordingSeconds) && maxRecordingSeconds > 0
        ? maxRecordingSeconds
        : DEFAULT_MAX_RECORDING_SECONDS;
  }

  handleInput(event) {
    const textarea = closestElement(event.target, "textarea[name='prompt']");
    if (!textarea) {
      return;
    }
    const state = this.stateFor();
    state.prompt = textarea.value;
    state.selectionStart = textarea.selectionStart;
    state.selectionEnd = textarea.selectionEnd;
    this.notifyLayoutChange();
    this.syncPrimaryAction();
  }

  syncPrimaryAction() {
    const button = this.querySelector(".task-primary-action-button");
    if (!button) {
      return;
    }
    const action = this.primaryActionView();
    button.type = action.kind === "send" ? "submit" : "button";
    button.disabled = action.disabled;
    button.dataset.primaryAction = action.kind;
    if (action.kind === "stop") {
      button.dataset.composerAction = "interrupt";
    } else {
      delete button.dataset.composerAction;
    }
    button.setAttribute("aria-label", action.label);
    button.title = action.title;
    if (button.dataset.primaryActionIcon !== action.icon) {
      button.dataset.primaryActionIcon = action.icon;
      button.innerHTML = renderInlineIcon(
        action.icon,
        action.label,
        "task-primary-action-icon",
      );
    }
  }

  handleKeydown(event) {
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
    const textarea = closestElement(event.target, "textarea[name='prompt']");
    const form = closestElement(textarea, "form[data-task-form]");
    if (
      !textarea ||
      !form ||
      (!textarea.value.trim() && !this.stateFor().images.length)
    ) {
      return;
    }
    event.preventDefault();
    form.requestSubmit();
  }

  handleClick(event) {
    const action = closestElement(event.target, "[data-composer-action]");
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const type = action.dataset.composerAction;
    if (type === "voice") {
      void this.handleVoiceAction();
      return;
    }
    if (type === "cancel-voice") {
      void this.cancelVoiceInput();
      return;
    }
    if (type === "browse-cwd" || type === "cancel") {
      this.dispatchIntent(type);
      return;
    }
    if (type === "interrupt") {
      this.dispatchIntent(type);
      return;
    }
    if (type === "preview-image") {
      const image = this.stateFor().images.find(
        (candidate) => candidate.id === action.dataset.imageId,
      );
      if (image) {
        requestTaskImagePreview(this, {
          src: image.dataUrl,
          name: image.name,
        });
      }
      return;
    }
    if (type === "remove-image") {
      const state = this.stateFor();
      state.images = state.images.filter(
        (image) => image.id !== action.dataset.imageId,
      );
      state.imageError = "";
      this.render();
      return;
    }
  }

  handlePointerdown(event) {
    const action = closestElement(event.target, "[data-composer-action]");
    if (
      !action ||
      !this.contains(action) ||
      action.dataset.composerAction !== "voice" ||
      !this.voice.modelInstalled ||
      !["idle", "error"].includes(this.voice.phase)
    ) {
      return;
    }
    const textarea = this.querySelector("textarea[name='prompt']");
    if (!textarea) {
      return;
    }
    const state = this.stateFor();
    state.prompt = textarea.value;
    if (document.activeElement === textarea) {
      state.selectionStart = textarea.selectionStart;
      state.selectionEnd = textarea.selectionEnd;
    }
    this.voiceInsertion = {
      prompt: state.prompt,
      start: state.selectionStart,
      end: state.selectionEnd,
    };
  }

  async handleVoiceAction() {
    if (this.voice.phase === "recording") {
      await this.stopVoiceRecording();
      return;
    }
    if (!["idle", "error"].includes(this.voice.phase)) {
      return;
    }
    if (!this.voice.modelInstalled) {
      await this.installVoiceModel();
      return;
    }
    await this.startVoiceRecording();
  }

  async installVoiceModel() {
    const size = formatBytes(this.voice.modelBytes);
    const model = this.voice.modelId || "configured";
    if (
      !window.confirm(
        `Download the multilingual Whisper ${model} model (${size}) to this Caffold host?`,
      )
    ) {
      return;
    }
    const operationId = ++this.voiceOperationId;
    this.voice.phase = "downloading";
    this.voice.error = "";
    this.render();
    try {
      const response = await installVoiceModel();
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.applyVoiceStatus(response);
      this.voice.phase = "idle";
    } catch (error) {
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.voice.phase = "error";
      this.voice.error = `${error?.message ?? "Could not download the voice model."}`;
    }
    this.render();
  }

  async startVoiceRecording() {
    const state = this.stateFor();
    if (!this.voiceInsertion) {
      this.voiceInsertion = {
        prompt: state.prompt,
        start: state.selectionStart,
        end: state.selectionEnd,
      };
    }
    const operationId = ++this.voiceOperationId;
    this.voice.elapsedSeconds = 0;
    this.voice.recordingLimitReached = false;
    const recorder = new VoiceRecorder({
      maxSeconds: this.voice.maxRecordingSeconds,
      onElapsed: (elapsedSeconds) => {
        if (operationId !== this.voiceOperationId) {
          return;
        }
        this.updateVoiceElapsed(elapsedSeconds);
      },
      onLevel: (level) => {
        if (operationId !== this.voiceOperationId) {
          return;
        }
        this.updateVoiceLevel(level);
      },
      onLimit: () => {
        if (operationId === this.voiceOperationId) {
          void this.stopVoiceRecording();
        }
      },
    });
    this.voiceRecorder = recorder;
    this.voice.phase = "requesting";
    this.voice.error = "";
    this.render();
    try {
      await recorder.start();
      if (operationId !== this.voiceOperationId) {
        await recorder.cancel();
        return;
      }
      this.voice.phase = "recording";
      this.render();
    } catch (error) {
      if (operationId !== this.voiceOperationId) {
        return;
      }
      this.voiceRecorder = null;
      this.voice.phase = "error";
      this.voice.error = voiceCaptureError(error);
      this.render();
    }
  }

  updateVoiceElapsed(elapsedSeconds) {
    this.voice.elapsedSeconds = elapsedSeconds;
    this.voice.recordingLimitReached =
      elapsedSeconds >= this.voice.maxRecordingSeconds;
    const timer = this.querySelector(".task-voice-elapsed");
    if (!timer) {
      return;
    }
    const duration = formatRecordingDuration(elapsedSeconds);
    timer.textContent = duration;
    timer.setAttribute("aria-label", `Recording duration ${duration}`);
    timer.classList.toggle("is-limit", this.voice.recordingLimitReached);
  }

  updateVoiceLevel(level) {
    this.querySelector("caffold-voice-level-meter")?.setLevel(level);
  }

  async stopVoiceRecording({ submitAfterTranscription = false } = {}) {
    if (this.voice.phase !== "recording" || !this.voiceRecorder) {
      return;
    }
    const operationId = this.voiceOperationId;
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    this.voice.phase = "transcribing";
    this.render();
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
      const transcript = `${response?.text ?? ""}`.trim();
      if (!transcript) {
        throw new Error("No speech was detected in the recording.");
      }
      this.insertVoiceTranscript(transcript);
      this.voice.phase = "idle";
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
      this.voice.phase = "error";
      this.voice.error = `${error?.message ?? "Could not transcribe the recording."}`;
      this.voice.elapsedSeconds = 0;
      this.voice.recordingLimitReached = false;
    }
    this.render();
    if (shouldSubmit) {
      const send = this.querySelector(".task-primary-action-button");
      send?.form?.requestSubmit(send);
    }
  }

  async cancelVoiceInput() {
    this.voiceOperationId += 1;
    this.voiceRequest?.abort();
    this.voiceRequest = null;
    const recorder = this.voiceRecorder;
    this.voiceRecorder = null;
    await recorder?.cancel();
    this.voice.phase = "idle";
    this.voice.error = "";
    this.voice.elapsedSeconds = 0;
    this.voice.recordingLimitReached = false;
    this.voiceInsertion = null;
    this.render();
  }

  insertVoiceTranscript(transcript) {
    const state = this.stateFor();
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

  async handlePaste(event) {
    const textarea = closestElement(event.target, "textarea[name='prompt']");
    if (
      !textarea ||
      (this.context.mode === "create" && this.activeSubmissionFor())
    ) {
      return;
    }
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    const state = this.stateFor();
    const availableSlots = MAX_IMAGES - state.images.length;
    if (availableSlots <= 0) {
      state.imageError = `Attach up to ${MAX_IMAGES} images.`;
      this.render();
      return;
    }
    const accepted = [];
    let error =
      files.length > availableSlots ? `Attach up to ${MAX_IMAGES} images.` : "";
    for (const [index, file] of files.slice(0, availableSlots).entries()) {
      if (!IMAGE_TYPES.has(file.type)) {
        error = "Use PNG, JPEG, GIF, WebP, or AVIF images.";
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        error = "Each image must be 10 MB or smaller.";
        continue;
      }
      try {
        accepted.push({
          id: `clipboard:${Date.now()}:${index}:${Math.random().toString(36).slice(2)}`,
          name:
            file.name ||
            `clipboard-image-${state.images.length + accepted.length + 1}.${imageExtension(file.type)}`,
          type: file.type,
          size: file.size,
          dataUrl: await readFileAsDataUrl(file),
        });
      } catch {
        error = "Could not read the pasted image.";
      }
    }
    state.images = [...state.images, ...accepted];
    state.imageError = error;
    this.render();
  }

  handleSubmit(event) {
    const form = closestElement(event.target, "form[data-task-form]");
    if (!form || !this.contains(form)) {
      return;
    }
    event.preventDefault();
    if (this.voice.phase === "recording") {
      if (
        !this.activeSubmissionFor() &&
        !this.context.disabled &&
        event.submitter?.classList.contains("task-primary-action-button")
      ) {
        void this.stopVoiceRecording({ submitAfterTranscription: true });
      }
      return;
    }
    if (
      this.activeSubmissionFor() ||
      this.context.disabled ||
      ["requesting", "recording", "transcribing"].includes(this.voice.phase)
    ) {
      return;
    }
    this.captureCurrentState();
    const state = this.stateFor();
    const prompt = state.prompt.trim();
    if (!prompt && !state.images.length) {
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
    const submission = {
      id: submissionId,
      prompt,
      images: [...state.images],
      options: { ...options },
      restorePromptFocus:
        !event.submitter &&
        document.activeElement ===
          form.querySelector("textarea[name='prompt']"),
    };
    this.activeSubmissions.set(submissionId, submission);
    state.activeSubmissionId = submissionId;
    state.prompt = "";
    state.images = [];
    state.imageError = "";
    this.context.requestError = "";
    this.turnOptions()?.hidePopovers();
    this.render();
    this.dispatchEvent(
      new CustomEvent("caffold:task-composer-submit", {
        bubbles: true,
        composed: true,
        detail: {
          submissionId,
          threadId: `${this.context.threadId ?? ""}`,
          prompt,
          images: submission.images.map((image) => image.dataUrl),
          attachments: [...submission.images],
          options,
        },
      }),
    );
  }

  dispatchIntent(type) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-composer-intent", {
        bubbles: true,
        composed: true,
        detail: { type },
      }),
    );
  }

  render() {
    this.ensureState();
    // Keep the textarea and turn-options nodes mounted. The former owns IME
    // composition; the latter owns native popover and request state.
    if (this.compositionActive) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    this.ensureRendered();
    const state = this.stateFor();
    const submitting = Boolean(this.activeSubmissionFor());
    const voiceBusy = ["requesting", "recording", "transcribing"].includes(
      this.voice.phase,
    );
    const interrupting = Boolean(this.context.interrupting);
    const creating = submitting && this.context.mode === "create";
    const fieldDisabled = this.context.disabled || voiceBusy || creating;
    const requestLocked =
      submitting || this.context.disabled || voiceBusy || interrupting;
    const settingsLocked = requestLocked || this.context.settingsLocked;
    const primaryAction = this.primaryActionView();
    const form = this.querySelector(":scope > form[data-task-form]");
    form.className = `task-composer ${this.context.className ?? ""}`.trim();
    form.dataset.taskForm = this.context.mode;
    form.dataset.voiceState = this.voice.phase;
    form.setAttribute(
      "aria-busy",
      submitting || voiceBusy || interrupting ? "true" : "false",
    );
    setOptionalAttribute(form, "data-thread-id", this.context.threadId);

    this.setRegion(
      "context",
      this.context.mode === "create"
        ? `<div class="task-composer-context">
            ${renderInlineIcon("Folder", "Working directory", "task-composer-context-icon")}
            <span title="${escapeHtml(this.context.cwd)}">${escapeHtml(this.context.cwd)}</span>
            ${this.context.browseCwd
              ? '<button type="button" data-composer-action="browse-cwd">Browse Files</button>'
              : ""}
          </div>`
        : "",
    );
    this.setRegion("images", renderImages(state.images));

    const textarea = this.querySelector("textarea[name='prompt']");
    const textareaFocused = document.activeElement === textarea;
    const focus = textareaFocused
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : null;
    if (textarea.value !== state.prompt) {
      textarea.value = state.prompt;
    }
    textarea.disabled = fieldDisabled;
    textarea.placeholder = this.context.placeholder;
    textarea.setAttribute("aria-label", this.context.ariaLabel);
    if (focus) {
      textarea.setSelectionRange(focus.start, focus.end);
    }

    this.setRegion(
      "create-status",
      creating
        ? '<p class="task-composer-create-status" role="status">Starting the task...</p>'
        : "",
    );
    this.setRegion("voice-status", this.renderVoiceStatus());
    this.setRegion(
      "interrupt-error",
      this.context.interruptError
        ? `<p class="task-composer-interrupt-error" role="alert">${escapeHtml(this.context.interruptError)}</p>`
        : "",
    );
    this.setRegion(
      "image-error",
      state.imageError
        ? `<p class="task-composer-image-error" role="alert">${escapeHtml(state.imageError)}</p>`
        : "",
    );
    this.setRegion(
      "request-error",
      this.context.requestError
        ? `<p class="task-composer-request-error" role="alert">${escapeHtml(this.context.requestError)}</p>`
        : "",
    );
    this.setRegion(
      "cancel",
      this.context.cancel
        ? `<button type="button" class="task-toolbar-button" data-composer-action="cancel">Cancel</button>`
        : "",
    );
    this.syncTurnOptionsContext(settingsLocked);
    this.syncTurnOptionsFields();
    this.querySelector(".task-composer-actions").innerHTML = `
      ${this.renderVoiceControls(submitting)}
      <button
        type="${primaryAction.kind === "send" ? "submit" : "button"}"
        class="task-primary-action-button"
        data-primary-action="${primaryAction.kind}"
        data-primary-action-icon="${primaryAction.icon}"
        ${primaryAction.kind === "stop" ? 'data-composer-action="interrupt"' : ""}
        aria-label="${escapeHtml(primaryAction.label)}"
        title="${escapeHtml(primaryAction.title)}"
        ${primaryAction.disabled ? "disabled" : ""}
      >
        ${renderInlineIcon(primaryAction.icon, primaryAction.label, "task-primary-action-icon")}
      </button>
    `;
    this.notifyLayoutChange();
  }

  ensureRendered() {
    if (this.querySelector(":scope > form[data-task-form]")) {
      return;
    }
    this.innerHTML = `
      <form class="task-composer" data-task-form="create">
        <div class="task-composer-panel">
          <div class="task-composer-render-region" data-composer-region="context"></div>
          <div class="task-composer-render-region" data-composer-region="images"></div>
          <textarea name="prompt" rows="1"></textarea>
          <div class="task-composer-render-region" data-composer-region="create-status"></div>
          <div class="task-composer-render-region" data-composer-region="voice-status"></div>
          <div class="task-composer-render-region" data-composer-region="interrupt-error"></div>
          <div class="task-composer-render-region" data-composer-region="image-error"></div>
          <div class="task-composer-render-region" data-composer-region="request-error"></div>
          <input type="hidden" name="model">
          <input type="hidden" name="effort">
          <input type="hidden" name="fastMode">
          <input type="hidden" name="permissionMode">
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              <div class="task-composer-render-region" data-composer-region="cancel"></div>
              <caffold-task-turn-options></caffold-task-turn-options>
            </div>
            <div class="task-composer-actions"></div>
          </div>
        </div>
      </form>
    `;
  }

  setRegion(name, html) {
    const region = this.querySelector(`[data-composer-region="${name}"]`);
    if (region && region.innerHTML !== html) {
      region.innerHTML = html;
    }
  }

  turnOptions() {
    return this.querySelector(":scope caffold-task-turn-options");
  }

  turnOptionsContext(locked = null) {
    return {
      cwd: this.context.cwd,
      // A follow-up belongs to a Task that already has an agent; a new Task
      // does not, and every agent's models are on offer.
      provider: `${this.context.provider ?? ""}`,
      initialSelection: {
        model: `${this.context.model ?? ""}`,
        effort: `${this.context.effort ?? ""}`,
        fastMode: Boolean(this.context.fastMode),
        permissionMode: `${this.context.permissionMode ?? ""}`,
      },
      locked:
        locked === null
          ? Boolean(this.context.disabled || this.context.settingsLocked)
          : Boolean(locked),
      placement: this.context.mode === "follow-up" ? "above" : "below",
    };
  }

  syncTurnOptionsContext(locked = null) {
    const turnOptions = this.turnOptions();
    if (!turnOptions) {
      return;
    }
    turnOptions.setContext(this.turnOptionsContext(locked));
  }

  resetTurnOptions() {
    const turnOptions = this.turnOptions();
    if (!turnOptions) {
      return;
    }
    turnOptions.reset(this.turnOptionsContext());
    this.syncTurnOptionsFields();
  }

  syncTurnOptionsFields() {
    const snapshot = this.turnOptions()?.snapshot();
    if (!snapshot) {
      return;
    }
    this.querySelector('input[name="model"]').value = snapshot.model;
    this.querySelector('input[name="effort"]').value = snapshot.effort;
    this.querySelector('input[name="fastMode"]').value = snapshot.fastMode
      ? "true"
      : "false";
    this.querySelector('input[name="permissionMode"]').value =
      snapshot.permissionMode;
  }

  renderVoiceControls(submitting) {
    const phase = this.voice.phase;
    const recording = phase === "recording";
    const showElapsed =
      recording ||
      (phase === "transcribing" && this.voice.recordingLimitReached);
    const cancellable = ["requesting", "recording", "transcribing"].includes(
      phase,
    );
    const disabled =
      submitting ||
      this.context.disabled ||
      this.context.interrupting ||
      ["checking", "requesting", "downloading", "transcribing", "unavailable"].includes(
        phase,
      );
    const label = voiceActionLabel(phase, this.voice.modelInstalled);
    const icon = recording
      ? "Square"
      : ["checking", "downloading", "requesting", "transcribing"].includes(phase)
          ? "LoaderCircle"
          : "Mic";
    return `
      ${recording ? "<caffold-voice-level-meter></caffold-voice-level-meter>" : ""}
      ${
        showElapsed
          ? `<span
              class="task-voice-elapsed ${this.voice.recordingLimitReached ? "is-limit" : ""}"
              role="timer"
              aria-label="Recording duration ${escapeHtml(formatRecordingDuration(this.voice.elapsedSeconds))}"
            >${escapeHtml(formatRecordingDuration(this.voice.elapsedSeconds))}</span>`
          : ""
      }
      ${
        cancellable
          ? `<button
              type="button"
              class="task-voice-cancel-button"
              data-composer-action="cancel-voice"
              aria-label="Cancel voice input"
              title="Cancel voice input"
            >${renderInlineIcon("X", "Cancel voice input", "task-voice-cancel-icon")}</button>`
          : ""
      }
      <button
        type="button"
        class="task-voice-button ${recording ? "is-recording" : ""} ${["checking", "requesting", "downloading", "transcribing"].includes(phase) ? "is-busy" : ""}"
        data-composer-action="voice"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
        ${disabled && !recording ? "disabled" : ""}
      >
        ${renderInlineIcon(icon, label, "task-voice-icon")}
      </button>
    `;
  }

  renderVoiceStatus() {
    const message = voiceStatusMessage(this.voice);
    if (!message) {
      return "";
    }
    const alert = ["error", "unavailable"].includes(this.voice.phase);
    return `<p class="task-composer-voice-status ${alert ? "is-error" : ""}" role="${alert ? "alert" : "status"}">${escapeHtml(message)}</p>`;
  }

  notifyLayoutChange() {
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

}

const COMPOSER_KEYBOARD_CONTEXT_MODES = new Set(["create", "follow-up"]);

function renderImages(images) {
  if (!images.length) {
    return "";
  }
  return `
    <div class="task-composer-attachments" aria-label="Images to send">
      ${images
        .map(
          (image) => `
            <figure class="task-composer-attachment" title="${escapeHtml(image.name)}">
              <button
                type="button"
                class="task-composer-attachment-preview"
                data-composer-action="preview-image"
                data-image-id="${escapeHtml(image.id)}"
                aria-label="Preview ${escapeHtml(image.name)}"
                title="Preview image"
              ><img src="${escapeHtml(image.dataUrl)}" alt=""></button>
              <button
                type="button"
                class="task-composer-attachment-remove"
                data-composer-action="remove-image"
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

function voiceActionLabel(phase, modelInstalled) {
  if (phase === "recording") {
    return "Stop recording";
  }
  if (phase === "downloading") {
    return "Downloading voice model";
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
  return modelInstalled ? "Start voice input" : "Set up voice input";
}

function voiceStatusMessage(voice) {
  if (voice.phase === "downloading") {
    const model = voice.modelId ? `Whisper ${voice.modelId}` : "Whisper";
    return `Downloading the ${model} model to this Caffold host...`;
  }
  if (["error", "unavailable"].includes(voice.phase)) {
    return voice.error || "Voice input is unavailable.";
  }
  return "";
}

function voiceCaptureError(error) {
  if (error?.name === "NotAllowedError") {
    return "Microphone access was denied. Allow it in the browser settings and try again.";
  }
  if (error?.name === "NotFoundError") {
    return "No microphone was found on this device.";
  }
  if (error?.name === "NotReadableError") {
    return "The microphone is busy or unavailable.";
  }
  return `${error?.message ?? "Could not start microphone capture."}`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown size";
  }
  if (value < 1024 * 1024 * 1024) {
    return `${Math.round(value / (1024 * 1024))} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
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

function imageExtension(type) {
  return {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[type] ?? "png";
}

function shallowEqual(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]),
    )
  );
}

function setOptionalAttribute(element, name, value) {
  const text = `${value ?? ""}`.trim();
  if (text) {
    element.setAttribute(name, text);
  } else {
    element.removeAttribute(name);
  }
}

function submissionDetail(submission, threadId = "") {
  return {
    submissionId: submission.id,
    threadId: `${threadId ?? ""}`,
    prompt: submission.prompt,
    images: submission.images.map((image) => image.dataUrl),
    attachments: [...submission.images],
    options: { ...(submission.options ?? {}) },
    restorePromptFocus: Boolean(submission.restorePromptFocus),
  };
}

function normalizeAdoptedSubmission(value) {
  const id = `${value?.submissionId ?? value?.id ?? ""}`.trim();
  const prompt = `${value?.prompt ?? ""}`.trim();
  const providedAttachments = Array.isArray(value?.attachments)
    ? value.attachments
    : [];
  const attachments = providedAttachments.length
    ? providedAttachments.map((image) => ({ ...image }))
    : (Array.isArray(value?.images) ? value.images : []).map(
        (dataUrl, index) => ({
          id: `adopted:${id}:${index}`,
          name: `image-${index + 1}`,
          type: `${dataUrl}`.match(/^data:([^;,]+)/)?.[1] ?? "image/png",
          size: 0,
          dataUrl: `${dataUrl}`,
        }),
      );
  if (!id || (!prompt && !attachments.length)) {
    return null;
  }
  return {
    id,
    prompt,
    images: attachments,
    options: { ...(value?.options ?? {}) },
    restorePromptFocus: Boolean(value?.restorePromptFocus),
  };
}

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

if (!customElements.get("caffold-task-composer")) {
  customElements.define("caffold-task-composer", CaffoldTaskComposer);
}
