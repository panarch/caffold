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

  actionHintTargets(options = {}) {
    this.ensureRendered();
    return this.composer()?.actionHintTargets(options) ?? [];
  }

  keyboardNavigationContexts(options = {}) {
    this.ensureRendered();
    return this.composer()?.keyboardNavigationContexts(options) ?? [];
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
    this.activeSubmissionId = submissionId;
    this.error = null;
    this.syncComposer();
    this.renderStatus();
    try {
      const submission = this.composer()?.submissionSnapshot(submissionId);
      if (!submission) {
        throw new Error("The Task prompt could not be prepared for creation.");
      }
      const intent = {
        type: "start",
        request: {
          ...(this.selectedContextPath()
            ? { cwd: this.selectedContextPath() }
            : {}),
          titleSource: submission.prompt,
          ...(submission.options ?? {}),
        },
        submission,
        accepted: false,
        completion: null,
      };
      this.dispatchEvent(
        new CustomEvent("caffold:task-create-intent", {
          bubbles: true,
          composed: true,
          detail: intent,
        }),
      );
      if (!intent.accepted || !intent.completion) {
        throw new Error("Another Task is already starting.");
      }
      await intent.completion;
      this.composer()?.takeSubmission(submissionId);
      // The Tasks page handed the request and its exact options to the new
      // Task composer. End this New Task editing lifetime so a later New
      // surface starts from canonical defaults instead of inheriting it.
      this.composer()?.endEditingLifetime();
      this.activeSubmissionId = "";
      this.syncComposer();
    } catch (error) {
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
      disabled: !this.transportAvailable || this.taskOperationsBlocked,
      requestError: this.error?.message ?? "",
    });
  }

  // The region is left alone while it already says this, so a live region is
  // not re-announced for an unchanged state.
  renderStatus() {
    const region = this.querySelector(":scope > .task-create-status-region");
    if (!region) {
      return;
    }
    const status = this.error ? `error:${this.error.message}` : "";
    if (this.renderedStatus === status) {
      return;
    }
    this.renderedStatus = status;
    region.innerHTML = this.error
      ? `<div class="task-create-status" role="alert">
          ${renderInlineIcon("TriangleAlert", "Task creation failed", "task-create-status-icon")}
          <span>${escapeHtml(this.error.message)}</span>
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
