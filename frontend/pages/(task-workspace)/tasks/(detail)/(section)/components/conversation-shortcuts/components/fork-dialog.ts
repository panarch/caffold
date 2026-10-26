import { html, LitElement, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  textboxActionHintTarget,
} from "#app/action-hints.js";
import {
  createTaskFork,
  previewTaskForkSource,
  type TaskForkSourcePreview,
  type TaskResponseError,
  type TaskThreadStatus,
} from "#app/api.ts";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import "#components/loading-text.ts";
import { formatDate } from "#tasks/task-format.ts";

const CODEX_THREAD_URI_PREFIX = "codex://threads/";
const DESCRIPTION =
  "Preview the source, then create a Task with its conversation history.";
const NO_HISTORY = "No recent user or Codex messages were available.";
const HISTORY_ROLES = new Set(["user", "assistant", "failure"]);
const HISTORY_HEADINGS: Record<string, string> = {
  user: "You",
  assistant: "Codex",
  failure: "Failed",
};
// A fork the server refused because the source moved on: its preview no
// longer says what would be forked.
const STALE_SOURCE_CODES = [
  "task_fork_source_not_idle",
  "task_fork_source_changed",
  "task_fork_source_unresolved",
];

/**
 * Starts a Task in a Section from a Codex thread: the person names the
 * thread, previews it, and forks it.
 *
 * The Section's conversation shortcuts open it and read its keyboard context
 * right after, so it draws at once wherever its state changes.
 */
