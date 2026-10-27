import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import {
  forgetTaskPermissionInstructions,
  getTaskPermissionInstructions,
} from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { formatDate } from "#tasks/task-format.js";

const EMPTY_MESSAGE =
  "Nothing yet. A prompt that says what this Task may or may not do is kept here while it runs under Ask Jev first.";
const CLOSE_LABEL = "Close what this Task settled";

// What a request about the record tells the Task screen when it fails: the
// conversation decides what the failure says about the Task itself.
export interface TaskRequestFailedIntent {
  type: "task-request-failed";
  threadId: string;
  error: unknown;
}

interface RecordState {
  loading: boolean;
  instructions: string | null;
  error: string;
}

/**
 * What this Task's own prompts settled, for a person to read and to forget.
 *
 * The record grows with the conversation, so it is read here rather than in the
 * Task details popover it opens from: a popover is for the facts that fit
 * beside it, and this is a page of the person's own sentences.
 */
@customElement("caffold-task-permission-instructions-dialog")
export class CaffoldTaskPermissionInstructionsDialog extends LitElement {
  @state()
  private accessor threadId = "";
  @state()
  private accessor state: RecordState = {
    loading: false,
    instructions: null,
    error: "",
  };

  private opener: HTMLElement | null = null;
  private request = 0;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.request += 1;
  }

  open({ threadId, opener }: { threadId: string; opener?: Element | null }) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.threadId = threadId;
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    void this.load();
  }

  setThreadId(threadId: string) {
    if (this.threadId && this.threadId !== threadId) {
      this.dismiss();
    }
    this.threadId = threadId;
  }

  // Leaving the Task does not return focus to a conversation that is no longer
  // the one in front of the user.
  dismiss() {
    this.opener = null;
    this.request += 1;
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  // The record scrolls with nothing of its own, so Scroll mode here moves
  // nothing behind the dialog.
  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
      scroll: () => emptyScrollSurfaceScope(),
    });
  }

  override render() {
    const { loading, error } = this.state;
    const instructions = loading
      ? ""
      : `${this.state.instructions ?? ""}`.trim();
    const message = loading
      ? "Reading..."
      : instructions
        ? inReadersTime(instructions)
        : EMPTY_MESSAGE;
    const closeIcon = inlineIcon(
      "X",
      CLOSE_LABEL,
      "task-permission-instructions-close-icon",
    );
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: this.threadId
          ? `task-permission-instructions:${encodeURIComponent(this.threadId)}`
          : "task-permission-instructions",
      })}
      closedby="any"
      aria-labelledby="task-permission-instructions-title"
      @close=${this.handleClose}
    >
      <article class="task-permission-instructions-card">
        <header class="task-permission-instructions-header">
          <h2
            id="task-permission-instructions-title"
            class="task-permission-instructions-title"
          >What this Task's prompts settled</h2>
          <form
            method="dialog"
            class="task-permission-instructions-close-form"
          >
            <button
              ${this.hints.button({
                id: "close",
                label: CLOSE_LABEL,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="task-permission-instructions-close"
              aria-label=${CLOSE_LABEL}
              title=${CLOSE_LABEL}
            >${closeIcon}</button>
          </form>
        </header>
        <p class="task-permission-instructions-note">
          Your own messages, oldest first. A later one overrides an earlier one
          it contradicts. Jev reads these before your extra rules when it
          answers a permission request for this Task, whether they allow
          something or refuse it.
        </p>
        <div class="task-permission-instructions-body">
          <pre
            class="task-permission-instructions-text"
            data-empty=${String(!instructions)}
          >${message}</pre>
        </div>
        <p
          class="task-permission-instructions-error"
          role="alert"
          ?hidden=${!error}
        >${error}</p>
        <footer class="task-permission-instructions-footer">
          <button
            ${this.hints.button({
              id: "forget",
              label: "Forget what this Task settled",
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="button"
            class="task-secondary-button"
            data-permission-instructions-action="forget"
            ?disabled=${loading || !instructions}
            @click=${this.forget}
          >Forget these</button>
        </footer>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private async load() {
    const threadId = this.threadId;
    if (!threadId) {
      return;
    }
    const request = ++this.request;
    this.state = { loading: true, instructions: null, error: "" };
    try {
      const payload = await getTaskPermissionInstructions(threadId);
      if (this.isCurrent(request, threadId)) {
        this.state = {
          loading: false,
          instructions: instructionsOf(payload),
          error: "",
        };
      }
    } catch (error) {
      if (this.isCurrent(request, threadId)) {
        this.state = {
          loading: false,
          instructions: null,
          error: messageOf(
            error,
            "Caffold could not read what this Task settled.",
          ),
        };
        this.reportRequestFailure(threadId, error);
      }
    }
  }

  private async forget() {
    const threadId = this.threadId;
    if (!threadId) {
      return;
    }
    const request = ++this.request;
    this.state = { ...this.state, loading: true, error: "" };
    try {
      const payload = await forgetTaskPermissionInstructions(threadId);
      if (this.isCurrent(request, threadId)) {
        this.state = {
          loading: false,
          instructions: instructionsOf(payload),
          error: "",
        };
      }
    } catch (error) {
      if (this.isCurrent(request, threadId)) {
        this.state = {
          ...this.state,
          loading: false,
          error: messageOf(
            error,
            "Caffold could not forget what this Task settled.",
          ),
        };
        this.reportRequestFailure(threadId, error);
      }
    }
  }

  private reportRequestFailure(threadId: string, error: unknown) {
    this.dispatchEvent(
      new CustomEvent<TaskRequestFailedIntent>("caffold:task-detail-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "task-request-failed", threadId, error },
      }),
    );
  }

  private isCurrent(request: number, threadId: string) {
    return (
      this.isConnected &&
      request === this.request &&
      this.threadId === threadId &&
      Boolean(this.dialog.value?.open)
    );
  }

  private handleClose() {
    if (this.dialog.value?.open) {
      return;
    }
    this.request += 1;
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }
}

/**
 * The record stamps each entry in UTC, which is what Jev reads and what the
 * store keeps. A person reads it where they are, so the stamp is rewritten for
 * the browser and nothing else about the entry is touched.
 */
function inReadersTime(instructions: string) {
  return instructions.replace(
    /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC\]$/gm,
    (stamp, year, month, day, hour, minute) => {
      const when = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
      );
      const local = formatDate(when);
      return local ? `[${local}]` : stamp;
    },
  );
}

function instructionsOf(payload: { instructions?: string | null } | null) {
  const instructions = payload?.instructions;
  return typeof instructions === "string" ? instructions : null;
}

function messageOf(error: unknown, fallback: string) {
  return (error as { message?: string } | null)?.message ?? fallback;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-permission-instructions-dialog": CaffoldTaskPermissionInstructionsDialog;
  }
}
