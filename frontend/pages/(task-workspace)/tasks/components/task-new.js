import { createTask } from "../../../../api.js";
import "../../../../components/file-browser.js";
import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import { cleanLogicalPath } from "../task-format.js";
import "./composer.js";

const AUTO_FOCUS_PROMPT_MEDIA =
  "(hover: hover) and (pointer: fine) and (min-width: 521px)";

class CaffoldTaskNew extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
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
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener(
      "caffold:task-composer-intent",
      this.boundComposerIntent,
    );
    this.removeEventListener(
      "caffold:task-composer-submit",
      this.boundComposerSubmit,
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
    this.defaultCwdPath = ".";
    this.browsing = false;
    this.transportAvailable = true;
    this.error = null;
    this.requestGeneration = 0;
    this.activeSubmissionId = "";
    this.boundClick = (event) => this.handleClick(event);
    this.boundComposerIntent = (event) => this.handleComposerIntent(event);
    this.boundComposerSubmit = (event) => {
      void this.handleComposerSubmit(event);
    };
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
      <section class="task-new-cwd-browser" aria-label="Choose task directory" hidden>
        <header>
          <div>
            <h2>Browse Files</h2>
            <p></p>
          </div>
          <div>
            <button type="button" class="task-secondary-button" data-task-new-action="cancel-cwd">Cancel</button>
            <button type="button" class="task-primary-button" data-task-new-action="choose-cwd">Use This Folder</button>
          </div>
        </header>
      </section>
    `;
    this.syncView();
  }

  prepare({ cwd = "", defaultCwdPath = "" } = {}) {
    this.ensureState();
    this.cwd = cleanLogicalPath(cwd || defaultCwdPath || ".");
    this.defaultCwdPath = cleanLogicalPath(defaultCwdPath || ".");
    this.browsing = false;
    this.error = null;
    this.ensureRendered();
    this.syncView();
  }

  open() {
    this.ensureState();
    this.hidden = false;
    this.syncView();
    if (window.matchMedia(AUTO_FOCUS_PROMPT_MEDIA).matches) {
      this.composer()?.focus();
    }
  }

  deactivate() {
    this.hidden = true;
    this.browsing = false;
    this.syncView();
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
    return cleanLogicalPath(this.cwd || this.defaultCwdPath || ".");
  }

  composer() {
    return this.querySelector(":scope > .task-new-workspace caffold-task-composer");
  }

  handleComposerIntent(event) {
    if (event.target !== this.composer()) {
      return;
    }
    event.stopPropagation();
    if (event.detail?.type === "browse-cwd") {
      this.browsing = true;
      this.syncView();
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

  handleClick(event) {
    const action =
      event.target instanceof Element
        ? event.target.closest("[data-task-new-action]")
        : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    if (action.dataset.taskNewAction === "cancel-cwd") {
      this.browsing = false;
      this.syncView();
      return;
    }
    if (action.dataset.taskNewAction === "choose-cwd") {
      const browser = this.querySelector(
        ":scope > .task-new-cwd-browser caffold-file-browser",
      );
      this.cwd = cleanLogicalPath(
        browser?.currentPath ?? this.selectedContextPath(),
      );
      this.browsing = false;
      this.syncView();
      this.dispatchRoute({ kind: "tasks", new: true, cwd: this.cwd });
    }
  }

  syncView() {
    this.ensureRendered();
    const workspace = this.querySelector(":scope > .task-new-workspace");
    const browserSection = this.querySelector(
      ":scope > .task-new-cwd-browser",
    );
    if (!workspace || !browserSection) {
      return;
    }
    workspace.hidden = this.browsing;
    browserSection.hidden = !this.browsing;
    browserSection.querySelector("header p").textContent =
      this.selectedContextPath();
    let browser = browserSection.querySelector(":scope > caffold-file-browser");
    if (this.browsing) {
      browser = this.ensureCwdBrowser();
    }
    browser?.setWatchActive(this.browsing);
    this.renderError();
    this.syncComposer();
    if (this.browsing) {
      this.syncBrowser();
    }
  }

  ensureCwdBrowser() {
    const section = this.querySelector(":scope > .task-new-cwd-browser");
    if (!section) {
      return null;
    }
    let browser = section.querySelector(":scope > caffold-file-browser");
    if (!browser) {
      browser = document.createElement("caffold-file-browser");
      section.append(browser);
    }
    return browser;
  }

  syncBrowser() {
    const browser = this.ensureCwdBrowser();
    const targetPath = this.selectedContextPath();
    if (!browser) {
      return;
    }
    browser.ensureRendered();
    browser.setStorageKey(null);
    if (!browser.hasLoadedDirectory(targetPath)) {
      browser.loadDirectory(targetPath, { allowFailure: true });
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
