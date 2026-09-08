import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../../../../../../../action-hints.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

/**
 * Copy, for the one message that mounts it.
 *
 * The message hands over the text to place on the clipboard and nothing else.
 * The control, the outcome it reports, and the timer that clears that outcome
 * live here, so a message redrawing its Markdown cannot disturb a copy in
 * flight, and text arriving for a different message retires one.
 */
class CaffoldTaskAssistantMessageCopyButton extends HTMLElement {
  constructor() {
    super();
    this.text = "";
    this.copyState = "idle";
    this.generation = 0;
    this.feedbackTimer = null;
    this.boundClick = (event) => this.handleClick(event);
  }

  connectedCallback() {
    this.ensureDom();
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.addEventListener("click", this.boundClick);
    void warmIcons().then(() => {
      if (this.connected) {
        this.patchPresentation();
      }
    });
  }

  disconnectedCallback() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
    this.invalidatePendingCopy();
  }

  /** What this control puts on the clipboard, as its message holds it. */
  setText(text) {
    const next = `${text ?? ""}`;
    if (this.text === next) {
      return;
    }
    this.text = next;
    // A copy in flight is of the earlier text, so its outcome is not this one's.
    this.invalidatePendingCopy();
  }

  handleClick(event) {
    const control = this.button();
    if (control && event.target.closest?.("button") === control) {
      void this.copy();
    }
  }

  async copy() {
    if (!this.text || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    this.patchPresentation();
    try {
      await navigator.clipboard.writeText(this.text);
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
    this.patchPresentation();
    this.feedbackTimer = window.setTimeout(() => {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.feedbackTimer = null;
      this.copyState = "idle";
      this.patchPresentation();
    }, COPY_FEEDBACK_DURATION_MS);
  }

  acceptsCompletion(generation) {
    return this.generation === generation && this.connected && this.isConnected;
  }

  invalidatePendingCopy() {
    this.generation += 1;
    this.clearFeedback();
    this.copyState = "idle";
    if (this.initialized) {
      this.patchPresentation();
    }
  }

  clearFeedback() {
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureDom();
    const control = this.button();
    if (
      !scopeId ||
      !control ||
      !this.connected ||
      this.hidden ||
      !isCopyActionable(control)
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:copy`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.title ||
          "Copy message",
        control,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.connected &&
          this.isConnected &&
          !this.hidden &&
          this.button() === control &&
          isCopyActionable(control),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  ensureDom() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.innerHTML = `
      <button type="button" class="task-assistant-message-copy" data-message-action="copy">
        <span class="task-assistant-message-copy-icon"></span>
      </button>
      <span class="task-assistant-message-copy-status" role="status" aria-live="polite" aria-atomic="true"></span>
    `;
    this.patchPresentation();
  }

  patchPresentation() {
    const control = this.button();
    const status = this.querySelector(
      ":scope > .task-assistant-message-copy-status",
    );
    const presentation = copyPresentation(this.copyState);
    control.setAttribute("aria-disabled", `${this.copyState === "copying"}`);
    control.dataset.copyState = this.copyState;
    control.setAttribute("aria-label", presentation.actionLabel);
    control.title = presentation.actionLabel;
    if (status.textContent !== presentation.feedback) {
      status.textContent = presentation.feedback;
    }
    if (presentation.tone) {
      status.dataset.feedback = presentation.tone;
    } else {
      delete status.dataset.feedback;
    }
    control.querySelector(
      ":scope > .task-assistant-message-copy-icon",
    ).innerHTML = renderInlineIcon(
      copyIcon(this.copyState),
      "",
      "task-assistant-message-copy-icon-svg",
    );
  }

  button() {
    return this.querySelector(
      ':scope > button[data-message-action="copy"]',
    );
  }
}

function isCopyActionable(control) {
  return (
    !control.disabled &&
    control.getAttribute("aria-disabled") !== "true" &&
    hasActionHintLayoutBox(control)
  );
}

function copyPresentation(state) {
  if (state === "copying") {
    return { actionLabel: "Copying message", feedback: "", tone: "" };
  }
  if (state === "copied") {
    return { actionLabel: "Copied", feedback: "Copied", tone: "success" };
  }
  if (state === "failed") {
    return {
      actionLabel: "Copy failed. Retry copy message",
      feedback: "Copy failed — retry",
      tone: "danger",
    };
  }
  return { actionLabel: "Copy message", feedback: "", tone: "" };
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

if (!customElements.get("caffold-task-assistant-message-copy-button")) {
  customElements.define(
    "caffold-task-assistant-message-copy-button",
    CaffoldTaskAssistantMessageCopyButton,
  );
}
