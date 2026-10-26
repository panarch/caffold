import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

/**
 * Copy, for the one message that mounts it.
 *
 * The message hands over the text to place on the clipboard and nothing else.
 * The control, the outcome it reports, and the timer that clears that outcome
 * live here, so a message redrawing its Markdown cannot disturb a copy in
 * flight, and text arriving for a different message retires one.
 */
export class CaffoldTaskAssistantMessageCopyButton extends LitElement {
  static properties = {
    text: { attribute: false },
    copyState: { state: true },
  };

  declare text: string;
  declare copyState: CopyState;
  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, () => this.performUpdate(), {
    clipRoots: () => [this],
  });

  constructor() {
    super();
    this.text = "";
    this.copyState = "idle";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.invalidatePendingCopy();
  }

  // A copy in flight is of the earlier text, so its outcome is not this one's.
  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("text")) {
      this.invalidatePendingCopy();
    }
  }

  render() {
    const presentation = copyPresentation(this.copyState);
    return html`
      <button
        ${this.hints.button({
          id: "copy",
          label: presentation.actionLabel,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          when: this.copyState !== "copying",
        })}
        type="button"
        class="task-assistant-message-copy"
        data-message-action="copy"
        aria-disabled=${this.copyState === "copying"}
        data-copy-state=${this.copyState}
        aria-label=${presentation.actionLabel}
        title=${presentation.actionLabel}
        @click=${this.copy}
      >
        <span class="task-assistant-message-copy-icon">${inlineIcon(
          copyIcon(this.copyState),
          "",
          "task-assistant-message-copy-icon-svg",
        )}</span>
      </button>
      <span
        class="task-assistant-message-copy-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-feedback=${presentation.tone || nothing}
      >${presentation.feedback}</span>
    `;
  }

  async copy() {
    if (!this.text || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
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
    this.feedbackTimer = window.setTimeout(() => {
      if (!this.acceptsCompletion(generation)) {
        return;
      }
      this.feedbackTimer = undefined;
      this.copyState = "idle";
    }, COPY_FEEDBACK_DURATION_MS);
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private acceptsCompletion(generation: number) {
    return this.generation === generation && this.isConnected;
  }

  private invalidatePendingCopy() {
    this.generation += 1;
    this.clearFeedback();
    this.copyState = "idle";
  }

  private clearFeedback() {
    window.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
  }
}

function copyPresentation(state: CopyState) {
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

function copyIcon(state: CopyState) {
  if (state === "copied") {
    return "Check";
  }
  if (state === "failed") {
    return "TriangleAlert";
  }
  return "Copy";
}

customElements.define(
  "caffold-task-assistant-message-copy-button",
  CaffoldTaskAssistantMessageCopyButton,
);
