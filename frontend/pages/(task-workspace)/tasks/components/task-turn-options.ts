import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  type AgentModels,
  type AgentPermissionModes,
  getAgentModels,
  getAgentPermissions,
} from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { returnPopoverFocus } from "#app/popover-focus.js";
import { scopedStyle } from "#app/scoped-style.js";
import { closestAcrossShadowRoots } from "#app/shadow-roots.js";
import { cleanLogicalPath } from "../task-format.js";

import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./task-turn-options.css.js";

// What the Task or Section last ran under, as far as the turn options read it.
export interface TurnOptionsSelection {
  model?: string;
  effort?: string;
  fastMode?: boolean;
  permissionMode?: string;
}

// What an owner hands the turn options. `provider` names the agent a Task
// already belongs to; empty means a Task that does not exist yet, where every
// agent's models are on offer.
export interface TurnOptionsContext {
  cwd?: string;
  initialSelection?: TurnOptionsSelection;
  locked?: boolean;
  placement?: "above" | "below";
  provider?: string;
  // The owner is taking voice input; a phone in portrait leaves the row to it.
  voiceInput?: boolean;
}

// What a turn started now would run under.
export interface TurnSubmissionOptions {
  model?: string;
  provider?: string;
  effort?: string;
  fastMode: boolean;
  permissionMode?: string;
}

// What the control shows, and which of it a person picked. Every change is
// announced with it.
export interface TurnOptionsSnapshot {
  model: string;
  effort: string;
  fastMode: boolean;
  permissionMode: string;
  modelExplicit: boolean;
  fastModeExplicit: boolean;
  permissionExplicit: boolean;
}

// A list that arrives quickly is never seen loading; only one still pending
// after this long earns a spinner in the closed control.
const LOADING_DELAY_MS = 180;
const LOADING_SLOT = html`<span
  class="task-picker-spinner"
  aria-hidden="true"
></span>`;

let turnOptionsInstanceSequence = 0;

interface ResolvedContext {
  cwd: string;
  initialSelection: TurnOptionsSelection;
  locked: boolean;
  placement: "above" | "below";
  provider: string;
  voiceInput: boolean;
}

interface ModelIdentity {
  provider: string;
  model: string;
}

// What a person picked during this editing lifetime, and null where they
// picked nothing. Everything the control shows is worked out again from this,
// what the Task or Section last ran under, and the lists the agents answered.
interface Choice {
  model: ModelIdentity | null;
  effort: string | null;
  fastMode: boolean | null;
  permissionMode: string | null;
}

interface ModelOption extends ModelIdentity {
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  supportsFast: boolean;
}

interface UnavailableAgent {
  provider: string;
  message: string;
}

interface PermissionOption {
  mode: string;
  label: string;
  description: string;
  allowed: boolean;
  unavailableReason: string;
  dangerous: boolean;
}

// The directory, agent, and model a permission list is asked for.
interface PermissionTarget extends ModelIdentity {
  cwd: string;
  key: string;
}

// A permission list answered or refused for its target.
interface PermissionList {
  target: PermissionTarget;
  options: PermissionOption[];
  defaultMode: string;
  fixedWhenConversationStarts: boolean;
  error: unknown;
}

interface LoadingFeedback {
  timer: number | null;
  visible: boolean;
}

// What the closed approval control shows once a list describes it.
interface PermissionFace {
  label: string;
  dangerous: boolean;
  unavailable: boolean;
}

/**
 * The model, reasoning, speed, and approval mode a turn runs under, as two
 * compact controls that each open a menu.
 *
 * The agents answer which models they offer and which modes a model allows;
 * the control shows what a turn started now would run under and announces
 * every change of it, so an owner sends only once the mode is known.
 */
@customElement("caffold-task-turn-options")
export class CaffoldTaskTurnOptions extends CaffoldElement {
  static override styles = [
    scopedStyle(busySpin, ".task-picker-spinner"),
    styles,
  ];

  private context: ResolvedContext = {
    cwd: ".",
    initialSelection: {},
    locked: false,
    placement: "below",
    provider: "",
    voiceInput: false,
  };
  private choice = createChoice();
  // Browsing an agent does not choose a model or change submission options.
  private browsedProvider = "";
  private modelOptions: ModelOption[] = [];
  private unavailableAgents: UnavailableAgent[] = [];
  private modelLoading = false;
  private modelLoaded = false;
  private modelError: unknown = null;
  private modelRequestId = 0;
  private modelLoadingFeedback = createLoadingFeedback();
  // The last permission list answered or refused, kept with the directory,
  // agent, and model it was asked for; and the one on its way.
  private permissionList: PermissionList | null = null;
  private permissionRequest: PermissionTarget | null = null;
  private permissionRequestId = 0;
  private permissionLoadingFeedback = createLoadingFeedback();
  // What the closed approval control showed, kept while another list is on
  // its way until the loading delay passes.
  private shownPermission: PermissionFace | null = null;
  private readonly instanceId = ++turnOptionsInstanceSequence;
  private readonly modelPopoverId =
    `caffold-task-model-options-${this.instanceId}`;
  private readonly permissionPopoverId =
    `caffold-task-permission-options-${this.instanceId}`;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly reviewerChanged = () => this.forgetPermissionList();
  private readonly dismissed = (event: Event) => {
    hidePopover(event.currentTarget);
  };
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly modelButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly permissionButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly modelPopover = new DrawnRef<HTMLElement>(this);
  private readonly permissionPopover = new DrawnRef<HTMLElement>(this);

