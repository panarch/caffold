import { createTask } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { taskStoreBlocksTaskOperations } from "../../codex-status.js";
import { cleanLogicalPath } from "../task-format.js";
import "./composer.js";

class CaffoldTaskCreate extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener(
      "caffold:task-composer-intent",
      this.boundComposerIntent,
    );
    this.addEventListener(
      "caffold:task-composer-submit",
      this.boundComposerSubmit,
    );
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
  }

  disconnectedCallback() {
    this.removeEventListener(
      "caffold:task-composer-intent",
      this.boundComposerIntent,
    );
    this.removeEventListener(
      "caffold:task-composer-submit",
      this.boundComposerSubmit,
    );
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.cancelActiveSubmission();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.cwd = ".";
    this.browseCwd = true;
    this.composerSettings = null;
    this.transportAvailable = true;
    this.taskOperationsBlocked = false;
    this.error = null;
    this.renderedStatus = null;
    this.requestGeneration = 0;
    this.activeSubmissionId = "";
    this.boundComposerIntent = (event) => this.handleComposerIntent(event);
    this.boundComposerSubmit = (event) => {
      void this.handleComposerSubmit(event);
    };
    this.boundIconsReady = () => {
      // The error card gains its icon once the icon set loads, which the key
      // below cannot see.
      this.renderedStatus = null;
      this.renderStatus();
    };
    warmIcons();
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > caffold-task-composer")) {
      return;
    }
    this.innerHTML = `
      <div class="task-create-status-region"></div>
      <caffold-task-composer></caffold-task-composer>
    `;
    this.renderedStatus = null;
    this.renderStatus();
    this.syncComposer();
  }

  setContext({
    cwd = this.cwd,
    browseCwd = this.browseCwd,
    composerSettings = this.composerSettings,
  } = {}) {
    this.ensureState();
    const nextCwd = cleanLogicalPath(cwd || ".");
    const nextBrowseCwd = Boolean(browseCwd);
    const nextComposerSettings = normalizeComposerSettings(composerSettings);
    const changed =
      this.cwd !== nextCwd ||
      this.browseCwd !== nextBrowseCwd ||
      JSON.stringify(this.composerSettings) !== JSON.stringify(nextComposerSettings);
    this.cwd = nextCwd;
    this.browseCwd = nextBrowseCwd;
    this.composerSettings = nextComposerSettings;
    this.ensureRendered();
    if (changed) {
      this.error = null;
    }
    this.renderStatus();
    this.syncComposer();
    return changed;
  }

  activate({ autofocus = false } = {}) {
    this.ensureRendered();
    this.hidden = false;
    this.renderStatus();
    this.syncComposer();
    if (autofocus) {
      this.composer()?.focus();
    }
  }

  deactivate() {
    this.composer()?.endEditingLifetime();
  }

  reset() {
    this.ensureState();
    this.cancelActiveSubmission();
    this.error = null;
    this.composer()?.endEditingLifetime();
    this.renderStatus();
    this.syncComposer();
  }

  setTransportAvailable(available) {
    this.ensureState();
    const next = Boolean(available);
    if (this.transportAvailable === next) {
      return;
    }
    this.transportAvailable = next;
    this.syncComposer();
  }

  setCodexStatusSnapshot(snapshot) {
    this.ensureState();
    // Only the store gates creating — it is shared by every agent. Codex
    // being unready costs the picker its Codex models and nothing more.
    const blocked = taskStoreBlocksTaskOperations(snapshot?.status);
    if (this.taskOperationsBlocked === blocked) {
      return;
    }
    this.taskOperationsBlocked = blocked;
    this.syncComposer();
  }

  selectedContextPath() {
    this.ensureState();
    return cleanLogicalPath(this.cwd);
  }

  composer() {
    return this.querySelector(":scope > caffold-task-composer");
  }

  handleComposerIntent(event) {
    if (event.target !== this.composer()) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type !== "browse-cwd" || !this.browseCwd) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-create-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "browse-cwd" },
      }),
    );
  }

  async handleComposerSubmit(event) {
    if (event.target !== this.composer()) {
      return;
    }
    event.stopPropagation();
    const submissionId = `${event.detail?.submissionId ?? ""}`;
    if (!submissionId || this.activeSubmissionId) {
      return;
    }
    const prompt = `${event.detail?.prompt ?? ""}`;
    this.activeSubmissionId = submissionId;
    this.error = null;
    this.syncComposer();
    this.renderStatus();
    const generation = ++this.requestGeneration;
    try {
      const detail = await createTask({
        ...(this.selectedContextPath()
          ? { cwd: this.selectedContextPath() }
          : {}),
        titleSource: prompt,
        ...(event.detail?.options ?? {}),
      });
      if (
        generation !== this.requestGeneration ||
        submissionId !== this.activeSubmissionId
      ) {
        return;
      }
      const submission = this.composer()?.submissionSnapshot(submissionId);
      if (!submission) {
        throw new Error("The created Task lost the prompt it was meant to submit.");
      }
      // Creation has accepted only the empty Task. The Task Detail composer
      // takes ownership of the still-pending message before navigation and
      // sends it through the same prompt path as every later message.
      const handoff = { detail, submission, adopted: false };
      this.dispatchEvent(
        new CustomEvent("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error("The created Task could not take ownership of its prompt.");
      }
      this.composer()?.takeSubmission(submissionId);
      // The pending request and its exact options now belong to the Task
      // composer. End this New Task editing lifetime so a later New surface
      // starts from canonical defaults instead of inheriting the old request.
      this.composer()?.endEditingLifetime();
      this.activeSubmissionId = "";
      this.syncComposer();
      this.renderStatus();
    } catch (error) {
      if (
        generation !== this.requestGeneration ||
        submissionId !== this.activeSubmissionId
      ) {
        return;
      }
      this.activeSubmissionId = "";
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.syncComposer();
      this.composer()?.resolveSubmission(submissionId, {
        status: "rejected",
        error: this.error,
      });
      this.renderStatus();
    }
  }

  cancelActiveSubmission() {
    this.requestGeneration += 1;
    if (!this.activeSubmissionId) {
      return;
    }
    const submissionId = this.activeSubmissionId;
    this.activeSubmissionId = "";
    this.composer()?.resolveSubmission(submissionId, {
      status: "outcome-unknown",
      error: new Error(
        "Task creation was interrupted before Caffold received a response.",
      ),
    });
  }

  syncComposer() {
    const settings = this.composerSettings ?? {};
    this.composer()?.setContext({
      mode: "create",
      className: "task-new-form",
      cwd: this.selectedContextPath(),
      browseCwd: this.browseCwd,
      placeholder: "Ask an agent to work from the current directory",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: false,
      model: settings.model ?? "",
      effort: settings.effort ?? "",
      fastMode: Boolean(settings.fastMode),
      disabled:
        !this.transportAvailable ||
        this.taskOperationsBlocked ||
        Boolean(this.activeSubmissionId),
      requestError: this.error?.message ?? "",
    });
  }

  // What this surface has to say about the request it is holding.
  //
  // This surface waits only for the empty Task to be committed. Once that
  // answers, the retained submission moves into the visible Task composer.
  // The region is left alone while it already says this, so a live region is
  // not re-announced for an unchanged state.
  renderStatus() {
    const region = this.querySelector(":scope > .task-create-status-region");
    if (!region) {
      return;
    }
    const status = this.error
      ? `error:${this.error.message}`
      : this.activeSubmissionId
        ? "starting"
        : "";
    if (this.renderedStatus === status) {
      return;
    }
    this.renderedStatus = status;
    if (this.error) {
      region.innerHTML = `<div class="task-create-status" data-status-tone="error" role="alert">
          ${renderInlineIcon("TriangleAlert", "Task creation failed", "task-create-status-icon")}
          <span>${escapeHtml(this.error.message)}</span>
        </div>`;
      return;
    }
    region.innerHTML = this.activeSubmissionId
      ? `<div class="task-create-status" data-status-tone="starting" role="status">
          <span>Starting the task...</span>
        </div>`
      : "";
  }
}

function normalizeComposerSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return {
    model: `${settings.model ?? ""}`,
    effort: `${settings.effort ?? ""}`,
    fastMode: Boolean(settings.fastMode),
  };
}

if (!customElements.get("caffold-task-create")) {
  customElements.define("caffold-task-create", CaffoldTaskCreate);
}
