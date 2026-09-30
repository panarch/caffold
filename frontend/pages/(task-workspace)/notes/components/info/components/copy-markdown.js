import {
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

// Copy Markdown in the Note details popover. It puts the Note's content on the
// clipboard as the Markdown an agent wrote, and is off for an empty Note.
class CaffoldNotesInfoCopyMarkdown extends HTMLElement {
  constructor() {
    super();
    this.markdown = "";
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
  }

  disconnectedCallback() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
    this.invalidatePendingCopy();
  }

  // The Note the popover describes.
  setNote(note) {
    this.ensureDom();
    const markdown = `${note?.content ?? ""}`;
    if (this.markdown === markdown) {
      return;
    }
    this.markdown = markdown;
    // A copy in flight is of the earlier content, so its outcome is not this one's.
    this.invalidatePendingCopy();
  }

  handleClick(event) {
    const control = this.button();
    if (control && event.target.closest?.("button") === control) {
      void this.copy();
    }
  }

  async copy() {
    if (!this.markdown || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    this.patchPresentation();
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

  actionHintScope({ scopeId = "", clipRoots = [], isCurrent = () => true } = {}) {
    this.ensureDom();
    const control = this.button();
    const markdown = this.markdown;
    if (!scopeId || !this.connected || !isCopyActionable(control)) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:copy-markdown`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.textContent.trim(),
        control,
        clipRoots: [...clipRoots],
        badgeAtEnd: true,
        isActionable: () =>
          this.connected &&
          this.isConnected &&
          isCurrent() &&
          this.markdown === markdown &&
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
      <button type="button" class="notes-info-copy-markdown-button"></button>
      <span class="notes-info-copy-markdown-status sr-only" role="status" aria-live="polite" aria-atomic="true"></span>
    `;
    this.patchPresentation();
  }

  patchPresentation() {
    const control = this.button();
    const status = this.querySelector(":scope > .notes-info-copy-markdown-status");
    const feedback = copyFeedback(this.copyState);
    control.disabled = !this.markdown;
    control.setAttribute("aria-disabled", `${this.copyState === "copying"}`);
    control.dataset.copyState = this.copyState;
    control.textContent = feedback || "Copy Markdown";
    if (status.textContent !== feedback) {
      status.textContent = feedback;
    }
  }

  button() {
    return this.querySelector(":scope > .notes-info-copy-markdown-button");
  }
}

function isCopyActionable(control) {
  return Boolean(
    control &&
      !control.disabled &&
      control.getAttribute("aria-disabled") !== "true",
  );
}

function copyFeedback(state) {
  if (state === "copied") {
    return "Copied";
  }
  if (state === "failed") {
    return "Copy failed — retry";
  }
  return "";
}

customElements.define("caffold-notes-info-copy-markdown", CaffoldNotesInfoCopyMarkdown);
