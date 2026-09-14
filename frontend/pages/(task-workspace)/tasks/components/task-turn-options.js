import { getAgentModels, getAgentPermissions } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
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

// What a person picked during this editing lifetime, and null where they
// picked nothing. Everything the control shows is worked out again from this,
// what the Task or Section last ran under, and the lists the agents answered.
function createChoice() {
  return {
    model: null,
    effort: null,
    fastMode: null,
    permissionMode: null,
  };
}

class CaffoldTaskTurnOptions extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      this.addEventListener("click", this.boundClick);
      this.addEventListener("beforetoggle", this.boundBeforeToggle, true);
      this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
      window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    }
    this.ensureRendered();
    void this.loadModels();
    this.requestPermissionList();
    this.render();
  }

  disconnectedCallback() {
    this.hidePopovers();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("beforetoggle", this.boundBeforeToggle, true);
    this.removeEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    // A list still on its way is asked for again when the control returns.
    this.modelRequestId += 1;
    this.permissionRequestId += 1;
    this.modelLoading = false;
    this.permissionRequest = null;
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
      // What the Task or Section last ran under.
      initialSelection: {},
      locked: false,
      placement: "below",
      // A Task already belongs to an agent, and its conversation cannot move
      // to another. Empty means a Task that does not exist yet, where every
      // agent's models are on offer.
      provider: "",
    };
    this.choice = createChoice();
    // Browsing an agent does not choose a model or change submission options.
    this.browsedProvider = "";
    this.modelOptions = [];
    this.unavailableAgents = [];
    this.modelLoading = false;
    this.modelLoaded = false;
    this.modelError = null;
    this.modelRequestId = 0;
    this.modelLoadingFeedback = createLoadingFeedback();
    // The last permission list answered or refused, kept with the directory,
    // agent, and model it was asked for; and the one on its way.
    this.permissionList = null;
    this.permissionRequest = null;
    this.permissionRequestId = 0;
    this.permissionLoadingFeedback = createLoadingFeedback();
    this.boundClick = (event) => this.handleClick(event);
    this.boundBeforeToggle = (event) => this.handleBeforeToggle(event);
    this.boundDismiss = (event) => this.handleDismiss(event);
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
    const changed =
      next.cwd !== this.context.cwd ||
      next.locked !== this.context.locked ||
      next.placement !== this.context.placement ||
      next.provider !== this.context.provider ||
      !sameSelection(next.initialSelection, this.context.initialSelection);
    if (next.provider !== this.context.provider) {
      this.browsedProvider = "";
    }
    this.context = next;
    if (next.locked) {
      this.hidePopovers();
    }
    if (changed) {
      this.update();
    }
    return changed;
  }

  reset(context = {}) {
    this.ensureState();
    this.choice = createChoice();
    this.browsedProvider = "";
    this.context = {
      ...this.context,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd ?? "."),
      initialSelection: { ...(context.initialSelection ?? {}) },
      locked: Boolean(context.locked),
      placement: context.placement === "above" ? "above" : "below",
      provider: `${context.provider ?? ""}`.trim(),
    };
    this.hidePopovers();
    this.update();
  }

  // Any input the selection is worked out from may have changed: the list the
  // selection now needs is asked for, and the control and its owner catch up.
  update() {
    if (!this.isConnected) {
      return;
    }
    this.requestPermissionList();
    this.render();
    this.emitChange();
  }

  // What a turn started now would run under, which is what the control shows.
  // Owners send it only once readyForSubmission() allows it.
  submissionOptions() {
    this.ensureState();
    const options = {};
    const model = this.selectedModel();
    if (model) {
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
    const permission = this.selectedPermission();
    if (permission) {
      options.permissionMode = permission.mode;
    }
    return options;
  }

  // A turn carries a mode from the list answered for the chosen model, so it
  // waits for that list. A list that could not be read, or that allows no
  // mode, holds it as well: nothing is sent under a mode nobody was shown.
  readyForSubmission() {
    this.ensureState();
    return Boolean(this.selectedPermission());
  }

  resetOverrides() {
    this.ensureState();
    this.choice = createChoice();
    this.update();
  }

  holdSubmissionOptions(options = {}) {
    this.ensureState();
    if (options.model) {
      this.choice.model = {
        provider: `${options.provider ?? ""}`,
        model: `${options.model}`,
      };
      this.choice.effort = options.effort ? `${options.effort}` : null;
      this.choice.fastMode = Object.hasOwn(options, "fastMode")
        ? Boolean(options.fastMode)
        : null;
    }
    if (options.permissionMode) {
      this.choice.permissionMode = `${options.permissionMode}`;
    }
    this.update();
  }

  resetFastMode() {
    this.ensureState();
    this.choice.fastMode = null;
    this.update();
  }

  snapshot() {
    return {
      model: this.selectedModel()?.model ?? "",
      effort: this.selectedEffort(),
      fastMode: this.selectedFastMode(),
      permissionMode: this.selectedPermission()?.mode ?? "",
      modelExplicit: this.choice.model !== null,
      fastModeExplicit: this.choice.fastMode !== null,
      permissionExplicit: this.choice.permissionMode !== null,
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
      this.unavailableAgents = normalizeUnavailableAgents(response);
    } catch (error) {
      if (requestId !== this.modelRequestId) {
        return;
      }
      this.modelError = error;
    } finally {
      if (requestId === this.modelRequestId) {
        this.modelLoading = false;
        this.modelLoaded = true;
        this.endLoadingFeedback(this.modelLoadingFeedback);
        this.update();
      }
    }
  }

  // At most one permission list is on its way, and it is the one the current
  // choice needs. A list already answered or refused for that choice is not
  // asked for again; another model, or a reload, asks again.
  requestPermissionList() {
    const target = this.isConnected ? this.permissionTarget() : null;
    const needed =
      target && this.permissionList?.target.key !== target.key ? target : null;
    if (this.permissionRequest && this.permissionRequest.key === needed?.key) {
      return;
    }
    if (this.permissionRequest) {
      this.permissionRequestId += 1;
      this.permissionRequest = null;
    }
    if (needed) {
      void this.loadPermissions(needed);
    } else {
      this.endLoadingFeedback(this.permissionLoadingFeedback);
    }
  }

  async loadPermissions(target) {
    const requestId = ++this.permissionRequestId;
    this.permissionRequest = target;
    this.startLoadingFeedback(this.permissionLoadingFeedback);
    this.render();
    // Announced as it goes out, so an owner holding a submission for this list
    // stops before the list returns rather than after.
    this.emitChange();
    let list;
    try {
      const response = await getAgentPermissions(
        target.cwd,
        target.provider,
        target.model,
      );
      list = { target, ...normalizePermissionList(response), error: null };
    } catch (error) {
      list = {
        target,
        options: [],
        defaultMode: "",
        fixedWhenConversationStarts: false,
        error,
      };
    }
    if (requestId !== this.permissionRequestId) {
      return;
    }
    this.permissionList = list;
    this.permissionRequest = null;
    this.endLoadingFeedback(this.permissionLoadingFeedback);
    this.update();
  }

  // Feedback follows the list, not the request. A request superseded while
  // its list is still pending hands the count on rather than starting over;
  // only a settled list, a choice that needs none, or a disconnected control
  // ends it.
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

  selectedModel() {
    const offered = this.offeredModels();
    return (
      offered.find((option) => sameModel(option, this.choice.model)) ??
      rememberedModel(offered, this.context.initialSelection?.model) ??
      offered.find((option) => option.isDefault) ??
      offered[0] ??
      null
    );
  }

  // Reasoning and speed belong to the model they were set on: a person's to
  // the model they picked, the remembered ones to the remembered model.
  selectedEffort() {
    const model = this.selectedModel();
    const efforts = model?.supportedReasoningEfforts ?? [];
    const offered = (value) =>
      efforts.find((option) => option.value === value)?.value ?? "";
    return (
      (sameModel(model, this.choice.model) && offered(this.choice.effort)) ||
      (this.isRememberedModel(model) &&
        offered(this.context.initialSelection?.effort)) ||
      offered(model?.defaultReasoningEffort) ||
      efforts[0]?.value ||
      ""
    );
  }

  selectedFastMode() {
    const model = this.selectedModel();
    if (!model?.supportsFast) {
      return false;
    }
    if (sameModel(model, this.choice.model) && this.choice.fastMode !== null) {
      return this.choice.fastMode;
    }
    return (
      this.isRememberedModel(model) &&
      Boolean(this.context.initialSelection?.fastMode)
    );
  }

  isRememberedModel(model) {
    return Boolean(
      model &&
        rememberedModel(
          this.offeredModels(),
          this.context.initialSelection?.model,
        ) === model,
    );
  }

  // The mode a turn would run under, from the list answered for the chosen
  // model: a person's pick, then what the Task or Section last ran under,
  // then the list's own default, passing over any mode the list withholds.
  selectedPermission() {
    const list = this.answeredPermissionList();
    if (!list) {
      return null;
    }
    const allowed = (mode) =>
      list.options.find(
        (option) => option.allowed && option.mode === `${mode ?? ""}`,
      );
    return (
      allowed(this.choice.permissionMode) ??
      allowed(this.context.initialSelection?.permissionMode) ??
      allowed(list.defaultMode) ??
      list.options.find((option) => option.allowed) ??
      null
    );
  }

  // The list settled for the chosen model in this directory, answered or
  // refused; nothing while that list is still to come.
  settledPermissionList() {
    const target = this.permissionTarget();
    return target && this.permissionList?.target.key === target.key
      ? this.permissionList
      : null;
  }

  answeredPermissionList() {
    const list = this.settledPermissionList();
    return list && !list.error ? list : null;
  }

  permissionTarget() {
    const model = this.selectedModel();
    if (!model) {
      return null;
    }
    const cwd = cleanLogicalPath(this.context.cwd || ".");
    return {
      cwd,
      provider: model.provider,
      model: model.model,
      key: JSON.stringify([cwd, model.provider, model.model]),
    };
  }

  // Whether the agent takes its mode only when the conversation starts is the
  // agent's, not one model's, so the last list answered says so while another
  // model's list is on its way.
  permissionFixed() {
    return permissionFixedAfterStart(
      this.context,
      this.permissionList?.fixedWhenConversationStarts,
    );
  }

  // Why no model can be chosen once the model list has settled without one.
  modelUnavailableReason() {
    if (this.modelError) {
      return errorMessage(this.modelError);
    }
    const provider = `${this.context.provider ?? ""}`.trim();
    return (
      this.unavailableAgents.find((agent) => agent.provider === provider)
        ?.message || "No agent offered a model."
    );
  }

  handleClick(event) {
    const action = event.target.closest?.("[data-turn-options-action]");
    if (!action || !this.contains(action) || this.context.locked) {
      return;
    }
    const type = action.dataset.turnOptionsAction;
    if (type === "select-permission" && this.permissionFixed()) {
      return;
    }
    if (type === "browse-provider") {
      this.browseProvider(action.dataset.provider);
    } else if (type === "select-model") {
      this.selectModel(action.dataset.model, action.dataset.provider);
    } else if (type === "select-effort") {
      this.selectEffort(action.dataset.effort);
    } else if (type === "select-fast-mode") {
      this.selectFastMode(action.dataset.fastMode === "true");
    } else if (type === "select-permission") {
      this.selectPermission(action.dataset.permissionMode, action);
    }
  }

  handleDismiss(event) {
    const popover = event.target;
    if (
      popover === this.modelPopover() ||
      popover === this.permissionPopover()
    ) {
      this.hidePopover(popover);
    }
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
    if (
      popover === this.permissionPopover() &&
      (this.context.locked || this.permissionFixed())
    ) {
      event.preventDefault();
      return;
    }
    if (popover === this.modelPopover()) {
      this.browsedProvider = this.selectedModel()?.provider ?? "";
      this.render();
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

  browseProvider(provider) {
    if (!this.offeredModels().some((option) => option.provider === provider)) {
      return;
    }
    this.browsedProvider = provider;
    this.render();
  }

  selectModel(modelValue, providerValue = "") {
    const model = this.offeredModels().find((option) =>
      option.model === modelValue &&
      (!providerValue || option.provider === providerValue)
    );
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.browsedProvider = model.provider;
    this.update();
  }

  selectEffort(effort) {
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.choice.effort = `${effort ?? ""}`;
    this.hidePopover(this.modelPopover());
    this.update();
  }

  selectFastMode(fastMode) {
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.choice.fastMode = Boolean(fastMode && model.supportsFast);
    this.hidePopover(this.modelPopover());
    this.update();
  }

  // Picking the model on show, or one of its settings, makes the reasoning and
  // speed shown with it the person's own. Identical effort names do not
  // establish equivalent settings on another model, so another model starts
  // from its own.
  chooseModel(model) {
    if (sameModel(model, this.choice.model)) {
      return;
    }
    const shown = this.selectedModel() === model;
    const effort = shown ? this.selectedEffort() : "";
    const fastMode = shown ? this.selectedFastMode() : null;
    this.choice.model = { provider: model.provider, model: model.model };
    this.choice.effort = effort || null;
    this.choice.fastMode = fastMode;
  }

  selectPermission(permissionMode, control = null) {
    if (this.permissionFixed()) {
      return;
    }
    const option = this.answeredPermissionList()?.options.find(
      (candidate) => candidate.mode === permissionMode,
    );
    if (!option?.allowed) {
      return;
    }
    if (
      option.dangerous &&
      this.selectedPermission()?.mode !== permissionMode &&
      !window.confirm(
        "Full access removes sandbox restrictions and approval prompts for subsequent turns. Continue?",
      )
    ) {
      this.restorePermissionOptionFocus(control, permissionMode);
      return;
    }
    this.choice.permissionMode = permissionMode;
    this.hidePopover(this.permissionPopover());
    this.update();
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
    const locked = this.context.locked;
    this.dataset.placement = this.context.placement;

    const modelPending = !model && !this.modelLoaded;
    const modelUnavailable = !model && this.modelLoaded;
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
    modelButton.classList.toggle("is-unavailable", modelUnavailable);
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
          : modelUnavailable
            ? `Models could not be loaded. ${this.modelUnavailableReason()}`
            : summaryLabel,
      html: modelUnavailable
        ? `<span class="task-model-name">Unavailable</span>`
        : `
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
    this.renderModelPopover(offered, model, effort, fastMode);

    const settled = this.settledPermissionList();
    const permission = this.selectedPermission();
    const permissionFixed = this.permissionFixed();
    const permissionLocked = locked || permissionFixed;
    const permissionButton = this.permissionButton();
    const feedback = this.permissionLoadingFeedback;
    // Until the delay passes, a list on its way leaves the closed control as
    // it was; a first list has nothing to leave, so it shows the slot.
    const keepShown =
      Boolean(model) &&
      !settled &&
      !feedback.visible &&
      Boolean(permissionButton.renderedHtml) &&
      permissionButton.renderedHtml !== LOADING_SLOT_HTML;
    const permissionUnavailable = Boolean(settled) && !permission;
    permissionButton.disabled = permissionLocked;
    if (permissionLocked) {
      this.hidePopover(this.permissionPopover());
    }
    if (!keepShown) {
      permissionButton.classList.toggle("is-dangerous", Boolean(permission?.dangerous));
      permissionButton.classList.toggle("is-unavailable", permissionUnavailable);
    }
    this.patchPickerButton(permissionButton, {
      busy: !settled,
      pending: !settled && !keepShown,
      feedback,
      title: permissionFixed
        ? PERMISSION_FIXED_WHEN_CONVERSATION_STARTS
        : locked
          ? "Approval mode can be changed after the active turn finishes."
          : !settled
            ? "Loading permission modes"
            : settled.error
              ? `Permission modes could not be loaded. ${errorMessage(settled.error)}`
              : permission?.label ?? "No approval mode is available here.",
      html: keepShown
        ? permissionButton.renderedHtml
        : permissionUnavailable
          ? "<span>Unavailable</span>"
          : `<span>${escapeHtml(compactPermissionModeLabel(permission?.mode, permission?.label))}</span>`,
    });
    // Until the model is known its width is not, and a control sitting to the
    // right of it would be carried along when the label lands. Without a model
    // there is no list to show.
    this.permissionPicker().hidden = !model;
    this.patchPopover(
      this.permissionPopover(),
      `<p class="task-permission-heading">Permissions</p>
      ${renderPermissionBody(settled, permission)}`,
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

  renderModelPopover(offered, model, effort, fastMode) {
    const popover = this.modelPopover();
    if (!offered.length) {
      this.patchPopover(popover, `<section>
        <p>Model</p>
        ${renderModelFallback(
          this.modelLoaded ? this.modelUnavailableReason() : "",
        )}
      </section>`);
      return;
    }
    const providers = [...new Set(offered.map((option) => option.provider))];
    const provider = providers.includes(this.browsedProvider)
      ? this.browsedProvider
      : model?.provider ?? providers[0];
    this.patchPopover(popover, `
      <div class="task-model-browser">
        <section class="task-provider-options" aria-label="Providers">
          <p>Provider</p>
          <div class="task-provider-list"></div>
        </section>
        <div class="task-provider-models">
          <section aria-label="Models">
            <p>Model</p>
            <div class="task-model-list"></div>
          </section>
          <div class="task-model-settings"></div>
        </div>
      </div>`);
    this.patchPopover(
      popover,
      providers.map((value) => renderProviderOption(value, provider)).join(""),
      popover.querySelector(".task-provider-list"),
    );
    this.patchPopover(
      popover,
      offered.filter((option) => option.provider === provider)
        .map((option) => renderModelOption(option, model)).join(""),
      popover.querySelector(".task-model-list"),
    );
    this.patchPopover(
      popover,
      model?.provider === provider ? renderModelSettings(model, effort, fastMode) : "",
      popover.querySelector(".task-model-settings"),
    );
  }

  patchPopover(popover, html, content = null) {
    content ??= popover.querySelector(
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
      optionForFocusKey(popover, focused)?.focus({ preventScroll: true });
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
        !this.permissionFixed() &&
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
        sessionBound: true,
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
        badgeAtEnd: true,
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
  if (kind === "model" && action === "browse-provider") {
    const value = `${control.dataset.provider ?? ""}`;
    return value
      ? {
          id: `provider:${encodeURIComponent(value)}`,
          actionId: ACTION_HINT_ACTION.MODEL_PROVIDER_BROWSE,
          action,
          value,
        }
      : null;
  }
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
  for (const key of ["model", "effort", "fastMode", "permissionMode", "provider"]) {
    if (element.dataset[key] !== undefined) {
      return {
        action: element.dataset.turnOptionsAction,
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
      element.dataset.turnOptionsAction === focus.action &&
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

function sameModel(option, identity) {
  return Boolean(
    option &&
      identity &&
      option.model === identity.model &&
      (!identity.provider || option.provider === identity.provider),
  );
}

// What a Task or Section remembers names a model but not the agent offering
// it, so the name counts only when exactly one agent offers a model by it.
function rememberedModel(offered, model) {
  const name = `${model ?? ""}`.trim();
  const matches = name ? offered.filter((option) => option.model === name) : [];
  return matches.length === 1 ? matches[0] : null;
}

function sameSelection(left, right) {
  return (
    ["model", "effort", "permissionMode"].every(
      (key) => `${left?.[key] ?? ""}` === `${right?.[key] ?? ""}`,
    ) && Boolean(left?.fastMode) === Boolean(right?.fastMode)
  );
}

function errorMessage(error) {
  return `${error?.message ?? ""}`.trim() || "The request failed.";
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

function normalizeUnavailableAgents(response) {
  const agents = Array.isArray(response?.unavailable) ? response.unavailable : [];
  return agents
    .map((agent) => ({
      provider: `${agent?.provider ?? ""}`.trim(),
      message: `${agent?.message ?? ""}`.trim(),
    }))
    .filter((agent) => agent.provider);
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

// A Task that already belongs to an agent cannot change a mode the catalog
// says is taken only when the conversation starts. A new Task has no
// provider yet, so the same catalog still lets the mode be chosen.
function permissionFixedAfterStart(context, fixedWhenConversationStarts) {
  return (
    Boolean(`${context?.provider ?? ""}`.trim()) &&
    Boolean(fixedWhenConversationStarts)
  );
}

function normalizePermissionList(response) {
  return {
    options: normalizePermissionOptions(response),
    defaultMode: `${response?.defaultMode ?? ""}`.trim(),
    fixedWhenConversationStarts: Boolean(response?.fixedWhenConversationStarts),
  };
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

function renderProviderOption(provider, browsedProvider) {
  const label = { codex: "Codex", claude: "Claude", grok: "Grok" }[provider] ?? provider;
  return `
    <button
      type="button"
      class="task-model-option task-provider-option"
      data-turn-options-action="browse-provider"
      data-provider="${escapeHtml(provider)}"
      aria-pressed="${provider === browsedProvider}"
    ><span><strong>${escapeHtml(label)}</strong></span></button>`;
}

function renderModelSettings(model, effort, fastMode) {
  const efforts = model.supportedReasoningEfforts;
  if (!efforts.length && !model.supportsFast) {
    return "";
  }
  return `<hr>
    ${efforts.length ? `<section aria-label="Reasoning level">
      <p>Reasoning level</p>
      <div class="task-model-setting-options">
        ${efforts.map((option) => renderReasoningOption(option, effort)).join("")}
      </div>
    </section>` : ""}
    ${model.supportsFast ? `<section aria-label="Speed">
      <p>Speed</p>
      <div class="task-model-setting-options">
        ${renderFastModeOption(false, fastMode)}
        ${renderFastModeOption(true, fastMode)}
      </div>
    </section>` : ""}`;
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
      ${selected ? "autofocus" : ""}
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
      ${selected ? "autofocus" : ""}
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

// A list that cannot be read is a failure to report, not a gap to fill; a
// reload asks again.
function renderModelFallback(reason) {
  if (!reason) {
    return `<p class="task-model-note">Loading models...</p>`;
  }
  return `<p class="task-model-note">Models could not be loaded. ${escapeHtml(reason)} Reload the page to try again.</p>`;
}

function renderPermissionBody(list, selected) {
  if (!list) {
    return `<p class="task-model-note">Loading permission modes...</p>`;
  }
  if (list.error) {
    return `<p class="task-model-note">Permission modes could not be loaded. ${escapeHtml(errorMessage(list.error))} Reload the page to try again.</p>`;
  }
  return (
    list.options
      .map((option) => renderPermissionOption(option, selected?.mode ?? ""))
      .join("") ||
    `<p class="task-model-note">No approval mode is available here.</p>`
  );
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

// Copy for the catalog kind that a conversation-create choice cannot change.
// Grok is the agent that currently reports it.
const PERMISSION_FIXED_WHEN_CONVERSATION_STARTS =
  "Grok fixes the permission mode when the conversation starts; start a new Task to change it.";

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
