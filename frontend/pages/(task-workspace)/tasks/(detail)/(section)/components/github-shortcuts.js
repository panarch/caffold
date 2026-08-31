import { getGitHubStatus } from "../../../../../../api.js";
import {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
} from "../../../../action-hints.js";

const SECTION_DETAIL_INTENT_EVENT = "caffold:section-detail-intent";
const GITHUB_KINDS = new Set(["issues", "pulls"]);

class CaffoldSectionGithubShortcuts extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureRendered();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("click", this.boundClick);
  }

  disconnectedCallback() {
    this.active = false;
    this.invalidateStatus();
    this.render();
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.active = false;
    this.context = { key: "", path: "", repository: false };
    this.githubStatus = null;
    this.statusContextKey = "";
    this.statusRequestId = 0;
    this.listenersAttached = false;
    this.boundClick = (event) => this.handleClick(event);
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > .section-github-repository")) {
      return;
    }
    this.setAttribute("role", "complementary");
    this.setAttribute("aria-label", "GitHub shortcuts");
    this.innerHTML = `
      <header class="section-github-repository">
        <span class="section-github-icon" aria-hidden="true"></span>
        <span class="section-github-name"></span>
      </header>
      <nav aria-label="Open GitHub work">
        <button type="button" data-section-github-kind="issues">Issues</button>
        <button type="button" data-section-github-kind="pulls">Pull Requests</button>
      </nav>
    `;
    this.render();
  }

  setContext({ key = "", path = "", repository = false } = {}) {
    this.ensureRendered();
    const previousKey = this.requestContextKey();
    this.context = {
      key: `${key}`,
      path: `${path}`,
      repository: Boolean(repository),
    };
    if (previousKey !== this.requestContextKey()) {
      this.invalidateStatus();
    }
    this.syncStatus();
  }

  activate() {
    this.ensureRendered();
    this.active = true;
    this.syncStatus();
  }

  deactivate() {
    this.active = false;
  }

  requestContextKey() {
    return JSON.stringify([
      this.context.key,
      this.context.path,
      this.context.repository,
    ]);
  }

  syncStatus() {
    const contextKey = this.requestContextKey();
    if (!this.context.repository) {
      this.invalidateStatus();
      this.render();
      return;
    }
    if (!this.active) {
      this.render();
      return;
    }
    if (this.statusContextKey === contextKey) {
      this.render();
      return;
    }

    this.githubStatus = null;
    this.statusContextKey = contextKey;
    this.render();
    const requestId = ++this.statusRequestId;
    void this.loadStatus({
      contextKey,
      path: this.context.path,
      requestId,
    });
  }

  async loadStatus({ contextKey, path, requestId }) {
    try {
      const status = await getGitHubStatus(path);
      if (!this.isCurrentRequest(contextKey, requestId)) {
        return;
      }
      this.githubStatus = status;
    } catch {
      if (!this.isCurrentRequest(contextKey, requestId)) {
        return;
      }
      this.githubStatus = null;
      this.statusContextKey = "";
    }
    this.render();
  }

  isCurrentRequest(contextKey, requestId) {
    return requestId === this.statusRequestId &&
      contextKey === this.requestContextKey();
  }

  invalidateStatus() {
    this.statusRequestId += 1;
    this.statusContextKey = "";
    this.githubStatus = null;
  }

  render() {
    const github = this.githubStatus?.github ?? null;
    this.toggleAttribute("hidden", !github);
    const name = this.querySelector(":scope > header > .section-github-name");
    if (name) {
      name.textContent = `${github?.nameWithOwner ?? ""}`;
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureRendered();
    if (
      !scopeId ||
      !this.active ||
      !this.githubStatus?.github ||
      this.hidden
    ) {
      return emptyActionHintScope();
    }
    const targets = [...GITHUB_KINDS].flatMap((kind) => {
      const control = this.querySelector(
        `:scope > nav > button[data-section-github-kind="${kind}"]`,
      );
      if (!control || control.disabled) {
        return [];
      }
      const label = kind === "issues" ? "Open GitHub Issues" : "Open GitHub Pull Requests";
      return [{
        id: `${scopeId}:github:${kind}`,
        actionId: ACTION_HINT_ACTION.GITHUB_MODE,
        label,
        controlKind: "button",
        control,
        anchor: control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.active &&
          Boolean(this.githubStatus?.github) &&
          this.querySelector(
            `:scope > nav > button[data-section-github-kind="${kind}"]`,
          ) === control &&
          !control.disabled,
        activate: () => {
          control.focus({ preventScroll: true });
          control.click();
        },
      }];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("[data-section-github-kind]")
      : null;
    if (!button || !this.contains(button)) {
      return;
    }
    const kind = button.dataset.sectionGithubKind;
    if (!this.githubStatus?.github || !GITHUB_KINDS.has(kind)) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent(SECTION_DETAIL_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { type: "open-github", kind },
      }),
    );
  }
}

if (!customElements.get("caffold-section-github-shortcuts")) {
  customElements.define(
    "caffold-section-github-shortcuts",
    CaffoldSectionGithubShortcuts,
  );
}
