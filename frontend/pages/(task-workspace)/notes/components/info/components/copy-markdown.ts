import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { Note } from "#app/api.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

// Copy Markdown in the Note details popover. It puts the Note's content on the
// clipboard as the Markdown an agent wrote, and is off for an empty Note.
@customElement("caffold-notes-info-copy-markdown")
export class CaffoldNotesInfoCopyMarkdown extends LitElement {
  @property({ attribute: false })
  accessor note: Note | null = null;
  @state()
  accessor copyState: CopyState = "idle";

  private markdown = "";
  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.invalidatePendingCopy();
  }

  // A copy in flight is of the earlier content, so its outcome is not this
  // one's.
  override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("note")) {
      return;
    }
    const markdown = `${this.note?.content ?? ""}`;
    if (markdown !== this.markdown) {
      this.markdown = markdown;
      this.invalidatePendingCopy();
    }
  }

  override render() {
    const feedback = copyFeedback(this.copyState);
    return html`
      <button
        ${this.hints.button({
          id: "copy-markdown",
          label: feedback || "Copy Markdown",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          badgeAtEnd: true,
          when: this.copyState !== "copying",
        })}
        type="button"
        class="notes-info-copy-markdown-button"
        ?disabled=${!this.note?.content}
        aria-disabled=${this.copyState === "copying"}
        data-copy-state=${this.copyState}
        @click=${this.copy}
      >${feedback || "Copy Markdown"}</button>
      <span
        class="notes-info-copy-markdown-status sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >${feedback}</span>
    `;
  }

  async copy() {
    if (!this.markdown || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    try {
      await navigator.clipboard.writeText(this.markdown);
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

function copyFeedback(state: CopyState) {
  if (state === "copied") {
    return "Copied";
  }
  if (state === "failed") {
    return "Copy failed — retry";
  }
  return "";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-notes-info-copy-markdown": CaffoldNotesInfoCopyMarkdown;
  }
}
