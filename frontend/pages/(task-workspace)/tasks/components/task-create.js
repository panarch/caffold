import { mergeActionHintScopes } from "#app/action-hints.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { escapeHtml } from "#components/dom.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";
import { taskStoreBlocksTaskOperations } from "../../task-store-status.js";
import { cleanLogicalPath } from "../task-format.js";
import { DIRECTORY_CHOSEN_EVENT } from "./task-create/components/directory-field.js";
import { directoryPathDisplay } from "./task-create/directory-path.js";
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
    this.addEventListener(DIRECTORY_CHOSEN_EVENT, this.boundDirectoryChosen);
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
    this.removeEventListener(DIRECTORY_CHOSEN_EVENT, this.boundDirectoryChosen);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.cwd = ".";
    this.browseCwd = false;
    this.server = {};
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
    this.boundDirectoryChosen = (event) => this.handleDirectoryChosen(event);
    this.boundIconsReady = () => {
      // The error card and the fixed directory gain their icons once the icon
      // set loads, which the keys below cannot see.
      this.renderedStatus = null;
      this.renderedFixedDirectory = null;
      this.renderStatus();
      this.syncDirectory();
    };
    warmIcons();
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > caffold-task-composer")) {
      return;
    }
    this.innerHTML = `
      <div class="task-create-directory"></div>
      <div class="task-create-status-region"></div>
      <caffold-task-composer></caffold-task-composer>
    `;
    this.renderedStatus = null;
    this.renderedFixedDirectory = null;
    this.renderStatus();
    this.syncDirectory();
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
    this.syncDirectory();
    this.syncComposer();
    return changed;
  }

  // Where the server's root and home directory are, which decide how a
  // directory reads.
  setServerPaths({ root = "", homePath = null } = {}) {
    this.ensureState();
    this.server = { root: `${root ?? ""}`, homePath: homePath ?? null };
    this.ensureRendered();
    this.syncDirectory();
  }

  activate() {
    this.ensureRendered();
    this.hidden = false;
    this.renderStatus();
    this.syncComposer();
  }

  deactivate() {
    this.directoryField()?.deactivate();
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

  setTaskStoreStatusSnapshot(snapshot) {
    this.ensureState();
    // Only the store gates creating — it is shared by every agent. Codex
    // being unready costs the picker its Codex models and nothing more.
    const blocked = taskStoreBlocksTaskOperations(snapshot);
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

  directoryField() {
    return this.querySelector(
      ":scope > .task-create-directory > caffold-task-directory-field",
    );
  }

  actionHintScope(options = {}) {
    this.ensureRendered();
    return mergeActionHintScopes(
      this.directoryField()?.actionHintScope(options),
      {
        blocked: false,
        targets: this.composer()?.actionHintTargets(options) ?? [],
        mutationRoots: [this],
        scrollRoots: [],
      },
    );
  }

  scrollSurfaceScope(options = {}) {
    this.ensureRendered();
    return this.directoryField()?.scrollSurfaceScope(options) ??
      emptyScrollSurfaceScope();
  }

  ownsEditingEscape(element) {
    return Boolean(this.directoryField()?.ownsEditingEscape(element));
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
  }

  handleDirectoryChosen(event) {
    if (event.target !== this.directoryField()) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("caffold:task-create-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "choose-cwd", path: `${event.detail?.path ?? ""}` },
      }),
    );
    if (event.detail?.returnFocus) {
      this.composer()?.focus();
    }
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
    this.syncDirectory();
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
      this.syncDirectory();
      this.syncComposer();
    } catch (error) {
      this.activeSubmissionId = "";
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.syncDirectory();
      this.syncComposer();
      this.composer()?.resolveSubmission(submissionId, {
        status: "rejected",
        error: this.error,
      });
      this.renderStatus();
    }
  }

  // The directory above the Composer: a field to choose it where the surface
  // lets you, and the fixed path where it does not.
  syncDirectory() {
    const region = this.querySelector(":scope > .task-create-directory");
    if (!region) {
      return;
    }
    const path = this.selectedContextPath();
    if (this.browseCwd) {
      let field = this.directoryField();
      if (!field) {
        field = document.createElement("caffold-task-directory-field");
        region.replaceChildren(field);
        this.renderedFixedDirectory = null;
      }
      field.setContext({
        path,
        server: this.server,
        locked: Boolean(this.activeSubmissionId),
      });
      return;
    }
    this.directoryField()?.deactivate();
    const shown = directoryPathDisplay(path, this.server);
    if (this.renderedFixedDirectory === shown) {
      return;
    }
    this.renderedFixedDirectory = shown;
    region.innerHTML = `
      <p class="task-create-fixed-directory">
        ${renderInlineIcon("Folder", "Working directory", "task-create-fixed-directory-icon")}
        <span class="task-create-fixed-directory-path" title="${escapeHtml(shown)}"><span dir="ltr">${escapeHtml(shown)}</span></span>
      </p>
    `;
  }

  syncComposer() {
    const settings = this.composerSettings ?? {};
    this.composer()?.setContext({
      mode: "create",
      className: "task-new-form",
      cwd: this.selectedContextPath(),
      placeholder: "Ask an agent to work from the current directory",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: false,
      model: settings.model ?? "",
      effort: settings.effort ?? "",
      fastMode: Boolean(settings.fastMode),
      permissionMode: settings.permissionMode ?? "",
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
    permissionMode: `${settings.permissionMode ?? ""}`,
  };
}

if (!customElements.get("caffold-task-create")) {
  customElements.define("caffold-task-create", CaffoldTaskCreate);
}