  // An owner shows the control as it is mounted, and a dialog that opens at
  // once moves focus into it.
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    window.addEventListener(
      "caffold:jev-settings-changed",
      this.reviewerChanged,
    );
    void warmIcons();
    void this.loadModels();
    this.requestPermissionList();
    this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.hidePopovers();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.removeEventListener(
      "caffold:jev-settings-changed",
      this.reviewerChanged,
    );
    // A list still on its way is asked for again when the control returns.
    this.modelRequestId += 1;
    this.permissionRequestId += 1;
    this.modelLoading = false;
    this.permissionRequest = null;
    this.endLoadingFeedback(this.modelLoadingFeedback);
    this.endLoadingFeedback(this.permissionLoadingFeedback);
  }

  setContext(context: TurnOptionsContext = {}) {
    const next: ResolvedContext = {
      ...this.context,
      ...context,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd),
      initialSelection: {
        ...this.context.initialSelection,
        ...context.initialSelection,
      },
      locked: Boolean(context.locked),
      placement: context.placement === "above" ? "above" : "below",
      provider: (context.provider ?? this.context.provider).trim(),
      voiceInput: Boolean(context.voiceInput),
    };
    const changed =
      next.cwd !== this.context.cwd ||
      next.locked !== this.context.locked ||
      next.placement !== this.context.placement ||
      next.voiceInput !== this.context.voiceInput ||
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
      this.reconcile();
    }
    return changed;
  }

  reset(context: TurnOptionsContext = {}) {
    this.choice = createChoice();
    this.browsedProvider = "";
    this.context = {
      ...this.context,
      cwd: cleanLogicalPath(context.cwd ?? this.context.cwd),
      initialSelection: { ...context.initialSelection },
      locked: Boolean(context.locked),
      placement: context.placement === "above" ? "above" : "below",
      provider: (context.provider ?? "").trim(),
      voiceInput: Boolean(context.voiceInput),
    };
    this.hidePopovers();
    this.reconcile();
  }

  // What a turn started now would run under, which is what the control shows.
  // Owners send it only once readyForSubmission() allows it.
  submissionOptions(): TurnSubmissionOptions {
    const model = this.selectedModel();
    const effort = this.selectedEffort();
    const permission = this.selectedPermission();
    return {
      // Which agent runs the Task comes from the model that was chosen. The
      // list said which agent offers each one, so nothing has to be inferred
      // from the name.
      ...(model ? { model: model.model, provider: model.provider } : {}),
      ...(effort ? { effort } : {}),
      fastMode: this.selectedFastMode(),
      ...(permission ? { permissionMode: permission.mode } : {}),
    };
  }

  // A turn carries a mode from the list answered for the chosen model, so it
  // waits for that list. A list that could not be read, or that allows no
  // mode, holds it as well: nothing is sent under a mode nobody was shown.
  readyForSubmission() {
    return Boolean(this.selectedPermission());
  }

  resetOverrides() {
    this.choice = createChoice();
    this.reconcile();
  }

  holdSubmissionOptions(options: Partial<TurnSubmissionOptions> = {}) {
    if (options.model) {
      this.choice.model = {
        provider: options.provider ?? "",
        model: options.model,
      };
      this.choice.effort = options.effort || null;
      this.choice.fastMode = Object.hasOwn(options, "fastMode")
        ? Boolean(options.fastMode)
        : null;
    }
    if (options.permissionMode) {
      this.choice.permissionMode = options.permissionMode;
    }
    this.reconcile();
  }

  resetFastMode() {
    this.choice.fastMode = null;
    this.reconcile();
  }

  snapshot(): TurnOptionsSnapshot {
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

  hidePopovers() {
    hidePopover(this.modelPopover.value);
    hidePopover(this.permissionPopover.value);
  }

  // A mode can stop being withheld without the choice changing, because what
  // Caffold's own reviewer needs is configured elsewhere. Forgetting the
  // answered list is what asks again; keeping it would go on passing over a
  // mode that is now offered, and drop a person's pick for it.
  forgetPermissionList() {
    if (!this.permissionList) {
      return;
    }
    this.permissionList = null;
    this.requestPermissionList();
  }

  // At most one permission list is on its way, and it is the one the current
  // choice needs. A list already answered or refused for that choice is not
  // asked for again; another model, a reload, or a reviewer that became
  // available asks again.
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

  // Until a list describes the approval mode, the closed control keeps what
  // it showed while the delay runs, and then shows the loading slot.
  override willUpdate() {
    if (this.settledPermissionList()) {
      this.shownPermission = this.permissionFace();
    } else if (
      !this.selectedModel() ||
      this.permissionLoadingFeedback.visible
    ) {
      this.shownPermission = null;
    }
  }

  override render() {
    const { model, permission } = this.controls;
    const offered = this.offeredModels();
    const selected = this.selectedModel();
    const settled = this.settledPermissionList();
    return html`
      <div class="task-turn-options" @click=${this.handleClick}>
        <div class="task-model-picker">
          <button
            ${drawn(this.modelButton)}
            ${this.hints.button({
              id: "model",
              label: model.label,
              action: ACTION_HINT_ACTION.MODEL_CHOOSE,
            })}
            type="button"
            class=${buttonClasses("task-model-button", {
              "is-fast": model.fast,
              "has-effort": Boolean(model.effort),
              "is-unavailable": model.unavailable,
              "is-deferred": model.deferred,
            })}
            popovertarget=${this.modelPopoverId}
            popovertargetaction="toggle"
            aria-label=${model.label}
            title=${model.title}
            aria-busy=${model.busy ? "true" : nothing}
            ?disabled=${model.disabled}
          >${model.pending ? LOADING_SLOT : modelSummary(model)}</button>
          <div
            ${drawn(this.modelPopover)}
            ${this.keyboard.popover({
              id: "model-options",
              label: "Model options",
              sessionBound: true,
            })}
            id=${this.modelPopoverId}
            class="task-model-popover"
            popover="auto"
            role="menu"
            aria-label=${model.popoverLabel}
            @beforetoggle=${this.handleBeforeToggle}
            @caffold:keyboard-session-dismiss=${this.dismissed}
          >
            <div class="task-model-popover-content">${
              offered.length
                ? this.modelBrowser(offered, selected)
                : html`<section>
                    <p>Model</p>
                    ${modelFallback(
                      this.modelLoaded ? this.modelUnavailableReason() : "",
                    )}
                  </section>`
            }</div>
            <caffold-keyboard-navigation-presentation
              ${this.keyboard.presentation()}
            ></caffold-keyboard-navigation-presentation>
          </div>
        </div>
        <div class="task-permission-picker" ?hidden=${permission.hidden}>
          <button
            ${drawn(this.permissionButton)}
            ${this.hints.button({
              id: "permission",
              label: "Choose approval mode",
              action: ACTION_HINT_ACTION.PERMISSION_OPEN,
            })}
            type="button"
            class=${buttonClasses("task-permission-button", {
              "is-dangerous": permission.dangerous,
              "is-unavailable": permission.unavailable,
              "is-deferred": permission.deferred,
            })}
            popovertarget=${this.permissionPopoverId}
            popovertargetaction="toggle"
            aria-label="Choose approval mode"
            title=${permission.title}
            aria-busy=${permission.busy ? "true" : nothing}
            ?disabled=${permission.disabled}
          >${
            permission.pending
              ? LOADING_SLOT
              : html`${inlineIcon(
                  "Shield",
                  "",
                  "task-permission-icon",
                )}<span class="task-permission-label"
                  >${permission.label}</span
                >`
          }</button>
          <div
            ${drawn(this.permissionPopover)}
            ${this.keyboard.popover({
              id: "permission-options",
              label: "Permission options",
              sessionBound: true,
            })}
            id=${this.permissionPopoverId}
            class="task-permission-popover"
            popover="auto"
            role="menu"
            aria-label="Approval modes"
            @beforetoggle=${this.handleBeforeToggle}
            @caffold:keyboard-session-dismiss=${this.dismissed}
          >
            <div class="task-permission-popover-content">
              <p class="task-permission-heading">Permissions</p>
              ${permissionBody(settled, this.selectedPermission(), this.hints)}
            </div>
            <caffold-keyboard-navigation-presentation
              ${this.keyboard.presentation()}
            ></caffold-keyboard-navigation-presentation>
          </div>
        </div>
      </div>
    `;
  }

  // Each control names its own place for its menu to open beside.
  override firstUpdated() {
    const model = `--caffold-task-model-anchor-${this.instanceId}`;
    const permission = `--caffold-task-permission-anchor-${this.instanceId}`;
    this.modelButton.value?.style.setProperty("anchor-name", model);
    this.permissionButton.value?.style.setProperty("anchor-name", permission);
    this.modelPopover.value?.style.setProperty("--task-menu-anchor", model);
    this.permissionPopover.value?.style.setProperty(
      "--task-menu-anchor",
      permission,
    );
  }

  override updated() {
    if (this.dataset.placement !== this.context.placement) {
      this.dataset.placement = this.context.placement;
    }
    this.toggleAttribute("data-voice-input", this.context.voiceInput);
    if (this.controls.permission.disabled) {
      hidePopover(this.permissionPopover.value);
    }
  }

  actionHintScope({ scopeId = "", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId: `task-composer:${scopeId}` });
  }

  // While a turn is being sent the menu's choices are locked, and so are
  // its keys and its scrolling.
  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    const blocked = this.context.locked;
    return this.keyboard.contexts({
      scopeId: `task-composer:${scopeId}`,
      actionHints: (pull) => ({ ...this.hints.scope(pull), blocked }),
      scroll: () => ({ ...emptyScrollSurfaceScope(), blocked }),
    });
  }

  selectModel(modelValue: string, providerValue = "") {
    const model = this.offeredModels().find(
      (option) =>
        option.model === modelValue &&
        (!providerValue || option.provider === providerValue),
    );
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.browsedProvider = model.provider;
    this.reconcile();
  }

  selectEffort(effort: string) {
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.choice.effort = effort;
    hidePopover(this.modelPopover.value);
    this.reconcile();
  }

  selectFastMode(fastMode: boolean) {
    const model = this.selectedModel();
    if (!model) {
      return;
    }
    this.chooseModel(model);
    this.choice.fastMode = fastMode && model.supportsFast;
    hidePopover(this.modelPopover.value);
    this.reconcile();
  }

  selectPermission(
    permissionMode: string,
    control: HTMLButtonElement | null = null,
  ) {
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
    hidePopover(this.permissionPopover.value);
    this.reconcile();
  }

  handleBeforeToggle(event: ToggleEvent) {
    const popover = event.target;
    if (
      !(popover instanceof HTMLElement) ||
      (popover !== this.modelPopover.value &&
        popover !== this.permissionPopover.value)
    ) {
      return;
    }
    if (event.newState !== "open") {
      returnPopoverFocus(event);
      return;
    }
    if (
      popover === this.permissionPopover.value &&
      (this.context.locked || this.permissionFixed())
    ) {
      event.preventDefault();
      return;
    }
    if (popover === this.modelPopover.value) {
      this.browsedProvider = this.selectedModel()?.provider ?? "";
      this.draw();
      this.refreshModels();
    }
    this.constrainAnchoredPopover(popover);
    returnPopoverFocus(event);
  }

  // What the two closed controls show, worked out from the choice, the Task
  // or Section's last settings, and the lists the agents answered.
  private get controls() {
    const locked = this.context.locked;
    const model = this.selectedModel();
    const effort = this.selectedEffort();
    const fastMode = this.selectedFastMode();
    const modelPending = !model && !this.modelLoaded;
    const modelUnavailable = !model && this.modelLoaded;
    const modelName = model?.displayName ?? "Model";
    // Not every model works at more than one depth. One that does not has
    // nothing to choose, and a placeholder in the summary would read as a
    // depth it was set to.
    const efforts = model?.supportedReasoningEfforts ?? [];
    const effortValue = efforts.length ? effort || "Reasoning" : "";
    const chosen = listPhrase(
      [
        "model",
        efforts.length ? "reasoning" : "",
        model?.supportsFast ? "speed" : "",
      ].filter(Boolean),
    );
    const summary = [modelName, effortValue, fastMode ? "Fast" : ""]
      .filter(Boolean)
      .join(" · ");

    const settled = this.settledPermissionList();
    const permissionFixed = this.permissionFixed();
    const permissionLocked = locked || permissionFixed;
    const shown = this.shownPermission;
    return {
      model: {
        disabled: locked,
        busy: modelPending,
        pending: modelPending,
        deferred: modelPending && !this.modelLoadingFeedback.visible,
        label: `Choose ${chosen}`,
        popoverLabel: `${chosen.charAt(0).toUpperCase()}${chosen.slice(1)} options`,
        title: locked
          ? "Model, reasoning, and speed can be changed after the active turn finishes."
          : modelPending
            ? "Loading models"
            : modelUnavailable
              ? `Models could not be loaded. ${this.modelUnavailableReason()}`
              : summary,
        unavailable: modelUnavailable,
        name: compactModelLabel(modelName),
        effort: effortValue,
        fast: fastMode,
      },
      permission: {
        // Until the model is known its width is not, and a control sitting to
        // the right of it would be carried along when the label lands.
        // Without a model there is no list to show.
        hidden: !model,
        disabled: permissionLocked,
        busy: !settled,
        pending: !shown,
        deferred: !shown && !this.permissionLoadingFeedback.visible,
        title: permissionFixed
          ? PERMISSION_FIXED_WHEN_CONVERSATION_STARTS
          : locked
            ? "Approval mode can be changed after the active turn finishes."
            : !settled
              ? "Loading permission modes"
              : settled.error
                ? `Permission modes could not be loaded. ${errorMessage(settled.error)}`
                : (this.selectedPermission()?.label ??
                  "No approval mode is available here."),
        label: shown?.label ?? "",
        dangerous: Boolean(shown?.dangerous),
        unavailable: Boolean(shown?.unavailable),
      },
    };
  }

  private permissionFace(): PermissionFace {
    const permission = this.selectedPermission();
    return {
      label: permission
        ? compactPermissionModeLabel(permission.mode, permission.label)
        : "Unavailable",
      dangerous: Boolean(permission?.dangerous),
      unavailable: !permission,
    };
  }

  private modelBrowser(offered: ModelOption[], model: ModelOption | null) {
    const providers = [...new Set(offered.map((option) => option.provider))];
    const provider = providers.includes(this.browsedProvider)
      ? this.browsedProvider
      : (model?.provider ?? providers[0]);
    return html`
      <div class="task-model-browser">
        <section class="task-provider-options" aria-label="Providers">
          <p>Provider</p>
          <div class="task-provider-list">${repeat(
            providers,
            (value) => value,
            (value) => providerOption(value, provider, this.hints),
          )}</div>
        </section>
        <div class="task-provider-models">
          <section aria-label="Models">
            <p>Model</p>
            <div class="task-model-list">${repeat(
              offered.filter((option) => option.provider === provider),
              (option) => `${option.provider}:${option.model}`,
              (option) => modelOption(option, model, this.hints),
            )}</div>
          </section>
          <div class="task-model-settings">${
            model?.provider === provider
              ? modelSettings(
                  model,
                  this.selectedEffort(),
                  this.selectedFastMode(),
                  this.hints,
                )
              : nothing
          }</div>
        </div>
      </div>
    `;
  }

  private handleClick(event: Event) {
    const action =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-turn-options-action]")
        : null;
    if (!action || !this.renderRoot.contains(action) || this.context.locked) {
      return;
    }
    const { dataset } = action;
    const type = dataset.turnOptionsAction;
    if (type === "select-permission" && this.permissionFixed()) {
      return;
    }
    if (type === "browse-provider") {
      this.browseProvider(dataset.provider ?? "");
    } else if (type === "select-model") {
      this.selectModel(dataset.model ?? "", dataset.provider);
    } else if (type === "select-effort") {
      this.selectEffort(dataset.effort ?? "");
    } else if (type === "select-fast-mode") {
      this.selectFastMode(dataset.fastMode === "true");
    } else if (type === "select-permission") {
      this.selectPermission(dataset.permissionMode ?? "", action);
    }
  }

  private browseProvider(provider: string) {
    if (!this.offeredModels().some((option) => option.provider === provider)) {
      return;
    }
    this.browsedProvider = provider;
    this.draw();
  }

  // Picking the model on show, or one of its settings, makes the reasoning and
  // speed shown with it the person's own. Identical effort names do not
  // establish equivalent settings on another model, so another model starts
  // from its own.
  private chooseModel(model: ModelOption) {
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

  private restorePermissionOptionFocus(
    control: HTMLButtonElement | null,
    permissionMode: string,
  ) {
    const popover = this.permissionPopover.value;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          !this.isConnected ||
          !popover ||
          !control ||
          this.permissionPopover.value !== popover ||
          !popover.matches(":popover-open") ||
          !popover.contains(control) ||
          control.dataset.turnOptionsAction !== "select-permission" ||
          control.dataset.permissionMode !== permissionMode ||
          control.disabled
        ) {
          return;
        }
        control.focus({ preventScroll: true });
      });
    });
  }

  // Any input the selection is worked out from may have changed: the list the
  // selection now needs is asked for, and the control and its owner catch up.
  private reconcile() {
    if (!this.isConnected) {
      return;
    }
    this.requestPermissionList();
    this.draw();
    this.emitChange();
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private emitChange() {
    this.dispatchEvent(
      new CustomEvent<TurnOptionsSnapshot>("caffold:task-turn-options-change", {
        bubbles: true,
        composed: true,
        detail: this.snapshot(),
      }),
    );
  }

  private async loadModels() {
    if (this.modelLoaded || this.modelLoading) {
      return;
    }
    this.startLoadingFeedback(this.modelLoadingFeedback);
    this.draw();
    await this.askForModels();
  }

  // An account switch or an agent update changes what the agents offer, so
  // opening the menu asks them again. The list on show stays until the answer
  // takes its place.
  private refreshModels() {
    if (this.modelLoaded && !this.modelLoading) {
      void this.askForModels();
    }
  }

  private async askForModels() {
    const requestId = ++this.modelRequestId;
    this.modelLoading = true;
    try {
      const response = await getAgentModels();
      if (requestId !== this.modelRequestId) {
        return;
      }
      this.modelOptions = modelOptions(response);
      this.unavailableAgents = unavailableAgents(response);
      this.modelError = null;
    } catch (error) {
      if (requestId !== this.modelRequestId) {
        return;
      }
      // An unreadable answer is not stood in for by the last list.
      this.modelOptions = [];
      this.unavailableAgents = [];
      this.modelError = error;
    } finally {
      if (requestId === this.modelRequestId) {
        this.modelLoading = false;
        this.modelLoaded = true;
        this.endLoadingFeedback(this.modelLoadingFeedback);
        this.reconcile();
      }
    }
  }

  private async loadPermissions(target: PermissionTarget) {
    const requestId = ++this.permissionRequestId;
    this.permissionRequest = target;
    this.startLoadingFeedback(this.permissionLoadingFeedback);
    this.draw();
    // Announced as it goes out, so an owner holding a submission for this list
    // stops before the list returns rather than after.
    this.emitChange();
    let list: PermissionList;
    try {
      const response = await getAgentPermissions(
        target.cwd,
        target.provider,
        target.model,
      );
      list = { target, ...permissionModes(response), error: null };
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
    this.reconcile();
  }

  // Feedback follows the list, not the request. A request superseded while
  // its list is still pending hands the count on rather than starting over;
  // only a settled list, a choice that needs none, or a disconnected control
  // ends it.
  private startLoadingFeedback(feedback: LoadingFeedback) {
    if (feedback.timer !== null || feedback.visible) {
      return;
    }
    feedback.timer = window.setTimeout(() => {
      feedback.timer = null;
      feedback.visible = true;
      this.draw();
    }, LOADING_DELAY_MS);
  }

  private endLoadingFeedback(feedback: LoadingFeedback) {
    window.clearTimeout(feedback.timer ?? undefined);
    feedback.timer = null;
    feedback.visible = false;
  }

  // The models on offer here: one agent's for an existing Task, every agent's
  // for one that does not exist yet.
  private offeredModels() {
    const provider = this.context.provider;
    if (!provider) {
      return this.modelOptions;
    }
    // An agent that could not be asked leaves its Task with no models rather
    // than with another agent's, which the conversation could not continue in.
    return this.modelOptions.filter((option) => option.provider === provider);
  }

  private selectedModel() {
    const offered = this.offeredModels();
    return (
      offered.find((option) => sameModel(option, this.choice.model)) ??
      rememberedModel(offered, this.context.initialSelection.model) ??
      offered.find((option) => option.isDefault) ??
      offered[0] ??
      null
    );
  }

  // Reasoning and speed belong to the model they were set on: a person's to
  // the model they picked, the remembered ones to the remembered model.
  private selectedEffort() {
    const model = this.selectedModel();
    const efforts = model?.supportedReasoningEfforts ?? [];
    const offered = (value: string | null | undefined) =>
      efforts.find((option) => option === value) ?? "";
    return (
      (sameModel(model, this.choice.model) && offered(this.choice.effort)) ||
      (this.isRememberedModel(model) &&
        offered(this.context.initialSelection.effort)) ||
      offered(model?.defaultReasoningEffort) ||
      efforts[0] ||
      ""
    );
  }

  private selectedFastMode() {
    const model = this.selectedModel();
    if (!model?.supportsFast) {
      return false;
    }
    if (sameModel(model, this.choice.model) && this.choice.fastMode !== null) {
      return this.choice.fastMode;
    }
    return (
      this.isRememberedModel(model) &&
      Boolean(this.context.initialSelection.fastMode)
    );
  }

  private isRememberedModel(model: ModelOption | null) {
    return Boolean(
      model &&
        rememberedModel(
          this.offeredModels(),
          this.context.initialSelection.model,
        ) === model,
    );
  }

  // The mode a turn would run under, from the list answered for the chosen
  // model: a person's pick, then what the Task or Section last ran under,
  // then the list's own default, passing over any mode the list withholds.
  private selectedPermission() {
    const list = this.answeredPermissionList();
    if (!list) {
      return null;
    }
    const allowed = (mode: string | null | undefined) =>
      list.options.find((option) => option.allowed && option.mode === mode);
    return (
      allowed(this.choice.permissionMode) ??
      allowed(this.context.initialSelection.permissionMode) ??
      allowed(list.defaultMode) ??
      list.options.find((option) => option.allowed) ??
      null
    );
  }

  // The list settled for the chosen model in this directory, answered or
  // refused; nothing while that list is still to come.
  private settledPermissionList() {
    const target = this.permissionTarget();
    return target && this.permissionList?.target.key === target.key
      ? this.permissionList
      : null;
  }

  private answeredPermissionList() {
    const list = this.settledPermissionList();
    return list && !list.error ? list : null;
  }

  private permissionTarget(): PermissionTarget | null {
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

  // A Task that already belongs to an agent cannot change a mode the catalog
  // says is taken only when the conversation starts. Whether that is so is
  // the agent's, not one model's, so the last list answered says so while
  // another model's list is on its way. A new Task has no provider yet, so
  // the same catalog still lets the mode be chosen.
  private permissionFixed() {
    return (
      Boolean(this.context.provider) &&
      Boolean(this.permissionList?.fixedWhenConversationStarts)
    );
  }

  // Why no model can be chosen once the model list has settled without one.
  private modelUnavailableReason() {
    if (this.modelError) {
      return errorMessage(this.modelError);
    }
    return (
      this.unavailableAgents.find(
        (agent) => agent.provider === this.context.provider,
      )?.message || "No agent offered a model."
    );
  }

  private constrainAnchoredPopover(popover: HTMLElement) {
    popover.style.maxHeight = "";
    if (
      this.context.placement !== "above" ||
      window.matchMedia("(max-width: 899px)").matches
    ) {
      return;
    }
    const button =
      popover === this.modelPopover.value
        ? this.modelButton.value
        : this.permissionButton.value;
    const boundary = closestAcrossShadowRoots(
      this,
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
}

function createChoice(): Choice {
  return {
    model: null,
    effort: null,
    fastMode: null,
    permissionMode: null,
  };
}

function createLoadingFeedback(): LoadingFeedback {
  return { timer: null, visible: false };
}

function hidePopover(popover: EventTarget | null | undefined) {
  if (popover instanceof HTMLElement && popover.matches(":popover-open")) {
    popover.hidePopover();
  }
}

function sameModel(
  option: ModelIdentity | null,
  identity: ModelIdentity | null,
) {
  return Boolean(
    option &&
      identity &&
      option.model === identity.model &&
      (!identity.provider || option.provider === identity.provider),
  );
}

// What a Task or Section remembers names a model but not the agent offering
// it, so the name counts only when exactly one agent offers a model by it.
function rememberedModel(offered: ModelOption[], model = "") {
  const name = model.trim();
  const matches = name ? offered.filter((option) => option.model === name) : [];
  return matches.length === 1 ? matches[0] : null;
}

function sameSelection(
  left: TurnOptionsSelection,
  right: TurnOptionsSelection,
) {
  return (
    (["model", "effort", "permissionMode"] as const).every(
      (key) => (left[key] ?? "") === (right[key] ?? ""),
    ) && Boolean(left.fastMode) === Boolean(right.fastMode)
  );
}

function errorMessage(error: unknown) {
  return (
    (error instanceof Error ? error.message.trim() : "") ||
    "The request failed."
  );
}

function modelOptions(response: AgentModels): ModelOption[] {
  return response.models.flatMap((model) => {
    const value = model.model.trim();
    const provider = model.provider.trim();
    return value && provider
      ? [
          {
            provider,
            model: value,
            displayName: model.displayName.trim(),
            isDefault: model.isDefault,
            defaultReasoningEffort: (model.defaultEffort ?? "").trim(),
            supportedReasoningEfforts: model.efforts
              .map((effort) => effort.trim())
              .filter(Boolean),
            supportsFast: model.supportsFastMode,
          },
        ]
      : [];
  });
}

function unavailableAgents(response: AgentModels): UnavailableAgent[] {
  return response.unavailable
    .map((agent) => ({
      provider: agent.provider.trim(),
      message: agent.message.trim(),
    }))
    .filter((agent) => agent.provider);
}

function permissionModes(response: AgentPermissionModes) {
  return {
    options: response.options.flatMap((option): PermissionOption[] => {
      const mode = option.mode.trim();
      return mode
        ? [
            {
              mode,
              label: option.label.trim(),
              description: option.description.trim(),
              allowed: option.allowed,
              unavailableReason: (
                option.unavailableReason ?? "This is not available here."
              ).trim(),
              dangerous: option.dangerous,
            },
          ]
        : [];
    }),
    defaultMode: response.defaultMode.trim(),
    fixedWhenConversationStarts: response.fixedWhenConversationStarts,
  };
}

function compactModelLabel(label: string) {
  return label
    .trim()
    .replace(/^GPT(?:-|\s)+/i, "")
    .replaceAll("-", " ");
}

// "model", "model and reasoning", "model, reasoning, and speed".
function listPhrase(parts: string[]) {
  if (parts.length < 2) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function buttonClasses(base: string, states: Record<string, boolean>) {
  return [
    base,
    ...Object.entries(states).flatMap(([name, on]) => (on ? [name] : [])),
  ].join(" ");
}

function modelSummary(model: {
  unavailable: boolean;
  name: string;
  effort: string;
  fast: boolean;
}) {
  if (model.unavailable) {
    return html`<span class="task-model-name">Unavailable</span>`;
  }
  return html`<span class="task-model-name">${model.name}</span>${
    model.effort
      ? html`<span class="task-model-effort"> · ${model.effort}</span>`
      : nothing
  }${
    model.fast
      ? html`<span class="task-model-fast" title="Fast mode">${inlineIcon(
          "Zap",
          "Fast mode",
          "task-model-fast-icon",
        )}</span>`
      : nothing
  }`;
}

function providerOption(
  provider: string,
  browsedProvider: string,
  hints: ActionHints,
) {
  const label = PROVIDER_LABELS[provider] ?? provider;
  return html`<button
    ${hints.button({
      id: `provider:${encodeURIComponent(provider)}`,
      label,
      action: ACTION_HINT_ACTION.MODEL_PROVIDER_BROWSE,
      badgeAtEnd: true,
    })}
    type="button"
    class="task-model-option task-provider-option"
    data-turn-options-action="browse-provider"
    data-provider=${provider}
    aria-pressed=${provider === browsedProvider ? "true" : "false"}
  ><span><strong>${label}</strong></span></button>`;
}

function modelOption(
  option: ModelOption,
  selectedModel: ModelOption | null,
  hints: ActionHints,
) {
  const selected =
    option.model === selectedModel?.model &&
    option.provider === selectedModel?.provider;
  const id = `${encodeURIComponent(option.provider)}:${encodeURIComponent(
    option.model,
  )}`;
  return html`<button
    ${hints.button({
      id: `model:${id}`,
      label: optionLabel(option.displayName, selected),
      action: ACTION_HINT_ACTION.MODEL_SELECT,
      badgeAtEnd: true,
    })}
    type="button"
    class="task-model-option"
    data-turn-options-action="select-model"
    data-provider=${option.provider}
    data-model=${option.model}
    aria-pressed=${selected ? "true" : "false"}
    ?autofocus=${selected}
  >
    <span><strong>${option.displayName}</strong></span>
    ${selected ? selectedCheck() : nothing}
  </button>`;
}

function modelSettings(
  model: ModelOption,
  effort: string,
  fastMode: boolean,
  hints: ActionHints,
) {
  const efforts = model.supportedReasoningEfforts;
  if (!efforts.length && !model.supportsFast) {
    return nothing;
  }
  return html`<hr>
    ${
      efforts.length
        ? html`<section aria-label="Reasoning level">
            <p>Reasoning level</p>
            <div class="task-model-setting-options">${repeat(
              efforts,
              (value) => value,
              (value) => reasoningOption(value, effort, hints),
            )}</div>
          </section>`
        : nothing
    }
    ${
      model.supportsFast
        ? html`<section aria-label="Speed">
            <p>Speed</p>
            <div class="task-model-setting-options">
              ${fastModeOption(false, fastMode, hints)}
              ${fastModeOption(true, fastMode, hints)}
            </div>
          </section>`
        : nothing
    }`;
}

function reasoningOption(
  value: string,
  selectedEffort: string,
  hints: ActionHints,
) {
  const selected = value === selectedEffort;
  return html`<button
    ${hints.button({
      id: `reasoning:${encodeURIComponent(value)}`,
      label: optionLabel(value, selected),
      action: ACTION_HINT_ACTION.REASONING_SELECT,
      badgeAtEnd: true,
    })}
    type="button"
    class="task-model-option"
    data-turn-options-action="select-effort"
    data-effort=${value}
    aria-pressed=${selected ? "true" : "false"}
  >
    <span><strong>${value}</strong></span>
    ${selected ? selectedCheck() : nothing}
  </button>`;
}

function fastModeOption(
  fastMode: boolean,
  selectedFastMode: boolean,
  hints: ActionHints,
) {
  const selected = fastMode === selectedFastMode;
  return html`<button
    ${hints.button({
      id: `speed:${fastMode}`,
      label: optionLabel(fastMode ? "Fast" : "Normal", selected),
      action: ACTION_HINT_ACTION.SPEED_SELECT,
      badgeAtEnd: true,
    })}
    type="button"
    class="task-model-option"
    data-turn-options-action="select-fast-mode"
    data-fast-mode=${fastMode ? "true" : "false"}
    aria-pressed=${selected ? "true" : "false"}
  >
    <span><strong>${fastMode ? "Fast" : "Normal"}</strong></span>
    ${selected ? selectedCheck() : nothing}
  </button>`;
}

function permissionOption(
  option: PermissionOption,
  selectedMode: string,
  hints: ActionHints,
) {
  const selected = option.mode === selectedMode;
  // Why a mode is withheld is the agent's to say; the interface only shows it.
  const unavailable = option.allowed ? "" : ` ${option.unavailableReason}`;
  const description = `${option.description}${unavailable}`;
  return html`<button
    ${hints.button({
      id: `permission:${encodeURIComponent(option.mode)}`,
      label: optionLabel(`${option.label} ${description}`, selected),
      action: ACTION_HINT_ACTION.PERMISSION_SELECT,
      badgeAtEnd: true,
    })}
    type="button"
    class=${`task-model-option task-permission-option${
      option.dangerous ? " is-dangerous" : ""
    }`}
    data-turn-options-action="select-permission"
    data-permission-mode=${option.mode}
    aria-pressed=${selected ? "true" : "false"}
    ?autofocus=${selected}
    ?disabled=${!option.allowed}
  >
    <span>
      <strong>${option.label}</strong>
      <small>${description}</small>
    </span>
    ${selected ? selectedCheck() : nothing}
  </button>`;
}

function selectedCheck() {
  return inlineIcon("Check", "Selected", "task-model-check");
}

// What an option says, the check on the chosen one included.
function optionLabel(text: string, selected: boolean) {
  return selected ? `${text} Selected` : text;
}

// A list that cannot be read is a failure to report, not a gap to fill; a
// reload asks again.
function modelFallback(reason: string) {
  if (!reason) {
    return html`<p class="task-model-note"><caffold-loading-text
        >Loading models...</caffold-loading-text
      ></p>`;
  }
  const message = `Models could not be loaded. ${reason} Reload the page to try again.`;
  return html`<p class="task-model-note">${message}</p>`;
}

function permissionBody(
  list: PermissionList | null,
  selected: PermissionOption | null,
  hints: ActionHints,
) {
  if (!list) {
    return html`<p class="task-model-note"><caffold-loading-text
        >Loading permission modes...</caffold-loading-text
      ></p>`;
  }
  if (list.error) {
    const message = `Permission modes could not be loaded. ${errorMessage(list.error)} Reload the page to try again.`;
    return html`<p class="task-model-note">${message}</p>`;
  }
  if (!list.options.length) {
    return html`<p class="task-model-note"
      >No approval mode is available here.</p
    >`;
  }
  return repeat(
    list.options,
    (option) => option.mode,
    (option) => permissionOption(option, selected?.mode ?? "", hints),
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
};

// A mode is named by the agent that offers it, and the agent sends a label
// with it. These are the shorter forms the compact control needs. A mode this
// does not recognize is a mode an agent added, and it keeps the agent's own
// label without Caffold shipping a line for it.
const COMPACT_PERMISSION_MODE_LABELS: Record<string, string> = {
  askForApproval: "Ask approval",
  approveForMe: "Auto review",
  fullAccess: "Full access",
};

// Copy for the catalog kind that a conversation-create choice cannot change.
// Grok is the agent that currently reports it.
const PERMISSION_FIXED_WHEN_CONVERSATION_STARTS =
  "Grok fixes the permission mode when the conversation starts; start a new Task to change it.";

function compactPermissionModeLabel(mode: string, label: string) {
  return COMPACT_PERMISSION_MODE_LABELS[mode] ?? (label || mode);
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-turn-options": CaffoldTaskTurnOptions;
  }

  interface HTMLElementEventMap {
    "caffold:task-turn-options-change": CustomEvent<TurnOptionsSnapshot>;
  }
}