export class CaffoldConversationForkDialog extends LitElement {
  private context = { sectionId: "", sectionPath: "" };
  private opener: HTMLElement | null = null;
  private threadIdText = "";
  private preview: TaskForkSourcePreview | null = null;
  private previewPending = false;
  private forkPending = false;
  private error: TaskResponseError | null = null;
  private previewRequestId = 0;
  private forkRequestId = 0;
  private previewController: AbortController | null = null;
  private restoreFocus = true;

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  keyboardNavigationContexts() {
    this.performUpdate();
    const dialog = this.dialog;
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog || !hintDialog || !hud || !selector) {
      return [];
    }
    const sectionId = this.context.sectionId;
    return [
      keyboardNavigationContext({
        id: sectionId
          ? `conversation-fork:${encodeURIComponent(sectionId)}`
          : "conversation-fork",
        kind: "modal",
        root: dialog,
        actionHints: {
          dialog: hintDialog,
          scope: this.actionHintScope(),
        },
        scroll: {
          hud,
          selector,
          scope: this.scrollSurfaceScope(),
        },
        editing: {
          escapeTarget: (editable: Element) =>
            editable === this.threadIdInput
              ? dialog.querySelector<HTMLElement>(
                  "[data-fork-dialog-action='cancel']",
                )
              : null,
        },
      }),
    ];
  }

  private actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const body = dialog?.querySelector(".conversation-fork-body") ?? null;
    const input = this.threadIdInput;
    const sectionId = this.context.sectionId;
    if (!dialog || !input) {
      return emptyActionHintScope();
    }
    const current = () =>
      this.isConnected &&
      this.dialog === dialog &&
      dialog.open &&
      this.context.sectionId === sectionId &&
      Boolean(sectionId);
    const inputTarget = textboxActionHintTarget({
      invalidationOwner: this,
      id: `conversation-fork:${encodeURIComponent(sectionId)}:thread-id`,
      actionId: ACTION_HINT_ACTION.DIALOG_TEXTBOX_FOCUS,
      label: "Focus Thread ID",
      control: input,
      clipRoots: body ? [dialog, body] : [dialog],
      isActionable: () =>
        current() && this.threadIdInput === input && !input.disabled,
    });
    const buttons = ["preview", "cancel", "fork"].flatMap((action) => {
      const control = dialog.querySelector<HTMLButtonElement>(
        `[data-fork-dialog-action="${action}"]`,
      );
      if (!control) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `conversation-fork:${encodeURIComponent(sectionId)}:${action}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || action,
          control,
          clipRoots: action === "preview" && body ? [dialog, body] : [dialog],
          isActionable: () =>
            current() &&
            dialog.querySelector(`[data-fork-dialog-action="${action}"]`) ===
              control &&
            !control.disabled,
        }),
      ];
    });
    return {
      blocked: false,
      targets: [inputTarget, ...buttons],
      mutationRoots: [this],
      scrollRoots: body ? [body] : [],
    };
  }

  private scrollSurfaceScope(): ScrollSurfaceScope {
    const dialog = this.dialog;
    const scrollport = dialog?.querySelector(".conversation-fork-body");
    const sectionId = this.context.sectionId;
    if (!dialog || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `conversation-fork:${encodeURIComponent(sectionId)}:preview`,
          label: "Fork preview",
          scrollport,
          clipRoots: [dialog, scrollport],
          isEligible: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            this.context.sectionId === sectionId &&
            Boolean(sectionId) &&
            dialog.querySelector(".conversation-fork-body") === scrollport &&
            hasScrollLayoutBox(dialog) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
  }

  open({
    sectionId,
    sectionPath = "",
    opener,
  }: {
    sectionId?: string | null;
    sectionPath?: string | null;
    opener?: Element | null;
  } = {}) {
    const normalizedSectionId = `${sectionId ?? ""}`.trim();
    if (!normalizedSectionId || this.forkPending) {
      return false;
    }
    this.abortPreview();
    this.context = {
      sectionId: normalizedSectionId,
      sectionPath: `${sectionPath ?? ""}`,
    };
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.preview = null;
    this.previewPending = false;
    this.error = null;
    this.restoreFocus = true;
    this.threadIdText = "";
    this.draw();

    const dialog = this.dialog;
    if (!dialog) {
      return false;
    }
    dialog.returnValue = "";
    if (!dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  deactivate() {
    this.restoreFocus = false;
    this.abortPreview();
    this.forkRequestId += 1;
    this.forkPending = false;
    this.error = null;
    if (this.dialog?.open) {
      this.dialog.close("cancel");
    }
  }

  render() {
    const busy = this.previewPending || this.forkPending;
    // While no preview is shown its section is hidden and reads as empty.
    const preview = this.preview;
    const status = preview ? threadStatusLabel(preview.status) : "";
    const activity = preview?.lastActivityMs
      ? formatDate(preview.lastActivityMs)
      : "Unknown";
    const history = preview?.recentHistory ?? [];
    const unavailable = preview ? forkUnavailableReason(preview.status) : "";
    return html`
      <dialog
        closedby=${this.forkPending ? "none" : "any"}
        aria-busy=${busy ? "true" : "false"}
        aria-labelledby="conversation-fork-title"
        aria-describedby="conversation-fork-description"
        @close=${this.handleClose}
        @cancel=${this.handleCancel}
      >
        <form class="conversation-fork-card" @submit=${this.handleSubmit}>
          <header>
            <h2 id="conversation-fork-title">Fork a Codex thread</h2>
            <p id="conversation-fork-description">${DESCRIPTION}</p>
          </header>
          <div class="conversation-fork-body">
            <dl class="conversation-fork-target">
              <div>
                <dt>Target Section</dt>
                <dd>${this.context.sectionPath.trim() || "Project root"}</dd>
              </div>
            </dl>
            <div class="conversation-fork-source-control">
              <label for="conversation-fork-thread-id">Thread ID</label>
              <div>
                <input
                  id="conversation-fork-thread-id"
                  name="threadId"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  autofocus
                  .value=${live(this.threadIdText)}
                  ?disabled=${this.forkPending}
                  @input=${this.threadIdChanged}
                >
                <button
                  type="submit"
                  class="conversation-fork-button"
                  data-fork-dialog-action="preview"
                  ?disabled=${
                    busy || !normalizeCodexThreadId(this.threadIdText)
                  }
                >${this.previewPending ? "Loading…" : "Preview thread"}</button>
              </div>
            </div>
            <caffold-loading-text
              class="conversation-fork-loading"
              ?hidden=${!this.previewPending}
            >Loading the Codex thread…</caffold-loading-text>
            <section
              class="conversation-fork-preview"
              aria-label="Thread preview"
              ?hidden=${!preview}
            >
              <dl class="conversation-fork-metadata">
                <div>
                  <dt>Provider</dt>
                  <dd data-fork-preview="provider">Codex</dd>
                </div>
                <div>
                  <dt>Name</dt>
                  <dd data-fork-preview="name">${
                    preview?.displayName || "Unknown"
                  }</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd data-fork-preview="status">${status}</dd>
                </div>
                <div>
                  <dt>Last activity</dt>
                  <dd data-fork-preview="activity">${activity}</dd>
                </div>
                <div>
                  <dt>Source project</dt>
                  <dd data-fork-preview="cwd">${preview?.cwd || "Unknown"}</dd>
                </div>
              </dl>
              <div
                class="conversation-fork-summary"
                ?hidden=${!preview?.summary}
              >
                <h3>Summary</h3>
                <p>${preview?.summary || ""}</p>
              </div>
              <div class="conversation-fork-history">
                <h3>Recent history</h3>
                <div class="conversation-fork-history-list">${
                  history.length
                    ? history.map(
                        (message) => html`<article data-role=${message.role}
                          ><h4>${
                            HISTORY_HEADINGS[message.role] ?? "Conversation"
                          }</h4
                          ><p>${message.text}</p></article
                        >`,
                      )
                    : html`<p class="conversation-fork-history-empty"
                        >${NO_HISTORY}</p
                      >`
                }</div>
              </div>
              <p
                class="conversation-fork-unavailable-reason"
                ?hidden=${!unavailable}
              >${unavailable}</p>
            </section>
            <div class="conversation-fork-error" aria-live="assertive">${
              this.error
                ? html`<p role="alert">${this.error.message}</p>`
                : nothing
            }</div>
          </div>
          <footer>
            <button
              type="button"
              class="conversation-fork-button"
              data-fork-dialog-action="cancel"
              ?disabled=${this.forkPending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              type="button"
              class="conversation-fork-button is-primary"
              data-fork-dialog-action="fork"
              ?disabled=${this.forkPending || !this.canFork()}
              @click=${this.forkTask}
            >${this.forkPending ? "Forking…" : "Fork task"}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private async previewThread() {
    const sourceId = normalizeCodexThreadId(this.threadIdText);
    if (this.previewPending || this.forkPending) {
      return;
    }
    if (!sourceId) {
      this.preview = null;
      this.error = new Error("Enter a Codex Thread ID.");
      this.draw();
      this.threadIdInput?.focus();
      return;
    }

    this.abortPreview();
    const requestId = ++this.previewRequestId;
    const controller = new AbortController();
    this.previewController = controller;
    this.preview = null;
    this.previewPending = true;
    this.error = null;
    this.draw();
    try {
      const preview = await previewTaskForkSource(
        { provider: "codex", sourceId },
        controller.signal,
      );
      if (requestId !== this.previewRequestId) {
        return;
      }
      this.preview = normalizePreview(preview, sourceId);
      this.previewPending = false;
      this.previewController = null;
      this.draw();
    } catch (error) {
      if (requestId !== this.previewRequestId) {
        return;
      }
      this.previewPending = false;
      this.previewController = null;
      if ((error as Error | null)?.name !== "AbortError") {
        this.error = error instanceof Error ? error : new Error(`${error}`);
      }
      this.draw();
    }
  }

  private async forkTask() {
    const preview = this.preview;
    if (this.forkPending || !preview || !this.canFork()) {
      return;
    }
    const sourceId = preview.sourceId;
    const sectionId = this.context.sectionId;
    const requestId = ++this.forkRequestId;
    this.abortPreview();
    this.forkPending = true;
    this.error = null;
    this.draw();
    try {
      const created = await createTaskFork({
        provider: "codex",
        sourceId,
        sectionId,
      });
      if (requestId !== this.forkRequestId) {
        return;
      }
      const childThreadId = created?.detail?.threadId;
      if (
        !childThreadId ||
        childThreadId === sourceId ||
        created.activeTopPlacement?.section?.id !== sectionId
      ) {
        throw new Error(
          "The forked Task did not match the requested conversation and Section.",
        );
      }
      const handoff = { created, submission: null, adopted: false };
      this.dispatchEvent(
        new CustomEvent("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error("The forked Task could not be opened.");
      }
      if (requestId !== this.forkRequestId) {
        return;
      }
      this.forkPending = false;
      this.dialog?.close("forked");
    } catch (error) {
      if (requestId !== this.forkRequestId) {
        return;
      }
      this.forkPending = false;
      const failure: TaskResponseError =
        error instanceof Error ? error : new Error(`${error}`);
      this.error = failure;
      if (STALE_SOURCE_CODES.includes(`${failure.code}`)) {
        this.preview = null;
      }
      this.draw();
    }
  }

  private threadIdChanged(event: Event) {
    this.threadIdText = (event.currentTarget as HTMLInputElement).value;
    this.abortPreview();
    this.preview = null;
    this.error = null;
    this.draw();
  }

  private handleSubmit(event: Event) {
    event.preventDefault();
    void this.previewThread();
  }

  private cancel() {
    if (this.forkPending) {
      return;
    }
    this.abortPreview();
    this.dialog?.close("cancel");
  }

  // A fork under way cannot be dismissed.
  private handleCancel(event: Event) {
    if (this.forkPending) {
      event.preventDefault();
    }
  }

  private abortPreview() {
    this.previewRequestId += 1;
    this.previewController?.abort();
    this.previewController = null;
    this.previewPending = false;
  }

  private canFork() {
    return Boolean(
      this.preview &&
        this.preview.sourceId === normalizeCodexThreadId(this.threadIdText) &&
        canForkThreadStatus(this.preview.status),
    );
  }

  private handleClose() {
    if (this.forkPending) {
      return;
    }
    this.abortPreview();
    const opener = this.opener;
    const restoreFocus = this.restoreFocus;
    this.opener = null;
    this.restoreFocus = true;
    if (restoreFocus && opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  private get dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }

  private get threadIdInput() {
    return this.querySelector<HTMLInputElement>("#conversation-fork-thread-id");
  }
}

customElements.define(
  "caffold-conversation-fork-dialog",
  CaffoldConversationForkDialog,
);

function normalizeCodexThreadId(value: string | null | undefined) {
  const input = `${value ?? ""}`.trim();
  return input.startsWith(CODEX_THREAD_URI_PREFIX)
    ? input.slice(CODEX_THREAD_URI_PREFIX.length).trim()
    : input;
}

// The preview as this dialog shows it, from an answer that must be for the
// thread it asked about.
function normalizePreview(
  preview: TaskForkSourcePreview | null | undefined,
  requestedSourceId: string,
): TaskForkSourcePreview {
  if (
    preview?.provider !== "codex" ||
    `${preview?.sourceId ?? ""}` !== requestedSourceId ||
    !preview?.status?.type
  ) {
    throw new Error("Codex returned an invalid thread preview.");
  }
  return {
    provider: "codex",
    sourceId: requestedSourceId,
    displayName: `${preview.displayName ?? ""}`,
    summary: preview.summary == null ? null : `${preview.summary}`,
    status: { ...preview.status },
    cwd: preview.cwd == null ? null : `${preview.cwd}`,
    lastActivityMs:
      preview.lastActivityMs != null &&
      Number.isFinite(Number(preview.lastActivityMs))
        ? Number(preview.lastActivityMs)
        : null,
    recentHistory: Array.isArray(preview.recentHistory)
      ? preview.recentHistory
          .filter(
            (message) =>
              HISTORY_ROLES.has(message?.role) &&
              typeof message?.text === "string",
          )
          .map((message) => ({ role: message.role, text: message.text }))
      : [],
  };
}

function threadStatusLabel(status: TaskThreadStatus) {
  if (status?.type === "idle") {
    return "Idle";
  }
  if (status?.type === "notLoaded") {
    return "Live status unavailable";
  }
  if (status?.type === "active") {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes("waitingOnApproval")) {
      return "Waiting for approval";
    }
    if (flags.includes("waitingOnUserInput")) {
      return "Waiting for input";
    }
    return "Active";
  }
  if (status?.type === "systemError") {
    return "System error";
  }
  return "Unknown";
}

function forkUnavailableReason(status: TaskThreadStatus) {
  if (canForkThreadStatus(status)) {
    return "";
  }
  if (status?.type === "active") {
    return "Forking is unavailable while the Codex thread is active.";
  }
  if (status?.type === "systemError") {
    return "Codex reported a system error for this thread.";
  }
  return "Codex reported a thread status that Caffold cannot fork.";
}

function canForkThreadStatus(status: TaskThreadStatus) {
  return status?.type === "idle" || status?.type === "notLoaded";
}
