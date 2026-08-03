import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import { routeDomain } from "../../navigation-routes.js";
import "./(git)/components/controls.js";

class CaffoldReviewWorkspace extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      if (button.dataset.action === "back-review-workspace") {
        this.requestWorkspaceBackRoute() || this.dispatchWorkspaceBack();
        return;
      }

      if (button.dataset.action !== "close-review-workspace") {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("caffold:close-review-workspace", {
          bubbles: true,
        }),
      );
    });
    this.addEventListener("caffold:refresh-git-review", (event) => {
      event.stopPropagation();
      void this.gitLayout.refresh();
    });
    this.addEventListener("caffold:git-review-state-change", () => {
      if (this.isActive("git")) {
        this.refreshDetails();
      }
    });
    this.addEventListener("caffold:github-review-state-change", () => {
      if (this.isActive("github")) {
        this.refreshDetails();
      }
    });
    this.boundIconsReady = () => this.renderChrome();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <section
        class="review-workspace-panel"
        aria-label="Review workspace"
      >
        <header class="review-workspace-header">
          <div class="review-workspace-nav">
            <button
              type="button"
              class="review-workspace-back"
              data-action="back-review-workspace"
              aria-label="Back to log"
              title="Back"
              hidden
            ></button>
            <button
              type="button"
              class="review-workspace-close"
              data-action="close-review-workspace"
              aria-label="Close review workspace"
              title="Close"
            ></button>
          </div>
          <div class="review-workspace-title">
            <h2></h2>
            <div class="review-workspace-controls" hidden>
              <caffold-git-review-controls hidden></caffold-git-review-controls>
            </div>
            <span class="review-workspace-subtitle"></span>
          </div>
        </header>
        <div class="review-workspace-body">
          <div class="review-workspace-view workspace-mode-git" hidden>
            <caffold-git-review-layout></caffold-git-review-layout>
          </div>
          <div class="review-workspace-view workspace-mode-github" hidden>
            <caffold-github-review-layout></caffold-github-review-layout>
          </div>
        </div>
      </section>
    `;
    this.titleWrapper = this.querySelector(".review-workspace-title");
    this.titleEl = this.querySelector(".review-workspace-title h2");
    this.controlsEl = this.querySelector(".review-workspace-controls");
    this.gitControls = this.querySelector("caffold-git-review-controls");
    this.subtitleEl = this.querySelector(".review-workspace-subtitle");
    this.backButton = this.querySelector(".review-workspace-back");
    this.closeButton = this.querySelector(".review-workspace-close");
    this.gitView = this.querySelector(".workspace-mode-git");
    this.gitLayout = this.querySelector("caffold-git-review-layout");
    this.gitLayout.ensureRendered();
    this.githubView = this.querySelector(".workspace-mode-github");
    this.githubLayout = this.querySelector("caffold-github-review-layout");
    this.githubLayout.ensureRendered();
    this.renderChrome();
  }

  open(mode, options = {}) {
    this.ensureRendered();
    this.hidden = false;
    this.mode = mode;
    this.dataset.workspaceMode = mode;
    this.workspaceTitle = options.title ?? workspaceTitle(mode);
    this.subtitle = options.subtitle ?? "";
    this.controls = options.controls ?? null;
    this.backVisible = Boolean(options.backVisible);
    this.backLabel = options.backLabel ?? "Back";
    this.renderChrome();
    this.updateVisibleMode();
  }

  close() {
    this.ensureRendered();
    this.gitLayout.setView("list");
    this.githubLayout.backToList();
    this.hidden = true;
    this.mode = null;
    this.dataset.workspaceMode = "";
    this.backVisible = false;
    this.controls = null;
    this.renderChrome();
    this.updateVisibleMode();
  }

  updateDetails(options = {}) {
    this.workspaceTitle = options.title ?? this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitle = options.subtitle ?? this.subtitle ?? "";
    if (options.backVisible !== undefined) {
      this.backVisible = Boolean(options.backVisible);
    }
    this.controls = options.controls ?? null;
    this.backLabel = options.backLabel ?? this.backLabel ?? "Back";
    this.renderChrome();
    this.updateVisibleMode();
  }

  get activeMode() {
    return this.mode ?? null;
  }

  isActive(mode) {
    return this.activeMode === mode;
  }

  async openGitReviewRoute(route, options = {}) {
    this.ensureRendered();
    this.gitLayout.setContext(options.context);
    this.prepareRoute(route);
    const result = await this.gitLayout.openRoute(route, options.routeOptions);
    this.refreshDetails();
    return result;
  }

  async openGithubReviewRoute(route, options = {}) {
    this.ensureRendered();
    this.githubLayout.setContext(options.context);
    this.prepareRoute(route);
    const result = await this.githubLayout.openRoute(route, options.routeOptions);
    this.refreshDetails();
    return result;
  }

  setGithubRouteError(route, error) {
    this.ensureRendered();
    this.prepareRoute(route);
    this.githubLayout.setRouteError(route, error);
    this.refreshDetails();
  }

  prepareRoute(route) {
    this.ensureRendered();
    const domain = routeDomain(route);
    if (domain === "git") {
      this.gitLayout.prepareRoute(route);
      this.open("git", this.detailsForMode("git"));
      return;
    }

    if (domain === "github") {
      this.githubLayout.prepareRoute(route);
      this.open("github", this.detailsForMode("github"));
    }
  }

  prepareForFileBrowserOpen() {
    this.gitLayout.setSelectedPath("");
  }

  prepareForGitReviewRoute(route, options = {}) {
    if (route.path || (route.kind === "log" && route.sha)) {
      options.clearFileSelection?.();
    }
  }

  prepareForGithubReviewRoute(route, options = {}) {
    if (route.path || route.number) {
      options.clearFileSelection?.();
      this.gitLayout.setSelectedPath("");
    }

    if (!route.number) {
      this.gitLayout.setView("list");
    }
  }

  applyRepositoryContext({ path, repository } = {}) {
    this.ensureRendered();
    void this.gitLayout.applyRepositoryContext({ path, repository });
    void this.githubLayout.applyRepositoryContext({ path, repository });
  }

  reloadActiveReviewContext(options = {}) {
    if (this.isActive("git")) {
      options.openGitRoute?.(this.gitLayout.routeForActiveMode());
      return true;
    }

    if (this.isActive("github")) {
      options.openGithubRoute?.(this.githubLayout.routeForActiveMode());
      return true;
    }

    return false;
  }

  clearRepositoryContext() {
    this.ensureRendered();
    this.gitLayout.reset();
    this.githubLayout.reset();
    this.close();
  }

  refreshDetails() {
    if (!this.activeMode) {
      return;
    }

    this.updateDetails(this.detailsForMode(this.activeMode));
  }

  detailsForMode(mode) {
    if (mode === "git") {
      return this.gitLayout.details();
    }

    if (mode === "github") {
      return this.githubLayout.details();
    }

    return {};
  }

  requestWorkspaceBackRoute() {
    const route = this.routeForWorkspaceBack();
    if (!route) {
      return false;
    }

    if (this.isActive("git")) {
      this.dispatchEvent(
        new CustomEvent("caffold:request-git-route", {
          bubbles: true,
          detail: { route },
        }),
      );
      return true;
    }

    if (this.isActive("github")) {
      this.dispatchEvent(
        new CustomEvent("caffold:request-github-route", {
          bubbles: true,
          detail: { route },
        }),
      );
      return true;
    }

    return false;
  }

  routeForWorkspaceBack() {
    if (this.isActive("git")) {
      return this.gitLayout.routeForWorkspaceBack();
    }

    if (this.isActive("github")) {
      return this.githubLayout.routeForWorkspaceBack();
    }

    return null;
  }

  dispatchWorkspaceBack() {
    this.dispatchEvent(
      new CustomEvent("caffold:back-review-workspace", {
        bubbles: true,
      }),
    );
  }

  updateVisibleMode() {
    if (!this.rendered) {
      return;
    }

    this.gitView.hidden = this.mode !== "git";
    this.githubView.hidden = this.mode !== "github";
    this.updateMobileDetailState();
  }

  renderChrome() {
    if (!this.rendered) {
      return;
    }

    this.titleEl.textContent = this.workspaceTitle ?? workspaceTitle(this.mode);
    this.subtitleEl.textContent = this.subtitle ?? "";
    const controlsVisible = this.mode === "git" && Boolean(this.controls);
    this.gitControls.setSnapshot(this.controls);
    this.gitControls.hidden = !controlsVisible;
    this.controlsEl.hidden = !controlsVisible;
    this.titleWrapper.classList.toggle("has-controls", controlsVisible);
    this.backButton.hidden = !this.backVisible;
    this.backButton.setAttribute("aria-label", this.backLabel ?? "Back");
    this.backButton.setAttribute("title", this.backLabel ?? "Back");
    this.backButton.innerHTML = renderInlineIcon(
      "ArrowLeft",
      this.backLabel ?? "Back",
      "review-workspace-back-icon",
    );
    this.closeButton.innerHTML = renderInlineIcon("X", "Close", "review-workspace-close-icon");
  }

  updateMobileDetailState() {
    if (!this.rendered) {
      return;
    }

    const detailOpen =
      (this.mode === "git" && this.gitLayout.isMobileDetailOpen()) ||
      (this.mode === "github" && this.githubLayout.isMobileDetailOpen());

    this.dataset.mobileDetail = detailOpen ? "true" : "false";
  }
}

customElements.define("caffold-review-workspace", CaffoldReviewWorkspace);

function workspaceTitle(mode) {
  if (mode === "git") {
    return "Git";
  }

  if (mode === "github") {
    return "GitHub";
  }

  return "Review";
}
