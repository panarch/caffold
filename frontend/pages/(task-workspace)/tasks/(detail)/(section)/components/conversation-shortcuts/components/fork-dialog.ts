import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import {
  type CreatedTask,
  createTaskFork,
  previewTaskForkSource,
  type TaskForkSourcePreview,
  type TaskResponseError,
  type TaskThreadStatus,
} from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#components/loading-text.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { TaskCreatedHandoff } from "#tasks/layout.js";
import { formatDate } from "#tasks/task-format.js";

import styles from "./fork-dialog.css.js";

const PROVIDERS = { codex: "Codex", claude: "Claude", grok: "Grok" } as const;
type ForkProvider = keyof typeof PROVIDERS;
type ForkNode = "closed" | "editing" | "previewing" | "ready" | "forking";
type ForkEvent =
  | "open"
  | "edit"
  | "preview"
  | "previewed"
  | "fork"
  | "failed"
  | "closed"
  | "deactivate";
// See PLAN's control graph. There is no edit, dismiss or duplicate submit
// edge while creation is in flight; deactivation invalidates its completion.
const FORK_EDGES: Record<ForkNode, Partial<Record<ForkEvent, ForkNode>>> = {
  closed: { open: "editing", closed: "closed", deactivate: "closed" },
  editing: {
    open: "editing",
    edit: "editing",
    preview: "previewing",
    closed: "closed",
    deactivate: "closed",
  },
  previewing: {
    open: "editing",
    edit: "editing",
    previewed: "ready",
    failed: "editing",
    closed: "closed",
    deactivate: "closed",
  },
  ready: {
    open: "editing",
    edit: "editing",
    preview: "previewing",
    fork: "forking",
    closed: "closed",
    deactivate: "closed",
  },
  forking: { failed: "ready", closed: "closed", deactivate: "closed" },
};

const CODEX_THREAD_URI_PREFIX = "codex://threads/";
const DESCRIPTION =
  "Preview the source, then create a Task with its conversation history.";
