import { getAgentModels, getAgentPermissions } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import {
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "../../../../keyboard-navigation.js";
import { cleanLogicalPath } from "../task-format.js";
import "../../../../keyboard-navigation/components/presentation.js";

// A list that arrives quickly is never seen loading; only one still pending
// after this long earns a spinner in the closed control.
const LOADING_DELAY_MS = 180;
const LOADING_SLOT_HTML =
  '<span class="task-picker-spinner" aria-hidden="true"></span>';

let turnOptionsInstanceSequence = 0;

function createLoadingFeedback() {
  return { timer: null, visible: false };
}

function createSelection() {
  return {
    provider: "",
    model: "",
    effort: "",
    fastMode: false,
    modelExplicit: false,
    fastModeExplicit: false,
    permissionMode: "",
    permissionExplicit: false,
  };
}

class CaffoldTaskTurnOptions extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
      this.addEventListener("beforetoggle", this.boundBeforeToggle, true);
      this.addEventListener("toggle", this.boundToggle, true);
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    this.ensureRendered();
    this.render();
    void this.loadModels();
    // Which permission modes to offer depends on which agent will run the
    // Task. A Task that exists already says; a new one is decided by the model
    // that is chosen, so its modes are asked for once the list arrives.
    if (this.context.provider) {
      void this.loadPermissions(this.context.cwd);
    }
  }

  disconnectedCallback() {
    this.hidePopovers();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("beforetoggle", this.boundBeforeToggle, true);
    this.removeEventListener("toggle", this.boundToggle, true);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.modelRequestId += 1;
    this.permissionRequestId += 1;
    this.modelLoading = false;
    this.permissionLoading = false;
    this.endLoadingFeedback(this.modelLoadingFeedback);
    this.endLoadingFeedback(this.permissionLoadingFeedback);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    const instanceId = ++turnOptionsInstanceSequence;
    this.modelPopoverId = `caffold-task-model-options-${instanceId}`;
    this.permissionPopoverId = `caffold-task-permission-options-${instanceId}`;
    this.modelAnchorName = `--caffold-task-model-anchor-${instanceId}`;
    this.permissionAnchorName = `--caffold-task-permission-anchor-${instanceId}`;
    this.context = {
      cwd: ".",
      initialSelection: {},
      locked: false,
      placement: "below",
      // A Task already belongs to an agent, and its conversation cannot move
      // to another. Empty means a Task that does not exist yet, where every
      // agent's models are on offer.
      provider: "",
    };
    this.selection = createSelection();
    this.modelOptions = [];
    this.modelLoading = false;
    this.modelLoaded = false;
    this.modelError = null;
    this.modelRequestId = 0;
    this.modelLoadingFeedback = createLoadingFeedback();
    this.permissionOptions = [];
    this.permissionCwd = "";
    this.permissionLoading = false;
    this.permissionLoaded = false;
    this.permissionError = null;
    this.permissionRequestId = 0;
    this.permissionLoadingFeedback = createLoadingFeedback();
    this.defaultPermissionMode = "";
    this.boundClick = (event) => this.handleClick(event);
    this.boundBeforeToggle = (event) => this.handleBeforeToggle(event);
    this.boundToggle = (event) => this.handleToggle(event);
    this.boundIconsReady = () => this.render();
    warmIcons();
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .task-turn-options")) {
      return;
    }
    this.innerHTML = `
      <div class="task-turn-options">
        <div class="task-model-picker">
          <button
            type="button"
            class="task-model-button"
            popovertarget="${this.modelPopoverId}"
            popovertargetaction="toggle"
            aria-label="Choose model and reasoning"
          ></button>
          <div
            id="${this.modelPopoverId}"
            class="task-model-popover"
            popover="auto"
            role="menu"
            aria-label="Model and reasoning options"
          >
            <div class="task-model-popover-content"></div>
            <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
          </div>
        </div>
        <div class="task-permission-picker">
          <button
            type="button"
            class="task-permission-button"
            popovertarget="${this.permissionPopoverId}"
            popovertargetaction="toggle"
            aria-label="Choose approval mode"
          ></button>
          <div
            id="${this.permissionPopoverId}"
            class="task-permission-popover"
            popover="auto"
            role="menu"
            aria-label="Approval modes"
          >
            <div class="task-permission-popover-content"></div>
            <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
          </div>
        </div>
      </div>
    `;
    this.modelButton().style.anchorName = this.modelAnchorName;
    this.permissionButton().style.anchorName = this.permissionAnchorName;
    this.modelPopover().style.positionAnchor = this.modelAnchorName;
    this.permissionPopover().style.positionAnchor = this.permissionAnchorName;
  }

  setContext(context = {}) {
    this.ensureState();
    const next = {
      ...this.context,
      ...context,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd ?? "."),
      initialSelection: {
        ...(this.context.initialSelection ?? {}),
        ...(context.initialSelection ?? {}),
      },
      locked: Boolean(context.locked),
      placement: context.placement === "above" ? "above" : "below",
      provider: `${context.provider ?? this.context.provider ?? ""}`.trim(),
    };
    const cwdChanged = next.cwd !== this.context.cwd;
    const lockedChanged = next.locked !== this.context.locked;
    const placementChanged = next.placement !== this.context.placement;
    const providerChanged = next.provider !== this.context.provider;
    this.context = next;
    const selectionChanged = this.applyInitialSelection(next.initialSelection);
    if (next.locked) {
      this.hidePopovers();
    }
    if (this.isConnected && (selectionChanged || lockedChanged || placementChanged)) {
      this.render();
    }
    if (this.isConnected && (cwdChanged || providerChanged)) {
      void this.loadPermissions(next.cwd);
    }
    if (this.isConnected && providerChanged) {
      this.applyDefaultModelSelection();
      this.render();
    }
    return (
      cwdChanged ||
      selectionChanged ||
      lockedChanged ||
      placementChanged ||
      providerChanged
    );
  }

  reset(context = {}) {
    this.ensureState();
    this.selection = createSelection();
    this.context = {
      ...this.context,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd ?? "."),
      initialSelection: { ...(context.initialSelection ?? {}) },
      locked: Boolean(context.locked),
      placement: context.placement === "above" ? "above" : "below",
      provider: `${context.provider ?? ""}`.trim(),
    };
    this.applyInitialSelection(this.context.initialSelection);
    this.applyDefaultModelSelection();
    this.applyDefaultPermissionSelection();
    this.hidePopovers();
    if (this.isConnected) {
      this.render();
      void this.loadPermissions(this.context.cwd);
    }
  }

  applyInitialSelection(initial = {}) {
    const selection = this.selection;
    let changed = false;
    if (initial.model && !selection.modelExplicit && selection.model !== `${initial.model}`) {
      selection.model = `${initial.model}`;
      changed = true;
    }
    if (initial.effort && !selection.modelExplicit && selection.effort !== `${initial.effort}`) {
      selection.effort = `${initial.effort}`;
      changed = true;
    }
    if (
      Object.hasOwn(initial, "fastMode") &&
      !selection.fastModeExplicit &&
      selection.fastMode !== Boolean(initial.fastMode)
    ) {
      selection.fastMode = Boolean(initial.fastMode);
      changed = true;
    }
    if (
      initial.permissionMode &&
      !selection.permissionExplicit &&
      selection.permissionMode !== `${initial.permissionMode}`
    ) {
      selection.permissionMode = `${initial.permissionMode}`;
      changed = true;
    }
    return changed;
  }

  submissionOptions() {
    this.ensureState();
    const options = {};
    const model = this.selectedModel();
    if (model?.model) {
      options.model = model.model;
      // Which agent runs the Task comes from the model that was chosen. The
      // list said which agent offers each one, so nothing has to be inferred
      // from the name.
      options.provider = model.provider;
    }
    const effort = this.selectedEffort();
    if (effort) {
      options.effort = effort;
    }
    options.fastMode = this.selectedFastMode();
    // The mode the picker shows is the mode the turn runs under, so it is sent
    // whether or not a person touched it. It is sent only while the list that
    // offered it is the one in hand: a list still arriving describes the agent
    // or model chosen before, and a mode this one cannot work under would be
    // refused at the moment the turn starts. Sending nothing then leaves the
    // agent's own default standing, which is what the picker says it will.
    const permission = this.permissionLoading ? null : this.selectedPermission();
    if (permission?.allowed) {
      options.permissionMode = permission.mode;
    }
    return options;
  }

  readyForSubmission() {
    this.ensureState();
    return this.modelLoaded && !this.modelLoading;
  }

  resetOverrides() {
    this.selection.modelExplicit = false;
    this.selection.fastModeExplicit = false;
    this.selection.permissionExplicit = false;
  }

  holdSubmissionOptions(options = {}) {
    this.ensureState();
    if (options.model || options.effort) {
      this.selection.model = `${options.model ?? this.selection.model}`;
      this.selection.effort = `${options.effort ?? this.selection.effort}`;
      this.selection.modelExplicit = true;
    }
    if (Object.hasOwn(options, "fastMode")) {
      this.selection.fastMode = Boolean(options.fastMode);
      this.selection.fastModeExplicit = true;
    }
    if (options.permissionMode) {
      this.selection.permissionMode = `${options.permissionMode}`;
      this.selection.permissionExplicit = true;
    }
    if (this.isConnected) {
      this.render();
    }
  }

  resetFastMode() {
    this.selection.fastMode = false;
    this.selection.fastModeExplicit = false;
    this.render();
    this.emitChange();
  }

  snapshot() {
    return {
      model: this.selectedModel()?.model ?? "",
      effort: this.selectedEffort(),
      fastMode: this.selectedFastMode(),
      permissionMode: this.selectedPermissionMode(),
      modelExplicit: this.selection.modelExplicit,
      fastModeExplicit: this.selection.fastModeExplicit,
      permissionExplicit: this.selection.permissionExplicit,
    };
  }

  async loadModels() {
    if (this.modelLoaded || this.modelLoading) {
      return;
    }
    const requestId = ++this.modelRequestId;
    this.modelLoading = true;
    this.modelError = null;
    this.startLoadingFeedback(this.modelLoadingFeedback);
    this.render();
    try {
      const response = await getAgentModels();
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
        this.endLoadingFeedback(this.modelLoadingFeedback);
        this.render();
        this.emitChange();
        void this.loadPermissions(this.context.cwd);
      }
    }
  }

  async loadPermissions(cwd) {
    const targetCwd = cleanLogicalPath(cwd || ".");
    const chosen = this.selectedModel();
    const targetProvider = chosen?.provider ?? this.context.provider ?? "";
    // One agent's modes depend on the model: only some models can decide
    // permissions for themselves, so the list is asked for again when the
    // choice changes.
    const targetModel = chosen?.model ?? "";
    if (
      this.permissionCwd === targetCwd &&
      this.permissionProvider === targetProvider &&
      this.permissionModel === targetModel &&
      (this.permissionLoaded || this.permissionLoading)
    ) {
      return;
    }
    const requestId = ++this.permissionRequestId;
    this.permissionCwd = targetCwd;
    this.permissionProvider = targetProvider;
    this.permissionModel = targetModel;
    this.permissionLoading = true;
    this.permissionLoaded = false;
    this.permissionError = null;
    this.startLoadingFeedback(this.permissionLoadingFeedback);
    this.render();
    try {
      const response = await getAgentPermissions(
        targetCwd,
        targetProvider,
        targetModel,
      );
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
      this.defaultPermissionMode = defaultOption?.mode ?? "";
      this.applyDefaultPermissionSelection();
      this.permissionLoaded = true;
    } catch (error) {
      if (requestId !== this.permissionRequestId) {
        return;
      }
      this.permissionOptions = [];
      this.permissionError = error;
      this.permissionLoaded = true;
      this.defaultPermissionMode = "";
    } finally {
      if (requestId === this.permissionRequestId) {
        this.permissionLoading = false;
        this.endLoadingFeedback(this.permissionLoadingFeedback);
        this.render();
        this.emitChange();
      }
    }
  }

  // Feedback follows the list, not the request. A request superseded while
  // its list is still pending hands the count on rather than starting over;
  // only a settled list or a disconnected control ends it.
  startLoadingFeedback(feedback) {
    if (feedback.timer !== null || feedback.visible) {
      return;
    }
    feedback.timer = window.setTimeout(() => {
      feedback.timer = null;
      feedback.visible = true;
      this.render();
    }, LOADING_DELAY_MS);
  }

  endLoadingFeedback(feedback) {
    window.clearTimeout(feedback.timer);
    feedback.timer = null;
    feedback.visible = false;
  }

  // The models on offer here: one agent's for an existing Task, every agent's
  // for one that does not exist yet.
  offeredModels() {
    const provider = `${this.context.provider ?? ""}`.trim();
    if (!provider) {
      return this.modelOptions;
    }
    // An agent that could not be asked leaves its Task with no models rather
    // than with another agent's, which the conversation could not continue in.
    return this.modelOptions.filter((option) => option.provider === provider);
  }

  applyDefaultModelSelection() {
    const offered = this.offeredModels();
    if (!offered.length) {
      return;
    }
    const selection = this.selection;
    const model =
      offered.find((option) =>
        option.model === selection.model &&
        (!selection.provider || option.provider === selection.provider)
      ) ??
      offered.find((option) => option.isDefault) ??
      offered[0];
    selection.model ||= model.model;
    selection.provider = model.provider;
    selection.effort ||=
      model.defaultReasoningEffort ||
      model.supportedReasoningEfforts[0]?.value ||
      "";
    if (!model.supportsFast) {
      selection.fastMode = false;
    }
  }

  applyDefaultPermissionSelection() {
    const selection = this.selection;
    const selected = this.permissionOptions.find(
      (option) => option.mode === selection.permissionMode,
    );
    // What the Task last ran under, unless this list withholds it. A model
    // change can leave the remembered mode one the chosen model cannot work
    // under, and showing it then would name a mode no turn could start under.
    const canonical = selection.permissionExplicit
      ? null
      : this.permissionOptions.find(
          (option) =>
            option.mode ===
            `${this.context.initialSelection?.permissionMode ?? ""}`.trim(),
        );
    if (canonical?.allowed) {
      selection.permissionMode = canonical.mode;
    } else if (!selection.permissionExplicit || !selected?.allowed) {
      selection.permissionMode = this.defaultPermissionMode;
      selection.permissionExplicit = false;
    }
  }

  selectedModel() {
    const offered = this.offeredModels();
    const selectedModel = this.selection.model;
    return (
      offered.find((option) =>
        option.model === selectedModel &&
        (!this.selection.provider ||
          option.provider === this.selection.provider)
      ) ??
      offered.find((option) => option.isDefault) ??
      offered[0] ??
      null
    );
  }

  selectedEffort() {
    const model = this.selectedModel();
    const supported = model?.supportedReasoningEfforts ?? [];
    return (
      supported.find((option) => option.value === this.selection.effort)?.value ||
      model?.defaultReasoningEffort ||
      supported[0]?.value ||
      ""
    );
  }

  selectedFastMode() {
    return Boolean(
      this.selection.fastMode && this.selectedModel()?.supportsFast,
    );
  }

  // The mode a turn would run under: what a person chose, or what the agent
  // said it does when nobody has. Empty until a list of modes has said one.
  selectedPermissionMode() {
    return this.selection.permissionMode || this.defaultPermissionMode;
  }

  // That mode as the list of modes describes it, and nothing when no list
  // describes it. A list still arriving is the previous one, which keeps the
  // control steady across a refresh rather than blinking through every model
  // change; whether it is current enough to send is asked where it is sent.
  selectedPermission() {
    return this.permissionOptions.find(
      (option) => option.mode === this.selectedPermissionMode(),
    );
  }

  handleClick(event) {
    const action = event.target.closest?.("[data-turn-options-action]");
    if (!action || !this.contains(action) || this.context.locked) {
      return;
    }
    const type = action.dataset.turnOptionsAction;
    if (type === "select-model") {
      this.selectModel(action.dataset.model, action.dataset.provider);
    } else if (type === "select-effort") {
      this.selectEffort(action.dataset.effort);
    } else if (type === "select-fast-mode") {
      this.selectFastMode(action.dataset.fastMode === "true");
    } else if (type === "select-permission") {
      this.selectPermission(action.dataset.permissionMode, action);
    }
  }

  handleToggle(event) {
    if (event.newState !== "open") {
      return;
    }
    const popover = event.target;
    if (
      popover !== this.modelPopover() &&
      popover !== this.permissionPopover()
    ) {
      return;
    }
    window.requestAnimationFrame(() => {
      if (!popover.matches(":popover-open")) {
        return;
      }
      popover.querySelector('[aria-pressed="true"]:not(:disabled)')?.focus();
    });
  }

  handleBeforeToggle(event) {
    if (event.newState !== "open") {
      return;
    }
    const popover = event.target;
    if (
      popover !== this.modelPopover() &&
      popover !== this.permissionPopover()
    ) {
      return;
    }
    this.constrainAnchoredPopover(popover);
  }

  constrainAnchoredPopover(popover) {
    popover.style.maxHeight = "";
    if (
      this.context.placement !== "above" ||
      window.matchMedia("(max-width: 899px)").matches
    ) {
      return;
    }
    const button =
      popover === this.modelPopover()
        ? this.modelButton()
        : this.permissionButton();
    const boundary = this.closest(
      ".task-conversation-pane, dialog, .tasks-detail-pane",
    );
    if (!button || !boundary) {
      return;
    }
    const buttonBox = button.getBoundingClientRect();
    const boundaryBox = boundary.getBoundingClientRect();
    const available = Math.floor(buttonBox.top - boundaryBox.top - 16);
    if (available > 0) {
      popover.style.maxHeight = `min(608px, ${available}px)`;
    }
  }

  selectModel(modelValue, providerValue = "") {
    const selection = this.selection;
    selection.model = `${modelValue ?? ""}`;
    selection.provider = `${providerValue ?? ""}`;
    selection.modelExplicit = true;
    const model = this.selectedModel();
    const supported = model?.supportedReasoningEfforts ?? [];
    if (!supported.some((option) => option.value === selection.effort)) {
      selection.effort =
        model?.defaultReasoningEffort ?? supported[0]?.value ?? "";
    }
    if (!model?.supportsFast) {
      selection.fastMode = false;
      selection.fastModeExplicit = true;
    }
    selection.provider = model?.provider ?? selection.provider;
    this.hidePopover(this.modelPopover());
    this.render();
    this.emitChange();
    // Choosing a model can choose an agent, and the ways an agent can be
    // allowed to work are its own. Leaving the old list up would offer modes
    // the chosen agent has never heard of.
    void this.loadPermissions(this.context.cwd);
  }

  selectEffort(effort) {
    this.selection.effort = `${effort ?? ""}`;
    this.selection.modelExplicit = true;
    this.hidePopover(this.modelPopover());
    this.render();
    this.emitChange();
  }

  selectFastMode(fastMode) {
    this.selection.fastMode = Boolean(
      fastMode && this.selectedModel()?.supportsFast,
    );
    this.selection.fastModeExplicit = true;
    this.hidePopover(this.modelPopover());
    this.render();
    this.emitChange();
  }

  selectPermission(permissionMode, control = null) {
    const option = this.permissionOptions.find(
      (candidate) => candidate.mode === permissionMode,
    );
    if (!option?.allowed) {
      return;
    }
    if (
      option.dangerous &&
      this.selection.permissionMode !== permissionMode &&
      !window.confirm(
        "Full access removes sandbox restrictions and approval prompts for subsequent turns. Continue?",
      )
    ) {
      this.restorePermissionOptionFocus(control, permissionMode);
      return;
    }
    this.selection.permissionMode = permissionMode;
    this.selection.permissionExplicit = true;
    this.hidePopover(this.permissionPopover());
    this.render();
    this.emitChange();
  }

  restorePermissionOptionFocus(control, permissionMode) {
    const popover = this.permissionPopover();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          !this.isConnected ||
          this.permissionPopover() !== popover ||
          !popover?.matches(":popover-open") ||
          !popover.contains(control) ||
          control?.dataset?.turnOptionsAction !== "select-permission" ||
          control.dataset.permissionMode !== permissionMode ||
          control.disabled
        ) {
          return;
        }
        control.focus({ preventScroll: true });
      });
    });
  }

  hidePopovers() {
    this.hidePopover(this.modelPopover());
    this.hidePopover(this.permissionPopover());
  }

  hidePopover(popover) {
    if (popover?.matches(":popover-open")) {
      popover.hidePopover();
    }
  }

  emitChange() {
    this.dispatchEvent(
      new CustomEvent("caffold:task-turn-options-change", {
        bubbles: true,
        composed: true,
        detail: this.snapshot(),
      }),
    );
  }

  render() {
    this.ensureRendered();
    const offered = this.offeredModels();
    const model = this.selectedModel();
    const effort = this.selectedEffort();
    const fastMode = this.selectedFastMode();
    const permissionMode = this.selectedPermissionMode();
    const permission = this.selectedPermission();
    const locked = this.context.locked;
    this.dataset.placement = this.context.placement;

    const modelPending = !model && this.modelLoading;
    const modelLabel = model?.displayName ?? "Model";
    // Not every model works at more than one depth. One that does not has
    // nothing to choose, and a placeholder in the summary would read as a
    // depth it was set to.
    const efforts = model?.supportedReasoningEfforts ?? [];
    const effortValue = efforts.length ? effort || "Reasoning" : "";
    const summaryLabel = [modelLabel, effortValue, fastMode ? "Fast" : ""]
      .filter(Boolean)
      .join(" · ");
    const compactModel = compactModelLabel(modelLabel);
    const supportsFast = Boolean(model?.supportsFast);
    const chosen = ["model", efforts.length ? "reasoning" : "", supportsFast ? "speed" : ""].filter(
      Boolean,
    );
    const pickerLabel = `Choose ${listPhrase(chosen)}`;
    const modelButton = this.modelButton();
    modelButton.classList.toggle("is-fast", fastMode);
    modelButton.classList.toggle("has-effort", Boolean(effortValue));
    modelButton.disabled = locked;
    modelButton.setAttribute("aria-label", pickerLabel);
    this.patchPickerButton(modelButton, {
      busy: modelPending,
      pending: modelPending,
      feedback: this.modelLoadingFeedback,
      title: locked
        ? "Model, reasoning, and speed can be changed after the active turn finishes."
        : modelPending
          ? "Loading models"
          : summaryLabel,
      html: `
      <span class="task-model-name">${escapeHtml(compactModel)}</span>
      ${
        effortValue
          ? `<span class="task-model-effort"> · ${escapeHtml(effortValue)}</span>`
          : ""
      }
      ${
        fastMode
          ? `<span class="task-model-fast" title="Fast mode">${renderInlineIcon("Zap", "Fast mode", "task-model-fast-icon")}</span>`
          : ""
      }
    `,
    });

    const modelPopover = this.modelPopover();
    const popoverLabel = listPhrase(chosen);
    modelPopover.setAttribute(
      "aria-label",
      `${popoverLabel.charAt(0).toUpperCase()}${popoverLabel.slice(1)} options`,
    );
    this.patchPopover(
      modelPopover,
      `<section>
        <p>Model</p>
        ${
          offered.length
            ? offered
                .map((option) =>
                  renderModelOption(option, model),
                )
                .join("")
            : renderModelFallback(this.modelLoading, this.modelError)
        }
      </section>
      ${
        efforts.length
          ? `<hr>
            <section>
              <p>Reasoning level</p>
              ${efforts
                .map((option) => renderReasoningOption(option, effort))
                .join("")}
            </section>`
          : ""
      }
      ${
        supportsFast
          ? `<hr>
            <section>
              <p>Speed</p>
              ${renderFastModeOption(false, fastMode)}
              ${renderFastModeOption(true, fastMode)}
            </section>`
          : ""
      }`,
    );

    const permissionPending = !permission && this.permissionLoading;
    const permissionLabel =
      permission?.label ??
      (permissionMode ? permissionModeLabel(permissionMode) : "Agent default");
    const compactPermission = permission
      ? compactPermissionModeLabel(permissionMode, permission.label)
      : permissionMode
        ? compactPermissionModeLabel(permissionMode)
        : "Agent default";
    const permissionButton = this.permissionButton();
    permissionButton.classList.toggle("is-dangerous", Boolean(permission?.dangerous));
    permissionButton.disabled = locked;
    // A list being fetched again keeps the previous list's label in place, so
    // the control stays busy without a slot.
    this.patchPickerButton(permissionButton, {
      busy: this.permissionLoading,
      pending: permissionPending,
      feedback: this.permissionLoadingFeedback,
      title: locked
        ? "Approval mode can be changed after the active turn finishes."
        : permissionPending
          ? "Loading permission modes"
          : permissionLabel,
      html: `<span>${escapeHtml(compactPermission)}</span>`,
    });
    // Until the model is known its width is not, and a control sitting to the
    // right of it would be carried along when the label lands.
    this.permissionPicker().hidden = modelPending;
    this.patchPopover(
      this.permissionPopover(),
      `<p class="task-permission-heading">Permissions</p>
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
      }`,
    );
  }

  // A pending list shows the shared slot in place of the label; the button
  // says whether the ring in it may be seen yet.
  patchPickerButton(button, { busy, pending, feedback, title, html }) {
    if (busy) {
      button.setAttribute("aria-busy", "true");
    } else {
      button.removeAttribute("aria-busy");
    }
    button.classList.toggle("is-deferred", pending && !feedback.visible);
    button.title = title;
    patchHtml(button, pending ? LOADING_SLOT_HTML : html);
  }

  patchPopover(popover, html) {
    const content = popover.querySelector(
      ":scope > .task-model-popover-content, :scope > .task-permission-popover-content",
    );
    if (!content) {
      return;
    }
    const focused = content.contains(document.activeElement)
      ? optionFocusKey(document.activeElement)
      : null;
    if (!patchHtml(content, html)) {
      return;
    }
    if (focused && popover.matches(":popover-open")) {
      optionForFocusKey(popover, focused)?.focus();
    }
  }

  modelButton() {
    return this.querySelector(":scope .task-model-button");
  }

  actionHintModelTarget({ scopeId, clipRoots = [] } = {}) {
    this.ensureRendered();
    const control = this.modelButton();
    const popover = this.modelPopover();
    if (
      !control ||
      !popover ||
      !scopeId ||
      control.getAttribute("popovertarget") !== popover.id ||
      control.getAttribute("popovertargetaction") !== "toggle"
    ) {
      return null;
    }
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: `task-composer:${scopeId}:model`,
      actionId: ACTION_HINT_ACTION.MODEL_CHOOSE,
      label: control.getAttribute("aria-label") || "Choose model and reasoning",
      control,
      clipRoots: [...clipRoots],
      isActionable: () =>
        this.isConnected &&
        this.modelButton() === control &&
        this.modelPopover() === popover &&
        control.getAttribute("popovertarget") === popover.id &&
        control.getAttribute("popovertargetaction") === "toggle" &&
        !this.context.locked &&
        !control.disabled &&
        !this.modelPopover()?.matches(":popover-open"),
    });
  }

  actionHintPermissionTarget({ scopeId, clipRoots = [] } = {}) {
    this.ensureRendered();
    const control = this.permissionButton();
    const popover = this.permissionPopover();
    if (
      !control ||
      !popover ||
      !scopeId ||
      control.getAttribute("popovertarget") !== popover.id ||
      control.getAttribute("popovertargetaction") !== "toggle"
    ) {
      return null;
    }
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: `task-composer:${scopeId}:permission`,
      actionId: ACTION_HINT_ACTION.PERMISSION_OPEN,
      label: control.getAttribute("aria-label") || "Choose approval mode",
      control,
      clipRoots: [...clipRoots],
      isActionable: () =>
        this.isConnected &&
        this.permissionButton() === control &&
        this.permissionPopover() === popover &&
        control.getAttribute("popovertarget") === popover.id &&
        control.getAttribute("popovertargetaction") === "toggle" &&
        !this.context.locked &&
        !this.permissionPicker()?.hidden &&
        !control.disabled &&
        !this.permissionPopover()?.matches(":popover-open"),
    });
  }

  keyboardNavigationContexts({ scopeId = "" } = {}) {
    this.ensureRendered();
    if (!scopeId || !this.isConnected) {
      return [];
    }
    return [
      this.popoverKeyboardNavigationContext({
        scopeId,
        kind: "model",
        label: "Model options",
        popover: this.modelPopover(),
      }),
      this.popoverKeyboardNavigationContext({
        scopeId,
        kind: "permission",
        label: "Permission options",
        popover: this.permissionPopover(),
      }),
    ].filter(Boolean);
  }

  popoverKeyboardNavigationContext({ scopeId, kind, label, popover }) {
    const presentation = popover?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const dialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!popover || !presentation || !dialog || !hud || !selector) {
      return null;
    }
    const contextId = `task-composer:${scopeId}:${kind}-options`;
    return keyboardNavigationContext({
      id: contextId,
      kind: "popover",
      root: popover,
      actionHints: {
        dialog,
        scope: this.popoverActionHintScope({ contextId, kind, popover }),
      },
      scroll: {
        hud,
        selector,
        scope: popoverScrollSurfaceScope({
          id: contextId,
          label,
          popover,
          isCurrent: () =>
            this.isConnected &&
            !this.context.locked &&
            (kind === "model"
              ? this.modelPopover() === popover
              : this.permissionPopover() === popover),
        }),
      },
    });
  }

  popoverActionHintScope({ contextId, kind, popover }) {
    if (!popover) {
      return emptyActionHintScope();
    }
    const targets = [...popover.querySelectorAll(
      ":scope [data-turn-options-action]",
    )].flatMap((control) => {
      const identity = turnOptionIdentity(control, kind);
      if (!identity || control.disabled) {
        return [];
      }
      const label = control.getAttribute("aria-label") ||
        control.textContent?.trim();
      if (!label) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${contextId}:${identity.id}`,
        actionId: identity.actionId,
        label,
        control,
        clipRoots: [popover],
        isActionable: () =>
          this.isConnected &&
          !this.context.locked &&
          popover.matches(":popover-open") &&
          (kind === "model"
            ? this.modelPopover() === popover
            : this.permissionPopover() === popover) &&
          popover.contains(control) &&
          !control.disabled &&
          sameTurnOptionIdentity(control, identity),
      })];
    });
    return {
      blocked: this.context.locked,
      targets,
      mutationRoots: [popover],
      scrollRoots: [popover],
    };
  }

  permissionButton() {
    return this.querySelector(":scope .task-permission-button");
  }

  permissionPicker() {
    return this.querySelector(":scope .task-permission-picker");
  }

  modelPopover() {
    return this.querySelector(":scope .task-model-popover");
  }

  permissionPopover() {
    return this.querySelector(":scope .task-permission-popover");
  }
}

function turnOptionIdentity(control, kind) {
  const action = `${control?.dataset?.turnOptionsAction ?? ""}`;
  if (kind === "model" && action === "select-model") {
    const value = `${control.dataset.model ?? ""}`;
    const provider = `${control.dataset.provider ?? ""}`;
    return value && provider
      ? {
          id: `model:${encodeURIComponent(provider)}:${encodeURIComponent(value)}`,
          actionId: ACTION_HINT_ACTION.MODEL_SELECT,
          action,
          value: `${provider}:${value}`,
        }
      : null;
  }
  if (kind === "model" && action === "select-effort") {
    const value = `${control.dataset.effort ?? ""}`;
    return value
      ? {
          id: `reasoning:${encodeURIComponent(value)}`,
          actionId: ACTION_HINT_ACTION.REASONING_SELECT,
          action,
          value,
        }
      : null;
  }
  if (kind === "model" && action === "select-fast-mode") {
    const value = `${control.dataset.fastMode ?? ""}`;
    return ["true", "false"].includes(value)
      ? {
          id: `speed:${value}`,
          actionId: ACTION_HINT_ACTION.SPEED_SELECT,
          action,
          value,
        }
      : null;
  }
  if (kind === "permission" && action === "select-permission") {
    const value = `${control.dataset.permissionMode ?? ""}`;
    return value
      ? {
          id: `permission:${encodeURIComponent(value)}`,
          actionId: ACTION_HINT_ACTION.PERMISSION_SELECT,
          action,
          value,
        }
      : null;
  }
  return null;
}

function sameTurnOptionIdentity(control, identity) {
  const current = turnOptionIdentity(
    control,
    identity.action === "select-permission" ? "permission" : "model",
  );
  return Boolean(
    current &&
      current.id === identity.id &&
      current.actionId === identity.actionId &&
      current.action === identity.action &&
      current.value === identity.value,
  );
}

function optionFocusKey(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  for (const key of ["model", "effort", "fastMode", "permissionMode"]) {
    if (element.dataset[key] !== undefined) {
      return {
        key,
        value: element.dataset[key],
        ...(key === "model"
          ? { provider: `${element.dataset.provider ?? ""}` }
          : {}),
      };
    }
  }
  return null;
}

function optionForFocusKey(popover, focus) {
  return [...popover.querySelectorAll("[data-turn-options-action]")].find(
    (element) =>
      element.dataset[focus.key] === focus.value &&
      (focus.key !== "model" ||
        `${element.dataset.provider ?? ""}` === focus.provider),
  );
}

// Unchanged content keeps its nodes, so one picker's response does not
// restart the spinner still turning in the other.
function patchHtml(node, html) {
  if (node.renderedHtml === html) {
    return false;
  }
  node.innerHTML = html;
  node.renderedHtml = html;
  return true;
}

function normalizeModelOptions(response) {
  const models = Array.isArray(response?.models) ? response.models : [];
  return models
    .map((model) => {
      const modelValue = `${model?.model ?? ""}`.trim();
      const provider = `${model?.provider ?? ""}`.trim();
      if (!modelValue || !provider) {
        return null;
      }
      return {
        provider,
        model: modelValue,
        displayName: `${model?.displayName ?? modelValue}`.trim(),
        isDefault: Boolean(model?.isDefault),
        defaultReasoningEffort: `${model?.defaultEffort ?? ""}`.trim(),
        supportedReasoningEfforts: normalizeReasoningOptions(model?.efforts),
        supportsFast: Boolean(model?.supportsFastMode),
      };
    })
    .filter(Boolean);
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
      return value ? { value } : null;
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
        unavailableReason: `${
          option?.unavailableReason ?? "This is not available here."
        }`.trim(),
        dangerous: Boolean(option?.dangerous),
      };
    })
    .filter(Boolean);
}

// "model", "model and reasoning", "model, reasoning, and speed".
function listPhrase(parts) {
  if (parts.length < 2) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function renderModelOption(option, selectedModel) {
  const selected =
    option.model === selectedModel?.model &&
    option.provider === selectedModel?.provider;
  return `
    <button
      type="button"
      class="task-model-option"
      data-turn-options-action="select-model"
      data-provider="${escapeHtml(option.provider)}"
      data-model="${escapeHtml(option.model)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span><strong>${escapeHtml(option.displayName)}</strong></span>
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
      data-turn-options-action="select-effort"
      data-effort="${escapeHtml(option.value)}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span><strong>${escapeHtml(option.value)}</strong></span>
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
      data-turn-options-action="select-fast-mode"
      data-fast-mode="${fastMode ? "true" : "false"}"
      aria-pressed="${selected ? "true" : "false"}"
    >
      <span><strong>${label}</strong></span>
      ${selected ? renderInlineIcon("Check", "Selected", "task-model-check") : ""}
    </button>
  `;
}

function renderPermissionOption(option, selectedMode) {
  const selected = option.mode === selectedMode;
  // Why a mode is withheld is the agent's to say; the interface only shows it.
  const unavailable = option.allowed ? "" : ` ${option.unavailableReason}`;
  return `
    <button
      type="button"
      class="task-model-option task-permission-option${option.dangerous ? " is-dangerous" : ""}"
      data-turn-options-action="select-permission"
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
    return `<p class="task-model-note">Permission modes are unavailable. The agent's own default will be used.</p>`;
  }
  return `<p class="task-model-note">Open this menu after Codex is connected.</p>`;
}

// A mode is named by the agent that offers it, and the agent sends a label
// with it. These are the shorter forms the compact control needs, and a last
// resort for a mode that arrives without a label at all: showing the agent's
// own name for it is honest, where guessing at a known one is not. A mode this
// does not recognize is a mode an agent added, and it has to remain choosable
// without Caffold shipping a line for it.
const COMPACT_PERMISSION_MODE_LABELS = {
  askForApproval: "Ask approval",
  approveForMe: "Auto review",
  fullAccess: "Full access",
};

const PERMISSION_MODE_LABELS = {
  askForApproval: "Ask for approval",
  approveForMe: "Approve for me",
  fullAccess: "Full access",
};

function permissionModeLabel(mode) {
  return PERMISSION_MODE_LABELS[mode] ?? `${mode ?? ""}`;
}

function compactPermissionModeLabel(mode, label = "") {
  return COMPACT_PERMISSION_MODE_LABELS[mode] ?? `${label || mode || ""}`;
}

if (!customElements.get("caffold-task-turn-options")) {
  customElements.define(
    "caffold-task-turn-options",
    CaffoldTaskTurnOptions,
  );
}
