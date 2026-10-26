import { html, LitElement, type PropertyValues } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { Note } from "#app/api.ts";

const COPY_FEEDBACK_DURATION_MS = 1_800;

type CopyState = "idle" | "copying" | "copied" | "failed";

// Copy path in the Note details popover. It puts the names of the directories
// that hold the Note, the Note's own name, and its id on the clipboard, so a
// person can tell an agent exactly which Note they mean.
export class CaffoldNotesInfoCopyPath extends LitElement {
  static properties = {
    note: { attribute: false },
    copyState: { state: true },
  };

  declare note: Note | null;
  declare copyState: CopyState;
  private path = "";
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

  // A copy in flight is of the earlier path, so its outcome is not this one's.
  willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("note")) {
      return;
    }
    const path = this.note ? copiedPath(this.note) : "";
    if (path !== this.path) {
      this.path = path;
      this.invalidatePendingCopy();
    }
  }

  render() {
    const feedback = copyFeedback(this.copyState);
    return html`
      <button
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

  actionHintScope({
    scopeId = "",
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const control = this.button;
    const path = this.path;
    if (
      !scopeId ||
      !this.isConnected ||
      !path ||
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
          id: `${scopeId}:copy-path`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: (control.textContent ?? "").trim(),
          control,
          clipRoots: [...clipRoots],
          badgeAtEnd: true,
          isActionable: () =>
            this.isConnected &&
            isCurrent() &&
            this.path === path &&
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
      ":scope > .notes-info-copy-path-button",
    );
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

function isCopyActionable(control: Element) {
  return control.getAttribute("aria-disabled") !== "true";
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

customElements.define("caffold-notes-info-copy-path", CaffoldNotesInfoCopyPath);