const NO_HISTORY = "No recent conversation messages were available.";
const HISTORY_ROLES = new Set(["user", "assistant", "failure"]);
const HISTORY_HEADINGS: Record<string, string> = {
  user: "You",
  assistant: "Agent",
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
 * Starts a Task in a Section from a native conversation. Provider selection
 * identifies the source; it never converts history to another provider.
 */
@customElement("caffold-conversation-fork-dialog")
export class CaffoldConversationForkDialog extends CaffoldElement {
  @state()
  private accessor context: { sectionId: string; sectionPath: string } = {
    sectionId: "",
    sectionPath: "",
  };
  @state()
  private accessor threadIdText = "";
  @state()
  private accessor preview: TaskForkSourcePreview | null = null;
  @state()
  private accessor node: ForkNode = "closed";
  @state()
  private accessor provider: ForkProvider = "codex";
  @state()
  private accessor created: CreatedTask | null = null;
  @state()
  private accessor createdTaskId = "";
  @state()
  private accessor error: TaskResponseError | null = null;

  static override styles = styles;

  private get previewPending() {
    return this.node === "previewing";
  }
  private get forkPending() {
    return this.node === "forking";
  }
  private get sourceId() {
    return this.provider === "codex"
      ? normalizeCodexThreadId(this.threadIdText)
      : this.threadIdText.trim();
  }
  private get idLabel() {
    return this.provider === "codex" ? "Thread ID" : "Session ID";
  }
  private get forkLabel() {
    return this.forkPending
      ? "Forking…"
      : this.created
        ? "Open forked task"
        : "Fork task";
  }

  // The sole writer of control state; request identities and provider status
  // remain separate data. Callers carry the effects of accepted edges.
  private move(event: ForkEvent) {
    const next = FORK_EDGES[this.node][event];
    if (!next) return false;
    this.node = next;
    return true;
  }

  private opener: HTMLElement | null = null;
  private previewRequestId = 0;
  private forkRequestId = 0;
  private previewController: AbortController | null = null;
  private restoreFocus = true;
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly modal = new DrawnRef<HTMLDialogElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly threadIdInput = new DrawnRef<HTMLInputElement>(this);
  private readonly cancelButton = new DrawnRef<HTMLButtonElement>(this);

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
      scroll: (pull) => this.surfaces.scope(pull),
      editing: {
        // Escape in the Thread ID cancels rather than closing the dialog.
        escapeTarget: (editable: Element) =>
          editable === this.threadIdInput.value
            ? (this.cancelButton.value ?? null)
            : null,
      },
    });
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
    this.move("open");
    this.created = null;
    this.createdTaskId = "";
    this.error = null;
    this.restoreFocus = true;
    this.threadIdText = "";

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
    this.move("deactivate");
    this.created = null;
    this.createdTaskId = "";
    this.error = null;
    if (this.dialog?.open) {
      this.dialog.close("cancel");
    }
  }

  override render() {
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
        ${drawn(this.modal)}
        ${this.keyboard.modal({
          id: `conversation-fork:${encodeURIComponent(this.context.sectionId)}`,
          when: Boolean(this.context.sectionId),
        })}
        closedby=${this.forkPending ? "none" : "any"}
        aria-busy=${busy ? "true" : "false"}
        aria-labelledby="conversation-fork-title"
        aria-describedby="conversation-fork-description"
        @close=${this.handleClose}
        @cancel=${this.handleCancel}
      >
        <form class="conversation-fork-card" @submit=${this.handleSubmit}>
          <header>
            <h2 id="conversation-fork-title">Fork a conversation</h2>
            <p id="conversation-fork-description">${DESCRIPTION}</p>
          </header>
          <div
            ${drawn(this.body)}
            ${this.surfaces.surface({
              id: "preview",
              label: () => "Fork preview",
              clipRoots: () => [this.body.value],
            })}
            class="conversation-fork-body"
          >
            <dl class="conversation-fork-target">
              <div>
                <dt>Target Section</dt>
                <dd>${this.context.sectionPath.trim() || "Project root"}</dd>
              </div>
            </dl>
            <div class="conversation-fork-source-control">
              <label for="conversation-fork-provider">Agent</label>
              <select
                ${this.hints.select({ id: "provider", label: "Choose source agent", action: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN, clipRoots: () => [this.body.value] })}
                id="conversation-fork-provider"
                .value=${live(this.provider)}
                ?disabled=${this.forkPending || Boolean(this.created || this.createdTaskId)}
                @change=${this.providerChanged}
              >${Object.entries(PROVIDERS).map(([id, label]) => html`<option value=${id}>${label}</option>`)}</select>
            </div>
            <div class="conversation-fork-source-control">
              <label for="conversation-fork-thread-id">${this.idLabel}</label>
              <div>
                <input
                  ${drawn(this.threadIdInput)}
                  ${this.hints.textbox({
                    id: "thread-id",
                    label: `Focus ${this.idLabel}`,
                    action: ACTION_HINT_ACTION.DIALOG_TEXTBOX_FOCUS,
                    clipRoots: () => [this.body.value],
                  })}
                  id="conversation-fork-thread-id"
                  name="threadId"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  autofocus
                  .value=${live(this.threadIdText)}
                  ?disabled=${this.forkPending || Boolean(this.created || this.createdTaskId)}
                  placeholder=${this.provider === "codex" ? "Thread ID or codex://threads/…" : "Session UUID"}
                  @input=${this.threadIdChanged}
                >
                <button
                  ${this.hints.button({
                    id: "preview",
                    label: this.previewPending
                      ? "Loading…"
                      : "Preview conversation",
                    action: ACTION_HINT_ACTION.DIALOG_BUTTON,
                    clipRoots: () => [this.body.value],
                  })}
                  type="submit"
                  class="conversation-fork-button"
                  data-fork-dialog-action="preview"
                  ?disabled=${busy || Boolean(this.created || this.createdTaskId) || !this.sourceId}
                >${this.previewPending ? "Loading…" : "Preview conversation"}</button>
              </div>
            </div>
            <caffold-loading-text
              class="conversation-fork-loading"
              ?hidden=${!this.previewPending}
            >Loading the conversation…</caffold-loading-text>
            <section
              class="conversation-fork-preview"
              aria-label="Conversation preview"
              ?hidden=${!preview}
            >
              <dl class="conversation-fork-metadata">
                <div>
                  <dt>Provider</dt>
                  <dd data-fork-preview="provider">${PROVIDERS[this.provider]}</dd>
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
                            message.role === "assistant"
                              ? PROVIDERS[this.provider]
                              : (HISTORY_HEADINGS[message.role] ??
                                "Conversation")
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
                ? html`<p role="alert">${this.error.message}</p>
                    ${
                      this.error.createdTaskId
                        ? html`<a
                      ${this.hints.link({ id: "open-created", label: "Open forked task", action: ACTION_HINT_ACTION.LINK_OPEN })}
                      href=${`/tasks/${encodeURIComponent(this.error.createdTaskId)}`}
                    >Open forked task</a>`
                        : nothing
                    }`
                : nothing
            }</div>
          </div>
          <footer>
            <button
              ${drawn(this.cancelButton)}
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="button"
              class="conversation-fork-button"
              data-fork-dialog-action="cancel"
              ?disabled=${this.forkPending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "fork",
                label: this.forkLabel,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="button"
              class="conversation-fork-button is-primary"
              data-fork-dialog-action="fork"
              ?disabled=${this.forkPending || !this.canFork()}
              @click=${this.forkTask}
            >${this.forkLabel}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private async previewThread() {
    const sourceId = this.sourceId;
    const provider = this.provider;
    if (
      this.created ||
      this.createdTaskId ||
      this.previewPending ||
      this.forkPending
    ) {
      return;
    }
    if (!sourceId) {
      this.preview = null;
      this.error = new Error(
        `Enter a ${PROVIDERS[this.provider]} ${this.idLabel}.`,
      );
      this.threadIdInput.value?.focus();
      return;
    }

    this.abortPreview();
    const requestId = ++this.previewRequestId;
    const controller = new AbortController();
    this.previewController = controller;
    this.preview = null;
    if (!this.move("preview")) return;
    this.error = null;
    try {
      const preview = await previewTaskForkSource(
        { provider, sourceId },
        controller.signal,
      );
      if (requestId !== this.previewRequestId) {
        return;
      }
      this.preview = normalizePreview(preview, provider, sourceId);
      this.move("previewed");
      this.previewController = null;
    } catch (error) {
      if (requestId !== this.previewRequestId) {
        return;
      }
      this.move("failed");
      this.previewController = null;
      if ((error as Error | null)?.name !== "AbortError") {
        this.error = error instanceof Error ? error : new Error(`${error}`);
      }
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
    if (!this.move("fork")) return;
    this.error = null;
    try {
      const created =
        this.created ??
        (await createTaskFork({
          provider: this.provider,
          sourceId,
          sectionId,
        }));
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
      this.created = created;
      const handoff = { created, submission: null, adopted: false };
      this.dispatchEvent(
        new CustomEvent<TaskCreatedHandoff>("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error(
          "The forked Task was created but could not be opened. Retry to open the same Task.",
        );
      }
      if (requestId !== this.forkRequestId) {
        return;
      }
      this.move("closed");
      this.dialog?.close("forked");
    } catch (error) {
      if (requestId !== this.forkRequestId) {
        return;
      }
      this.move("failed");
      const failure: TaskResponseError =
        error instanceof Error ? error : new Error(`${error}`);
      this.error = failure;
      this.createdTaskId = failure.createdTaskId ?? this.createdTaskId;
      if (
        !this.created &&
        (!failure.status || STALE_SOURCE_CODES.includes(`${failure.code}`))
      ) {
        this.move("edit");
        this.preview = null;
        if (!failure.status)
          this.error = new Error(
            "The fork result could not be confirmed. Check the Task list before trying again.",
          );
      }
    }
  }

  private providerChanged(event: Event) {
    if (this.created || this.createdTaskId || !this.move("edit")) return;
    const provider = (event.currentTarget as HTMLSelectElement).value;
    if (!(provider in PROVIDERS)) return;
    this.provider = provider as ForkProvider;
    this.abortPreview();
    this.preview = null;
    this.error = null;
  }

  private threadIdChanged(event: Event) {
    if (this.created || this.createdTaskId || !this.move("edit")) return;
    this.threadIdText = (event.currentTarget as HTMLInputElement).value;
    this.abortPreview();
    this.preview = null;
    this.error = null;
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
  }

  private canFork() {
    return Boolean(
      this.node === "ready" &&
        !this.createdTaskId &&
        this.preview &&
        this.preview.provider === this.provider &&
        this.preview.sourceId === this.sourceId &&
        canForkThreadStatus(this.preview.status),
    );
  }

  private handleClose() {
    if (this.forkPending) {
      return;
    }
    this.move("closed");
    this.abortPreview();
    const opener = this.opener;
    const restoreFocus = this.restoreFocus;
    this.opener = null;
    this.restoreFocus = true;
    if (restoreFocus && opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  private get dialog() {
    return this.modal.value;
  }
}

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
  requestedProvider: ForkProvider,
  requestedSourceId: string,
): TaskForkSourcePreview {
  if (
    preview?.provider !== requestedProvider ||
    `${preview?.sourceId ?? ""}` !== requestedSourceId ||
    !preview?.status?.type
  ) {
    throw new Error("The agent returned an invalid conversation preview.");
  }
  return {
    provider: requestedProvider,
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
    return "Forking is unavailable while the conversation is active.";
  }
  if (status?.type === "systemError") {
    return "The agent reported a system error for this conversation.";
  }
  return "The agent reported a conversation status that Caffold cannot fork.";
}

function canForkThreadStatus(status: TaskThreadStatus) {
  return status?.type === "idle" || status?.type === "notLoaded";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-conversation-fork-dialog": CaffoldConversationForkDialog;
  }
}
