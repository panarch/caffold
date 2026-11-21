import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import styles from "./copy-value.css.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

/**
 * Copy for one value in the Task details popover, such as the Thread ID or a
 * path, drawn as the icon alone at the end of the value's line.
 *
 * `label` names what is copied. The outcome shows on the icon for a moment;
 * a value that changes retires a copy still in flight.
 */
@customElement("caffold-task-detail-info-copy-value")
export class CaffoldTaskDetailInfoCopyValue extends CaffoldElement {
  @property({ attribute: false })
  accessor value = "";
  @property({ attribute: false })
  accessor label = "";
  @state()
  accessor copyState: CopyState = "idle";

  static override styles = styles;

  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly hints = new ActionHints(this);
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.invalidatePendingCopy();
  }

  // A copy in flight is of the earlier value, so its outcome is not this one's.
  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("value")) {
      this.invalidatePendingCopy();
    }
  }

  override render() {
    const presentation = copyPresentation(this.copyState, this.label);
    return html`
      <button
        ${this.hints.button({
          id: "copy",
          label: presentation.actionLabel,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          when: Boolean(this.value) && this.copyState !== "copying",
        })}
        type="button"
        class="task-detail-copy"
        aria-disabled=${this.copyState === "copying"}
        data-copy-state=${this.copyState}
        aria-label=${presentation.actionLabel}
        title=${presentation.actionLabel}
        @click=${this.copy}
      >
        <span class="task-detail-copy-icon">${inlineIcon(
          copyIcon(this.copyState),
          "",
          "task-detail-copy-svg",
        )}</span>
      </button>
      <span
        class="task-detail-copy-status sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >${presentation.feedback}</span>
    `;
  }

  async copy() {
    if (!this.value || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    try {
      await navigator.clipboard.writeText(this.value);
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

function copyPresentation(state: CopyState, label: string) {
  if (state === "copying") {
    return { actionLabel: `Copying ${label}`, feedback: "" };
  }
  if (state === "copied") {
    return { actionLabel: "Copied", feedback: "Copied" };
  }
  if (state === "failed") {
    return {
      actionLabel: `Copy failed. Retry copy ${label}`,
      feedback: "Copy failed",
    };
  }
  return { actionLabel: `Copy ${label}`, feedback: "" };
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-info-copy-value": CaffoldTaskDetailInfoCopyValue;
  }
}
