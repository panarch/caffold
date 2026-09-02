import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../../../../../../../scroll-scope.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

class CaffoldTaskMarkdownCodeBlock extends HTMLElement {
  constructor() {
    super();
    this.copyState = "idle";
    this.feedbackTimer = null;
    this.generation = 0;
    this.label = "Plain text";
    this.savedScrollLeft = 0;
    this.preserveLayout = (mutation) => mutation();
    this.boundClick = (event) => this.handleClick(event);
  }

  connectedCallback() {
    this.ensureDom();
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.addEventListener("click", this.boundClick);
    const generation = this.generation;
    void warmIcons().then(() => {
      if (this.connected && this.generation === generation) {
        this.refreshIcons();
      }
    });
    this.refreshIcons();
  }

  disconnectedCallback() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
    this.invalidatePendingCopy();
  }

  ensureDom() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.innerHTML = `
      <header class="code-block-header">
        <span class="code-block-label"></span>
        <span class="code-block-status" role="status" aria-live="polite" aria-atomic="true"></span>
        <div class="code-block-actions">
          ${codeActionButton("wrap", "Wrap code lines", "WrapText")}
          ${codeActionButton("copy", "Copy code", "Copy")}
        </div>
      </header>
      <div class="code-block-content"></div>
    `;
  }

  setContent(pre, { label = "Plain text", preserveLayout } = {}) {
    this.ensureDom();
    this.invalidatePendingCopy();
    this.label = `${label}`;
    this.preserveLayout = preserveLayout ?? ((mutation) => mutation());
    this.savedScrollLeft = 0;
    this.dataset.codeWrap = "off";
    this.querySelector(":scope > .code-block-content").replaceChildren(pre);
    patchWrapButton(this.wrapButton(), false);
    this.patchCopyPresentation();
  }

  handleClick(event) {
    const action = event.target.closest?.("button[data-code-action]");
    if (!action || !this.contains(action)) {
      return;
    }
    if (action.dataset.codeAction === "wrap") {
      this.toggleWrap();
      return;
    }
    if (action.dataset.codeAction === "copy") {
      void this.copyCode();
    }
  }

  toggleWrap() {
    const pre = this.pre();
    const button = this.wrapButton();
    if (!pre || !button) {
      return;
    }
    const wrapped = this.dataset.codeWrap === "on";
    this.preserveLayout(() => {
      if (wrapped) {
        this.dataset.codeWrap = "off";
        pre.scrollLeft = this.savedScrollLeft;
      } else {
        this.savedScrollLeft = pre.scrollLeft;
        this.dataset.codeWrap = "on";
      }
      patchWrapButton(button, !wrapped);
    });
  }

  async copyCode() {
    const code = this.code();
    if (!code || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    this.patchCopyPresentation();
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.copyState = "copied";
    } catch {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.copyState = "failed";
    }
    this.patchCopyPresentation();
    this.feedbackTimer = window.setTimeout(() => {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.feedbackTimer = null;
      this.copyState = "idle";
      this.patchCopyPresentation();
    }, COPY_FEEDBACK_DURATION_MS);
  }

  acceptsCompletion(generation) {
    return this.generation === generation && this.connected && this.isConnected;
  }

  invalidatePendingCopy() {
    this.generation += 1;
    this.clearFeedback();
    this.copyState = "idle";
    this.patchCopyPresentation();
  }

  clearFeedback() {
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
  }

  patchCopyPresentation() {
    const button = this.copyButton();
    const label = this.querySelector(":scope > .code-block-header > .code-block-label");
    const status = this.querySelector(":scope > .code-block-header > .code-block-status");
    const presentation = copyPresentation(this.copyState);
    button.setAttribute("aria-disabled", `${this.copyState === "copying"}`);
    button.dataset.copyState = this.copyState;
    button.setAttribute("aria-label", presentation.actionLabel);
    button.title = presentation.actionLabel;
    label.textContent = presentation.feedback || this.label;
    label.title = presentation.feedback || this.label;
    label.dataset.feedback = presentation.tone;
    status.textContent = presentation.feedback;
    patchActionIcon(button, copyIcon(this.copyState));
  }

  refreshIcons() {
    patchActionIcon(this.wrapButton(), "WrapText");
    patchActionIcon(this.copyButton(), copyIcon(this.copyState));
  }

  pre() {
    return this.querySelector(":scope > .code-block-content > pre");
  }

  code() {
    return this.querySelector(":scope > .code-block-content > pre > code");
  }

  wrapButton() {
    return this.querySelector('button[data-code-action="wrap"]');
  }

  copyButton() {
    return this.querySelector('button[data-code-action="copy"]');
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureDom();
    if (!scopeId || !this.connected || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = ["wrap", "copy"].flatMap((action) => {
      const selector = `button[data-code-action="${action}"]`;
      const control = this.querySelector(selector);
      if (
        !control ||
        control.disabled ||
        control.getAttribute("aria-disabled") === "true"
      ) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${scopeId}:${action}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.title ||
          (action === "wrap" ? "Wrap code lines" : "Copy code"),
        control,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.connected &&
          this.isConnected &&
          !this.hidden &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          control.getAttribute("aria-disabled") !== "true",
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "Code block",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.pre();
    if (!scopeId || !label || !scrollport || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        axes: ["horizontal"],
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.connected &&
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.pre() === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }
}

function codeActionButton(action, label, icon) {
  const pressed = action === "wrap" ? ' aria-pressed="false"' : "";
  return `
    <button type="button" data-code-action="${action}" aria-label="${label}" title="${label}"${pressed}>
      <span class="code-block-action-icon">
        ${renderInlineIcon(icon, "", "code-block-action-icon-svg")}
      </span>
    </button>
  `;
}

function patchWrapButton(button, wrapped) {
  const label = wrapped ? "Stop wrapping code lines" : "Wrap code lines";
  button.setAttribute("aria-pressed", `${wrapped}`);
  button.setAttribute("aria-label", label);
  button.title = label;
}

function copyPresentation(state) {
  if (state === "copying") {
    return { actionLabel: "Copying code", feedback: "", tone: "" };
  }
  if (state === "copied") {
    return { actionLabel: "Copied", feedback: "Copied", tone: "success" };
  }
  if (state === "failed") {
    return {
      actionLabel: "Copy failed. Retry copy code",
      feedback: "Copy failed — retry",
      tone: "danger",
    };
  }
  return { actionLabel: "Copy code", feedback: "", tone: "" };
}

function copyIcon(state) {
  if (state === "copied") {
    return "Check";
  }
  if (state === "failed") {
    return "TriangleAlert";
  }
  return "Copy";
}

function patchActionIcon(button, icon) {
  const slot = button.querySelector(":scope > .code-block-action-icon");
  if (slot) {
    slot.innerHTML = renderInlineIcon(icon, "", "code-block-action-icon-svg");
  }
}

if (!customElements.get("caffold-task-markdown-code-block")) {
  customElements.define(
    "caffold-task-markdown-code-block",
    CaffoldTaskMarkdownCodeBlock,
  );
}
