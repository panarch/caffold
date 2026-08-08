import { createTask } from "../../../../api.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { cleanLogicalPath } from "../task-format.js";
import "./composer.js";
import "./directory-picker.js";

const AUTO_FOCUS_PROMPT_MEDIA =
  "(hover: hover) and (pointer: fine) and (min-width: 521px)";

class CaffoldTaskNew extends HTMLElement {
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
    this.addEventListener(
      "caffold:directory-picked",
      this.boundDirectoryPicked,
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
    this.removeEventListener(
      "caffold:directory-picked",
      this.boundDirectoryPicked,
    );
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.requestGeneration += 1;
    if (this.activeSubmissionId) {
      const submissionId = this.activeSubmissionId;
      this.activeSubmissionId = "";
      this.composer()?.resolveSubmission(submissionId, {
        status: "outcome-unknown",
        error: new Error(
          "Task creation was interrupted before Caffold received a response.",
        ),
      });
    }
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.cwd = ".";
    this.transportAvailable = true;
    this.error = null;
    this.requestGeneration = 0;
    this.activeSubmissionId = "";
    this.boundComposerIntent = (event) => this.handleComposerIntent(event);
    this.boundComposerSubmit = (event) => {
      void this.handleComposerSubmit(event);
    };
    this.boundDirectoryPicked = (event) => this.handleDirectoryPicked(event);
    this.boundIconsReady = () => this.renderError();
    warmIcons();
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .task-new-workspace")) {
      return;
    }
    this.innerHTML = `
      <section class="task-new-workspace">
        <div class="task-new-error-region"></div>
        <caffold-task-composer></caffold-task-composer>
      </section>
      <caffold-task-directory-picker></caffold-task-directory-picker>
    `;
    this.renderError();
    this.syncComposer();
  }

  prepare({ cwd = "", defaultCwdPath = "" } = {}) {
    this.ensureState();
    this.cwd = cleanLogicalPath(cwd || defaultCwdPath || ".");
    this.error = null;
    this.ensureRendered();
    this.directoryPicker()?.dismiss();
    this.renderError();
    this.syncComposer();
  }

  open() {
    this.ensureState();
    this.hidden = false;
    this.renderError();
    this.syncComposer();
    if (window.matchMedia(AUTO_FOCUS_PROMPT_MEDIA).matches) {
      this.composer()?.focus();
    }
  }

  deactivate() {
    this.hidden = true;
    this.directoryPicker()?.dismiss();
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

  selectedContextPath() {
    this.ensureState();
    return cleanLogicalPath(this.cwd);
  }

  composer() {
    return this.querySelector(":scope > .task-new-workspace caffold-task-composer");
  }

  directoryPicker() {
    return this.querySelector(":scope > caffold-task-directory-picker");
  }

  handleComposerIntent(event) {
    if (event.target !== this.composer()) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type === "browse-cwd") {
      this.directoryPicker()?.open(this.selectedContextPath(), {
        opener:
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null,
      });
    }
  }

  handleDirectoryPicked(event) {
    if (event.target !== this.directoryPicker()) {
      return;
    }
    event.stopPropagation();
    this.cwd = cleanLogicalPath(event.detail?.path ?? "");
    this.syncComposer();
    this.dispatchRoute({ kind: "tasks", new: true, cwd: this.cwd });
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
    const generation = ++this.requestGeneration;
    try {
      const detail = await createTask({
        ...(this.selectedContextPath()
          ? { cwd: this.selectedContextPath() }
          : {}),
        prompt: `${event.detail?.prompt ?? ""}`,
        images: event.detail?.images ?? [],
        ...(event.detail?.options ?? {}),
      });
      if (
        generation !== this.requestGeneration ||
        submissionId !== this.activeSubmissionId
      ) {
        return;
      }
      this.activeSubmissionId = "";
      this.syncComposer();
      this.composer()?.resolveSubmission(submissionId, {
        status: "accepted",
      });
      this.dispatchEvent(
        new CustomEvent("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: { detail },
        }),
      );
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
      this.renderError();
    }
  }

  syncComposer() {
    this.composer()?.setContext({
      mode: "create",
      className: "task-new-form",
      cwd: this.selectedContextPath(),
      placeholder: "Ask Codex to work from the current directory",
      ariaLabel: "New task prompt",
      submitLabel: "Start task",
      cancel: false,
      disabled: !this.transportAvailable || Boolean(this.activeSubmissionId),
      requestError: this.error?.message ?? "",
    });
  }

  renderError() {
    const region = this.querySelector(
      ":scope > .task-new-workspace > .task-new-error-region",
    );
    if (!region) {
      return;
    }
    region.innerHTML = this.error
      ? `<div class="task-new-error" role="alert">
          ${renderInlineIcon("TriangleAlert", "Codex unavailable", "task-new-error-icon")}
          <span>${escapeHtml(this.error.message)}</span>
        </div>`
      : "";
  }

  dispatchRoute(route) {
    this.dispatchEvent(
      new CustomEvent("caffold:task-new-route-intent", {
        bubbles: true,
        composed: true,
        detail: { route },
      }),
    );
  }
}

if (!customElements.get("caffold-task-new")) {
  customElements.define("caffold-task-new", CaffoldTaskNew);
}
