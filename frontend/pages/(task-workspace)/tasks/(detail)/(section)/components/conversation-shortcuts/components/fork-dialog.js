import {
  createTaskFork,
  previewTaskForkSource,
} from "../../../../../../../../api.js";
import { formatDate } from "../../../../../task-format.js";

const CODEX_THREAD_URI_PREFIX = "codex://threads/";

class CaffoldConversationForkDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.context = { sectionId: "", sectionPath: "" };
    this.opener = null;
    this.preview = null;
    this.previewPending = false;
    this.forkPending = false;
    this.error = null;
    this.previewRequestId = 0;
    this.forkRequestId = 0;
    this.previewController = null;
    this.restoreFocus = true;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
    this.dialog().addEventListener("cancel", (event) => {
      if (this.forkPending) {
        event.preventDefault();
      }
    });
    this.addEventListener("input", (event) => {
      if (event.target === this.threadIdInput()) {
        this.invalidatePreview();
      }
    });
    this.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-fork-dialog-action]")
        ?.dataset.forkDialogAction;
      if (action === "cancel" && !this.forkPending) {
        this.abortPreview();
        this.dialog().close("cancel");
      } else if (action === "fork") {
        void this.forkTask();
      }
    });
    this.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.previewThread();
    });
  }

  disconnectedCallback() {
    if (this.initialized) {
      this.deactivate();
    }
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  threadIdInput() {
    return this.querySelector("#conversation-fork-thread-id");
  }

  open({ sectionId, sectionPath = "", opener } = {}) {
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
    this.threadIdInput().value = "";
    this.patch();

    const dialog = this.dialog();
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
    if (this.dialog()?.open) {
      this.dialog().close("cancel");
    }
  }

  async previewThread() {
    const sourceId = normalizeCodexThreadId(this.threadIdInput().value);
    if (this.previewPending || this.forkPending) {
      return;
    }
    if (!sourceId) {
      this.preview = null;
      this.error = new Error("Enter a Codex Thread ID.");
      this.patch();
      this.threadIdInput().focus();
      return;
    }

    this.abortPreview();
    const requestId = ++this.previewRequestId;
    const controller = new AbortController();
    this.previewController = controller;
    this.preview = null;
    this.previewPending = true;
    this.error = null;
    this.patch();
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
      this.patch();
    } catch (error) {
      if (requestId !== this.previewRequestId) {
        return;
      }
      this.previewPending = false;
      this.previewController = null;
      if (error?.name !== "AbortError") {
        this.error = error instanceof Error ? error : new Error(`${error}`);
      }
      this.patch();
    }
  }

  async forkTask() {
    if (this.forkPending || !this.canFork()) {
      return;
    }
    const sourceId = this.preview.sourceId;
    const sectionId = this.context.sectionId;
    const requestId = ++this.forkRequestId;
    this.abortPreview();
    this.forkPending = true;
    this.error = null;
    this.patch();
    try {
      const detail = await createTaskFork({
        provider: "codex",
        sourceId,
        sectionId,
      });
      if (requestId !== this.forkRequestId) {
        return;
      }
      if (
        !detail?.threadId ||
        detail.threadId === sourceId ||
        detail.activeTopPlacement?.section?.id !== sectionId
      ) {
        throw new Error("The forked Task did not match the requested conversation and Section.");
      }
      const handoff = { detail, submission: null, adopted: false };
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
      this.dialog().close("forked");
    } catch (error) {
      if (requestId !== this.forkRequestId) {
        return;
      }
      this.forkPending = false;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      if ([
        "task_fork_source_not_idle",
        "task_fork_source_changed",
        "task_fork_source_unresolved",
      ].includes(this.error.code)) {
        this.preview = null;
      }
      this.patch();
    }
  }

  invalidatePreview() {
    this.abortPreview();
    this.preview = null;
    this.error = null;
    this.patch();
  }

  abortPreview() {
    this.previewRequestId += 1;
    this.previewController?.abort();
    this.previewController = null;
    this.previewPending = false;
  }

  canFork() {
    return Boolean(
      this.preview &&
      this.preview.sourceId ===
        normalizeCodexThreadId(this.threadIdInput().value) &&
      canForkThreadStatus(this.preview.status),
    );
  }

  handleClose() {
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

  render() {
    this.innerHTML = `
      <dialog
        closedby="any"
        aria-labelledby="conversation-fork-title"
        aria-describedby="conversation-fork-description"
      >
        <form class="conversation-fork-card">
          <header>
            <h2 id="conversation-fork-title">Fork a Codex thread</h2>
            <p id="conversation-fork-description">
              Preview the source, then create a Task with its conversation history.
            </p>
          </header>
          <div class="conversation-fork-body">
            <dl class="conversation-fork-target">
              <div>
                <dt>Target Section</dt>
                <dd></dd>
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
                >
                <button
                  type="submit"
                  class="conversation-fork-button"
                  data-fork-dialog-action="preview"
                >Preview thread</button>
              </div>
            </div>
            <p class="conversation-fork-loading" role="status" hidden></p>
            <section class="conversation-fork-preview" aria-label="Thread preview" hidden>
              <dl class="conversation-fork-metadata">
                <div><dt>Provider</dt><dd data-fork-preview="provider"></dd></div>
                <div><dt>Name</dt><dd data-fork-preview="name"></dd></div>
                <div><dt>Status</dt><dd data-fork-preview="status"></dd></div>
                <div><dt>Last activity</dt><dd data-fork-preview="activity"></dd></div>
                <div><dt>Source project</dt><dd data-fork-preview="cwd"></dd></div>
              </dl>
              <div class="conversation-fork-summary" hidden>
                <h3>Summary</h3>
                <p></p>
              </div>
              <div class="conversation-fork-history">
                <h3>Recent history</h3>
                <div class="conversation-fork-history-list"></div>
              </div>
              <p class="conversation-fork-unavailable-reason" hidden></p>
            </section>
            <div class="conversation-fork-error" aria-live="assertive"></div>
          </div>
          <footer>
            <button
              type="button"
              class="conversation-fork-button"
              data-fork-dialog-action="cancel"
            >Cancel</button>
            <button
              type="button"
              class="conversation-fork-button is-primary"
              data-fork-dialog-action="fork"
              disabled
            >Fork task</button>
          </footer>
        </form>
      </dialog>
    `;
  }

  patch() {
    const dialog = this.dialog();
    const busy = this.previewPending || this.forkPending;
    dialog.setAttribute("aria-busy", busy ? "true" : "false");
    dialog.setAttribute("closedby", this.forkPending ? "none" : "any");
    this.querySelector(".conversation-fork-target dd").textContent =
      this.context.sectionPath.trim() || "Project root";

    const input = this.threadIdInput();
    input.disabled = this.forkPending;
    const previewButton = this.querySelector("[data-fork-dialog-action='preview']");
    previewButton.disabled =
      this.previewPending ||
      this.forkPending ||
      !normalizeCodexThreadId(input.value);
    previewButton.textContent = this.previewPending ? "Loading…" : "Preview thread";
    const cancelButton = this.querySelector("[data-fork-dialog-action='cancel']");
    cancelButton.disabled = this.forkPending;
    const forkButton = this.querySelector("[data-fork-dialog-action='fork']");
    forkButton.disabled = this.forkPending || !this.canFork();
    forkButton.textContent = this.forkPending ? "Forking…" : "Fork task";

    const loading = this.querySelector(".conversation-fork-loading");
    loading.hidden = !this.previewPending;
    loading.textContent = this.previewPending ? "Loading the Codex thread…" : "";
    this.patchPreview();

    const error = this.querySelector(".conversation-fork-error");
    error.replaceChildren();
    if (this.error) {
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = this.error.message;
      error.append(message);
    }
  }

  patchPreview() {
    const previewElement = this.querySelector(".conversation-fork-preview");
    previewElement.hidden = !this.preview;
    if (!this.preview) {
      return;
    }
    this.querySelector("[data-fork-preview='provider']").textContent = "Codex";
    this.querySelector("[data-fork-preview='name']").textContent =
      this.preview.displayName || "Unknown";
    this.querySelector("[data-fork-preview='status']").textContent =
      formatThreadStatus(this.preview.status);
    this.querySelector("[data-fork-preview='activity']").textContent =
      this.preview.lastActivityMs ? formatDate(this.preview.lastActivityMs) : "Unknown";
    this.querySelector("[data-fork-preview='cwd']").textContent =
      this.preview.cwd || "Unknown";

    const summary = this.querySelector(".conversation-fork-summary");
    summary.hidden = !this.preview.summary;
    summary.querySelector("p").textContent = this.preview.summary || "";
    this.patchHistory(this.preview.recentHistory);

    const reason = forkUnavailableReason(this.preview.status);
    const reasonElement = this.querySelector(".conversation-fork-unavailable-reason");
    reasonElement.hidden = !reason;
    reasonElement.textContent = reason;
  }

  patchHistory(history) {
    const list = this.querySelector(".conversation-fork-history-list");
    const messages = history.map((message) => {
      const article = document.createElement("article");
      article.dataset.role = message.role;
      const heading = document.createElement("h4");
      heading.textContent = {
        user: "You",
        assistant: "Codex",
        failure: "Failed",
      }[message.role] ?? "Conversation";
      const text = document.createElement("p");
      text.textContent = message.text;
      article.append(heading, text);
      return article;
    });
    if (!messages.length) {
      const empty = document.createElement("p");
      empty.className = "conversation-fork-history-empty";
      empty.textContent = "No recent user or Codex messages were available.";
      messages.push(empty);
    }
    list.replaceChildren(...messages);
  }
}

function normalizeCodexThreadId(value) {
  const input = `${value ?? ""}`.trim();
  return input.startsWith(CODEX_THREAD_URI_PREFIX)
    ? input.slice(CODEX_THREAD_URI_PREFIX.length).trim()
    : input;
}

function normalizePreview(preview, requestedSourceId) {
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
    lastActivityMs: preview.lastActivityMs != null &&
        Number.isFinite(Number(preview.lastActivityMs))
      ? Number(preview.lastActivityMs)
      : null,
    recentHistory: Array.isArray(preview.recentHistory)
      ? preview.recentHistory
        .filter((message) =>
          ["user", "assistant", "failure"].includes(message?.role) &&
          typeof message?.text === "string"
        )
        .map((message) => ({ role: message.role, text: message.text }))
      : [],
  };
}

function formatThreadStatus(status) {
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

function forkUnavailableReason(status) {
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

function canForkThreadStatus(status) {
  return status?.type === "idle" || status?.type === "notLoaded";
}

if (!customElements.get("caffold-conversation-fork-dialog")) {
  customElements.define(
    "caffold-conversation-fork-dialog",
    CaffoldConversationForkDialog,
  );
}
