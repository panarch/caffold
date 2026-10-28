import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { Note } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./copy-path.css.js";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

// Copy path in the Note details popover. It puts the names of the directories
// that hold the Note, the Note's own name, and its id on the clipboard, so a
// person can tell an agent exactly which Note they mean.
@customElement("caffold-notes-info-copy-path")
export class CaffoldNotesInfoCopyPath extends CaffoldElement {
  @property({ attribute: false })
  accessor note: Note | null = null;
  @state()
  accessor copyState: CopyState = "idle";

  static override styles = styles;

  private path = "";
  private generation = 0;
  private feedbackTimer: number | undefined;
  private readonly hints = new ActionHints(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.invalidatePendingCopy();
  }

  // A copy in flight is of the earlier path, so its outcome is not this one's.
  override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("note")) {
      return;
    }
    const path = this.note ? copiedPath(this.note) : "";
    if (path !== this.path) {
      this.path = path;
      this.invalidatePendingCopy();
    }
  }

  override render() {
    const feedback = copyFeedback(this.copyState);
    return html`
      <button
        ${this.hints.button({
          id: "copy-path",
          label: feedback || "Copy path",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          badgeAtEnd: true,
          when: Boolean(this.path) && this.copyState !== "copying",
        })}
        type="button"
        class="notes-info-copy-path-button"
        aria-disabled=${this.copyState === "copying"}
        data-copy-state=${this.copyState}
        @click=${this.copy}
      >${feedback || "Copy path"}</button>
      <span
        class="notes-info-copy-path-status sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >${feedback}</span>
    `;
  }

  async copy() {
    if (!this.path || this.copyState === "copying") {
      return;
    }

    this.clearFeedback();
    const generation = this.generation;
    this.copyState = "copying";
    try {
      await navigator.clipboard.writeText(this.path);
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

// The names are joined the way the line under the Note header joins the
// directories. The id is what an agent's Notes tools read the Note by, and it
// tells apart Notes that share a name.
function copiedPath(note: Note) {
  const names = [
    ...(note.location ?? []).map((directory) => directory.name),
    note.name,
  ];
  return `${names.join(" / ")} (note id: ${note.id})`;
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
    "caffold-notes-info-copy-path": CaffoldNotesInfoCopyPath;
  }
}
