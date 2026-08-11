import {
  getCodexModels,
  getCodexPermissions,
  getVoiceStatus,
  installVoiceModel,
  transcribeVoice,
} from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { cleanLogicalPath } from "../task-format.js";
import { requestTaskImagePreview } from "./image-preview-dialog.js";
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
    model: "",
    effort: "",
    fastMode: false,
    modelExplicit: false,
    fastModeExplicit: false,
    permissionMode: "",
    permissionExplicit: false,
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
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    document.addEventListener("click", this.boundDocumentClick);
    this.render();
    void this.loadModels();
    void this.loadPermissions(this.context.cwd);
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
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    document.removeEventListener("click", this.boundDocumentClick);
    this.modelRequestId += 1;
    this.permissionRequestId += 1;
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
    this.modelLoading = false;
    this.permissionLoading = false;
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.context = {
      mode: "create",
      cwd: ".",
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
    this.modelOptions = [];
    this.modelLoading = false;
    this.modelLoaded = false;
    this.modelError = null;
    this.modelRequestId = 0;
    this.permissionOptions = [];
    this.permissionCwd = "";
    this.permissionLoading = false;
    this.permissionLoaded = false;
    this.permissionError = null;
    this.permissionRequestId = 0;
    this.defaultPermissionMode = "askForApproval";
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
    this.openPicker = "";
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
    this.boundDocumentClick = (event) => {
      if (!this.openPicker || this.contains(event.target)) {
        return;
      }
      this.openPicker = "";
      this.render();
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
    const state = this.stateFor();
    let stateChanged = false;
    if (
      context.model &&
      !state.modelExplicit &&
      state.model !== `${context.model}`
    ) {
      state.model = `${context.model}`;
      stateChanged = true;
    }
    if (
      context.effort &&
      !state.modelExplicit &&
      state.effort !== `${context.effort}`
    ) {
      state.effort = `${context.effort}`;
      stateChanged = true;
    }
    if (
      Object.hasOwn(context, "fastMode") &&
      !state.fastModeExplicit &&
      state.fastMode !== Boolean(context.fastMode)
    ) {
      state.fastMode = Boolean(context.fastMode);
      stateChanged = true;
    }
    if (
      context.permissionMode &&
      !state.permissionExplicit &&
      state.permissionMode !== `${context.permissionMode}`
    ) {
      state.permissionMode = `${context.permissionMode}`;
      stateChanged = true;
    }
    let pickerChanged = false;
    if (this.context.disabled || this.context.settingsLocked) {
      pickerChanged = Boolean(this.openPicker);
      this.openPicker = "";
    }
    if (!contextChanged && !stateChanged && !pickerChanged) {
      return false;
    }
    this.setAttribute("data-composer-mode", this.context.mode);
    this.render();
    if (this.isConnected) {
      void this.loadModels();
      void this.loadPermissions(this.context.cwd);
    }
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
      state.modelExplicit = false;
      state.fastModeExplicit = false;
      state.permissionExplicit = false;
    }
    if (result.resetFastMode) {
      state.fastMode = false;
      state.fastModeExplicit = false;
    }
    this.context.requestError = `${result.error?.message ?? result.error ?? ""}`;
    this.render();
    if (submission.restorePromptFocus) {
      this.focus();
    }
    return true;
  }

  resetOverrides() {
    const state = this.stateFor();
    state.modelExplicit = false;
    state.fastModeExplicit = false;
    state.permissionExplicit = false;
  }

  hasRestorableState() {
    this.captureCurrentState();
    const state = this.stateFor();
    return Boolean(
      state.prompt.trim() ||
        state.images.length ||
        state.imageError ||
        state.modelExplicit ||
        state.fastModeExplicit ||
        state.permissionExplicit ||
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

  async loadModels() {
    if (this.modelLoaded || this.modelLoading) {
      return;
    }
    const requestId = ++this.modelRequestId;
    this.modelLoading = true;
    this.modelError = null;
    this.render();
    try {
      const response = await getCodexModels();
      if (requestId !== this.modelRequestId) {
        return;
      }
      this.modelOptions = normalizeModelOptions(response);
      this.modelLoaded = true;
      this.applyDefaultModelSelection();
    } catch (error) {
      if (requestId !== this.modelRequestId) {
        return;
      }
      this.modelError = error;
      this.modelLoaded = true;
    } finally {
      if (requestId === this.modelRequestId) {
        this.modelLoading = false;
        this.render();
      }
    }
  }

  async loadPermissions(cwd) {
    const targetCwd = cleanLogicalPath(cwd || ".");
    if (
      this.permissionCwd === targetCwd &&
      (this.permissionLoaded || this.permissionLoading)
    ) {
      return;
    }
    const requestId = ++this.permissionRequestId;
    this.permissionCwd = targetCwd;
    this.permissionLoading = true;
    this.permissionLoaded = false;
    this.permissionError = null;
    this.render();
    try {
      const response = await getCodexPermissions(targetCwd);
      if (
        requestId !== this.permissionRequestId ||
        targetCwd !== this.permissionCwd
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
      const state = this.stateFor();
      const selected = this.permissionOptions.find(
        (option) => option.mode === state.permissionMode,
      );
      const canonicalMode =
        this.context.mode === "follow-up" && !state.permissionExplicit
          ? `${this.context.permissionMode ?? ""}`.trim()
          : "";
      if (canonicalMode) {
        state.permissionMode = canonicalMode;
      } else if (!state.permissionExplicit || !selected?.allowed) {
        state.permissionMode = this.defaultPermissionMode;
        state.permissionExplicit = false;
      }
      this.permissionLoaded = true;
    } catch (error) {
      if (requestId !== this.permissionRequestId) {
        return;
      }
      this.permissionOptions = [];
      this.permissionError = error;
      this.permissionLoaded = true;
      this.defaultPermissionMode = "askForApproval";
      this.stateFor().permissionMode ||= this.defaultPermissionMode;
    } finally {
      if (requestId === this.permissionRequestId) {
        this.permissionLoading = false;
        this.render();
      }
    }
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

  applyDefaultModelSelection() {
    if (!this.modelOptions.length) {
      return;
    }
    const state = this.stateFor();
    const model =
      this.modelOptions.find((option) => option.model === state.model) ??
      this.modelOptions.find((option) => option.isDefault) ??
      this.modelOptions[0];
    state.model ||= model.model;
    state.effort ||=
      model.defaultReasoningEffort ||
      model.supportedReasoningEfforts[0]?.value ||
      "";
    if (!model.supportsFast) {
      state.fastMode = false;
    }
  }

  selectedModel() {
    const selectedModel = this.stateFor().model;
    return (
      this.modelOptions.find((option) => option.model === selectedModel) ??
      this.modelOptions.find((option) => option.isDefault) ??
      this.modelOptions[0] ??
      null
    );
  }

  selectedEffort() {
    const state = this.stateFor();
    const model = this.selectedModel();
    const supported = model?.supportedReasoningEfforts ?? [];
    return (
      supported.find((option) => option.value === state.effort)?.value ||
      model?.defaultReasoningEffort ||
      supported[0]?.value ||
      ""
    );
  }

  selectedFastMode() {
    return Boolean(this.stateFor().fastMode && this.selectedModel()?.supportsFast);
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
    if (type === "toggle-model") {
      if (!this.context.settingsLocked) {
        this.openPicker = this.openPicker === "model" ? "" : "model";
        this.render();
        void this.loadModels();
      }
      return;
    }
    if (type === "close-model" || type === "close-permission") {
      this.openPicker = "";
      this.render();
      return;
    }
    if (type === "select-model") {
      this.selectModel(action.dataset.model);
      return;
    }
    if (type === "select-effort") {
      this.selectEffort(action.dataset.effort);
      return;
    }
    if (type === "select-fast-mode") {
      this.selectFastMode(action.dataset.fastMode === "true");
      return;
    }
    if (type === "toggle-permission") {
      if (!this.context.settingsLocked) {
        this.openPicker = this.openPicker === "permission" ? "" : "permission";
        this.render();
        void this.loadPermissions(this.context.cwd);
      }
      return;
    }
    if (type === "select-permission") {
      this.selectPermission(action.dataset.permissionMode);
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

  selectModel(modelValue) {
    if (this.context.settingsLocked) {
      return;
    }
    const state = this.stateFor();
    state.model = `${modelValue ?? ""}`;
    state.modelExplicit = true;
    const model = this.selectedModel();
    const supported = model?.supportedReasoningEfforts ?? [];
    if (!supported.some((option) => option.value === state.effort)) {
      state.effort = model?.defaultReasoningEffort ?? supported[0]?.value ?? "";
    }
    if (!model?.supportsFast) {
      state.fastMode = false;
      state.fastModeExplicit = true;
    }
    this.openPicker = "";
    this.render();
  }

  selectEffort(effort) {
    if (this.context.settingsLocked) {
      return;
    }
    const state = this.stateFor();
    state.effort = `${effort ?? ""}`;
    state.modelExplicit = true;
    this.openPicker = "";
    this.render();
  }

  selectFastMode(fastMode) {
    if (this.context.settingsLocked) {
      return;
    }
    const state = this.stateFor();
    state.fastMode = Boolean(fastMode && this.selectedModel()?.supportsFast);
    state.fastModeExplicit = true;
    this.openPicker = "";
    this.render();
  }

  selectPermission(permissionMode) {
    if (this.context.settingsLocked) {
      return;
    }
    const option = this.permissionOptions.find(
      (candidate) => candidate.mode === permissionMode,
    );
    if (!option?.allowed) {
      return;
    }
    const state = this.stateFor();
    if (
      option.dangerous &&
      state.permissionMode !== permissionMode &&
      !window.confirm(
        "Full access removes sandbox restrictions and approval prompts for subsequent turns. Continue?",
      )
    ) {
      return;
    }
    state.permissionMode = permissionMode;
    state.permissionExplicit = true;
    this.openPicker = "";
    this.render();
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
    const options = {};
    const model = this.selectedModel();
    if (model?.model) {
      options.model = model.model;
    }
    const effort = this.selectedEffort();
    if (effort) {
      options.effort = effort;
    }
    options.fastMode = this.selectedFastMode();
    if (state.permissionExplicit) {
      options.permissionMode =
        state.permissionMode || this.defaultPermissionMode;
    }
    const submission = {
      id: submissionId,
      prompt,
      images: [...state.images],
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
    this.openPicker = "";
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
    // IME composition belongs to the current textarea node. Replacing it here
    // would commit or split the in-progress text before compositionend.
    if (this.compositionActive) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    const previousFocus = this.captureFocus();
    const state = this.stateFor();
    const model = this.selectedModel();
    const effort = this.selectedEffort();
    const fastMode = this.selectedFastMode();
    const submitting = Boolean(this.activeSubmissionFor());
    const voiceBusy = ["requesting", "recording", "transcribing"].includes(
      this.voice.phase,
    );
    const interrupting = Boolean(this.context.interrupting);
    const fieldDisabled =
      this.context.disabled ||
      voiceBusy ||
      (submitting && this.context.mode === "create");
    const requestLocked =
      submitting || this.context.disabled || voiceBusy || interrupting;
    const settingsLocked = requestLocked || this.context.settingsLocked;
    const primaryAction = this.primaryActionView();
    const permissionMode =
      state.permissionMode || this.defaultPermissionMode;
    const permission = this.permissionOptions.find(
      (option) => option.mode === permissionMode,
    );
    this.innerHTML = `
      <form
        class="task-composer ${escapeHtml(this.context.className ?? "")}"
        data-task-form="${escapeHtml(this.context.mode)}"
        data-voice-state="${escapeHtml(this.voice.phase)}"
        ${this.context.threadId ? `data-thread-id="${escapeHtml(this.context.threadId)}"` : ""}
        aria-busy="${submitting || voiceBusy || interrupting ? "true" : "false"}"
      >
        <div class="task-composer-panel">
          ${
            this.context.mode === "create"
              ? `<div class="task-composer-context">
                  ${renderInlineIcon("Folder", "Working directory", "task-composer-context-icon")}
                  <span title="${escapeHtml(this.context.cwd)}">${escapeHtml(this.context.cwd)}</span>
                  <button type="button" data-composer-action="browse-cwd">Browse Files</button>
                </div>`
              : ""
          }
          ${renderImages(state.images)}
          <textarea
            name="prompt"
            rows="1"
            aria-label="${escapeHtml(this.context.ariaLabel)}"
            placeholder="${escapeHtml(this.context.placeholder)}"
            ${fieldDisabled ? "disabled" : ""}
          >${escapeHtml(state.prompt)}</textarea>
          ${this.renderVoiceStatus()}
          ${
            this.context.interruptError
              ? `<p class="task-composer-interrupt-error" role="alert">${escapeHtml(this.context.interruptError)}</p>`
              : ""
          }
          ${
            state.imageError
              ? `<p class="task-composer-image-error" role="alert">${escapeHtml(state.imageError)}</p>`
              : ""
          }
          ${
            this.context.requestError
              ? `<p class="task-composer-request-error" role="alert">${escapeHtml(this.context.requestError)}</p>`
              : ""
          }
          <input type="hidden" name="model" value="${escapeHtml(model?.model ?? "")}">
          <input type="hidden" name="effort" value="${escapeHtml(effort)}">
          <input type="hidden" name="fastMode" value="${fastMode ? "true" : "false"}">
          <input type="hidden" name="permissionMode" value="${escapeHtml(permissionMode)}">
          <div class="task-composer-toolbar">
            <div class="task-composer-tools">
              ${
                this.context.cancel
                  ? `<button type="button" class="task-toolbar-button" data-composer-action="cancel">Cancel</button>`
                  : ""
              }
              ${this.renderModelPicker(model, effort, fastMode, settingsLocked)}
              ${this.renderPermissionPicker(permission, permissionMode, settingsLocked)}
            </div>
            <div class="task-composer-actions">
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
            </div>
          </div>
        </div>
      </form>
    `;
    this.restoreFocus(previousFocus);
    this.notifyLayoutChange();
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

  renderModelPicker(model, effort, fastMode, disabled) {
    const reasoningOptions = model?.supportedReasoningEfforts ?? [];
    const modelLabel =
      model?.displayName ?? (this.modelLoading ? "Loading model" : "Model");
    const effortValue = effort || "Reasoning";
    const summaryLabel = `${modelLabel} · ${effortValue}${fastMode ? " · Fast" : ""}`;
    const compactModel = compactModelLabel(modelLabel);
    const supportsFast = Boolean(model?.supportsFast);
    const pickerLabel = supportsFast
      ? "Choose model, reasoning, and speed"
      : "Choose model and reasoning";
    const open = !disabled && this.openPicker === "model";
    return `
      <div class="task-model-picker${open ? " is-open" : ""}">
        <button
          type="button"
          class="task-model-button${fastMode ? " is-fast" : ""}"
          data-composer-action="toggle-model"
          aria-expanded="${open ? "true" : "false"}"
          aria-label="${pickerLabel}"
          title="${escapeHtml(disabled ? "Model, reasoning, and speed can be changed after the active turn finishes." : summaryLabel)}"
          ${disabled ? "disabled" : ""}
        >
          <span class="task-model-name">${escapeHtml(compactModel)}</span>
          <span class="task-model-effort"> · ${escapeHtml(effortValue)}</span>
          ${
            fastMode
              ? `<span class="task-model-fast" title="Fast mode">${renderInlineIcon("Zap", "Fast mode", "task-model-fast-icon")}</span>`
              : ""
          }
        </button>
        ${
          open
            ? `<button type="button" class="task-model-backdrop" data-composer-action="close-model" aria-label="Close model picker"></button>
              <div class="task-model-popover" role="menu" aria-label="${supportsFast ? "Model, reasoning, and speed options" : "Model and reasoning options"}">
                <section>
                  <p>Model</p>
                  ${
                    this.modelOptions.length
                      ? this.modelOptions
                          .map((option) =>
                            renderModelOption(option, model?.model ?? ""),
                          )
                          .join("")
                    : renderModelFallback(this.modelLoading, this.modelError)
                  }
                </section>
                <hr>
                <section>
                  <p>Reasoning level</p>
                  ${reasoningOptions
                    .map((option) => renderReasoningOption(option, effort))
                    .join("")}
                </section>
                ${
                  supportsFast
                    ? `<hr>
                      <section>
                        <p>Speed</p>
                        ${renderFastModeOption(false, fastMode)}
                        ${renderFastModeOption(true, fastMode)}
                      </section>`
                    : ""
                }
              </div>`
            : ""
        }
      </div>
    `;
  }

  renderPermissionPicker(permission, permissionMode, disabled) {
    const label =
      permission?.label ??
      (this.permissionLoading
        ? "Loading permissions"
        : this.permissionError
          ? "Codex default"
          : permissionModeLabel(permissionMode));
    const compactLabel = permission
      ? compactPermissionModeLabel(permissionMode)
      : this.permissionLoading
        ? "Loading"
        : this.permissionError
          ? "Codex default"
          : compactPermissionModeLabel(permissionMode);
    const open = !disabled && this.openPicker === "permission";
    return `
      <div class="task-permission-picker${open ? " is-open" : ""}">
        <button
          type="button"
          class="task-permission-button${permission?.dangerous ? " is-dangerous" : ""}"
          data-composer-action="toggle-permission"
          aria-expanded="${open ? "true" : "false"}"
          aria-label="Choose approval mode"
          title="${escapeHtml(disabled ? "Approval mode can be changed after the active turn finishes." : label)}"
          ${disabled ? "disabled" : ""}
        >
          <span>${escapeHtml(compactLabel)}</span>
        </button>
        ${
          open
            ? `<button type="button" class="task-permission-backdrop" data-composer-action="close-permission" aria-label="Close approval mode picker"></button>
              <div class="task-permission-popover" role="menu" aria-label="Approval modes">
                <p class="task-permission-heading">Permissions</p>
                ${
                  this.permissionOptions.length
                    ? this.permissionOptions
                        .map((option) =>
                          renderPermissionOption(option, permissionMode),
                        )
                        .join("")
                    : renderPermissionFallback(
                        this.permissionLoading,
                        this.permissionError,
                      )
                }
              </div>`
            : ""
        }
      </div>
    `;
  }

  captureFocus() {
    const textarea = this.querySelector("textarea[name='prompt']");
    if (!textarea || document.activeElement !== textarea) {
      return null;
    }
    return {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  }

  restoreFocus(focus) {
    if (!focus) {
      return;
    }
    const textarea = this.querySelector("textarea[name='prompt']");
    textarea?.focus();
    textarea?.setSelectionRange(focus.start, focus.end);
  }

}

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
        isDefault: Boolean(model?.isDefault),
        defaultReasoningEffort: `${model?.defaultReasoningEffort ?? ""}`.trim(),
        supportedReasoningEfforts: normalizeReasoningOptions(
          model?.supportedReasoningEfforts,
        ),
        supportsFast: normalizeServiceTiers(model?.serviceTiers).some(
          (tier) => tier.name.toLowerCase() === "fast",
        ),
      };
    })
    .filter(Boolean);
}

function normalizeServiceTiers(tiers) {
  if (!Array.isArray(tiers)) {
    return [];
  }
  return tiers
    .map((tier) => ({
      id: `${tier?.id ?? ""}`.trim(),
      name: `${tier?.name ?? ""}`.trim(),
    }))
    .filter((tier) => tier.id && tier.name);
}

function compactModelLabel(label) {
  return `${label ?? ""}`
    .trim()
    .replace(/^GPT(?:-|\s)+/i, "")
    .replaceAll("-", " ");
}

function normalizeReasoningOptions(options) {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .map((option) => {
      const fallbackValue = typeof option === "string" ? option : "";
      const value = `${
        option?.value ?? option?.reasoningEffort ?? fallbackValue
      }`.trim();
      if (!value) {
        return null;
      }
      return {
        value,
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

function renderModelOption(option, selectedModel) {
  const selected = option.model === selectedModel;
  return `
    <button
      type="button"
      class="task-model-option"
      data-composer-action="select-model"
      data-model="${escapeHtml(option.model)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.displayName)}</strong>
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderReasoningOption(option, selectedEffort) {
  const selected = option.value === selectedEffort;
  return `
    <button
      type="button"
      class="task-model-option"
      data-composer-action="select-effort"
      data-effort="${escapeHtml(option.value)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${escapeHtml(option.value)}</strong>
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderFastModeOption(fastMode, selectedFastMode) {
  const selected = fastMode === selectedFastMode;
  const label = fastMode ? "Fast" : "Normal";
  return `
    <button
      type="button"
      class="task-model-option"
      data-composer-action="select-fast-mode"
      data-fast-mode="${fastMode ? "true" : "false"}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span>
        <strong>${label}</strong>
      </span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderPermissionOption(option, selectedMode) {
  const selected = option.mode === selectedMode;
  const unavailable = option.allowed ? "" : " Not allowed by Codex requirements.";
  return `
    <button
      type="button"
      class="task-model-option task-permission-option${option.dangerous ? " is-dangerous" : ""}"
      data-composer-action="select-permission"
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

function renderModelFallback(loading, error) {
  if (loading) {
    return `<p class="task-model-note">Loading models...</p>`;
  }
  if (error) {
    return `<p class="task-model-note">Model list unavailable. The default Codex model will be used.</p>`;
  }
  return `<p class="task-model-note">Open this menu after Codex is connected.</p>`;
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

function permissionModeLabel(mode) {
  if (mode === "approveForMe") {
    return "Approve for me";
  }
  if (mode === "fullAccess") {
    return "Full access";
  }
  return "Ask for approval";
}

function compactPermissionModeLabel(mode) {
  if (mode === "approveForMe") {
    return "Auto review";
  }
  if (mode === "fullAccess") {
    return "Full access";
  }
  return "Ask approval";
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

function closestElement(target, selector) {
  return target instanceof Element ? target.closest(selector) : null;
}

if (!customElements.get("caffold-task-composer")) {
  customElements.define("caffold-task-composer", CaffoldTaskComposer);
}
