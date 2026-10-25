import { html, LitElement, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { Note } from "#app/api.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

// Copy Markdown in the Note details popover. It puts the Note's content on the
// clipboard as the Markdown an agent wrote, and is off for an empty Note.
export class CaffoldNotesInfoCopyMarkdown extends LitElement {
  static properties = {
    note: { attribute: false },
    copyState: { state: true },
  };

  declare note: Note | null;
  declare copyState: CopyState;
  private markdown = "";
  private generation = 0;
  private feedbackTimer: number | undefined;

  constructor() {
    super();
    this.note = null;
    this.copyState = "idle";
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.invalidatePendingCopy();
  }

  // A copy in flight is of the earlier content, so its outcome is not this
  // one's.
  willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("note")) {
      return;
    }
    const markdown = `${this.note?.content ?? ""}`;
    if (markdown !== this.markdown) {
      this.markdown = markdown;
      this.invalidatePendingCopy();
    }
  }

  render() {
    const feedback = copyFeedback(this.copyState);
    return html`
      <button
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

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const control = this.button;
    const markdown = this.markdown;
    if (
      !scopeId ||
      !this.isConnected ||
      !control ||
      !isCopyActionable(control)
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:copy-markdown`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: (control.textContent ?? "").trim(),
          control,
          clipRoots: [...clipRoots],
          badgeAtEnd: true,
          isActionable: () =>
            this.isConnected &&
            isCurrent() &&
            this.markdown === markdown &&
            this.button === control &&
            isCopyActionable(control),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
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

  private get button() {
    return this.querySelector<HTMLButtonElement>(
      ":scope > .notes-info-copy-markdown-button",
    );
  }
}

function isCopyActionable(control: HTMLButtonElement) {
  return !control.disabled && control.getAttribute("aria-disabled") !== "true";
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

customElements.define(
  "caffold-notes-info-copy-markdown",
  CaffoldNotesInfoCopyMarkdown,
);
