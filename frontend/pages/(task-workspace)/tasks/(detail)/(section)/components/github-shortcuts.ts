import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  emptyActionHintScope,
} from "#app/action-hints.ts";
import { type GitHubStatus, getGitHubStatus } from "#app/api.ts";

// The Section's directory, and whether it is a Git repository. `key` names
// the Section the directory belongs to.
export interface GitHubShortcutsContext {
  key: string;
  path: string;
  repository: boolean;
}

// What the shortcuts ask the Section screen to open.
export interface GitHubShortcutIntent {
  type: "open-github";
  kind: GitHubKind;
}

type GitHubKind = "issues" | "pulls";

/**
 * A Section's way into its repository's GitHub Issues and Pull Requests,
 * shown only while the repository is on GitHub.
 *
 * It asks GitHub about the repository while active, once for each directory.
 * The Section screen hands it its context and reads it right after, so it
 * draws at once wherever its state changes.
 */
export class CaffoldSectionGithubShortcuts extends LitElement {
  private active = false;
  private context: GitHubShortcutsContext = {
    key: "",
    path: "",
    repository: false,
  };
  private githubStatus: GitHubStatus | null = null;
  private statusContextKey = "";
  private statusRequestId = 0;
  private readonly hints = new ActionHints(this, () => this.performUpdate());

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "complementary");
    setAttribute(this, "aria-label", "GitHub shortcuts");
    this.draw();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.active = false;
    this.invalidateStatus();
    this.draw();
  }

  setContext({
    key = "",
    path = "",
    repository = false,
  }: Partial<GitHubShortcutsContext> = {}) {
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
    this.active = true;
    this.syncStatus();
  }

  deactivate() {
    this.active = false;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.active ? this.hints.scope(pull) : emptyActionHintScope();
  }

  protected updated() {
    const hidden = !this.githubStatus?.github;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  render() {
    return html`
      <header class="section-github-repository">
        <span class="section-github-icon" aria-hidden="true"></span>
        <span class="section-github-name">${
          this.githubStatus?.github?.nameWithOwner ?? ""
        }</span>
      </header>
      <nav aria-label="Open GitHub work">
        <button
          ${this.hints.button({
            id: "github:issues",
            label: "Open GitHub Issues",
            action: ACTION_HINT_ACTION.GITHUB_MODE,
          })}
          type="button"
          data-section-github-kind="issues"
          @click=${this.openGitHub}
        >Issues</button>
        <button
          ${this.hints.button({
            id: "github:pulls",
            label: "Open GitHub Pull Requests",
            action: ACTION_HINT_ACTION.GITHUB_MODE,
          })}
          type="button"
          data-section-github-kind="pulls"
          @click=${this.openGitHub}
        >Pull Requests</button>
      </nav>
    `;
  }

  private requestContextKey() {
    return JSON.stringify([
      this.context.key,
      this.context.path,
      this.context.repository,
    ]);
  }

  private syncStatus() {
    const contextKey = this.requestContextKey();
    if (!this.context.repository) {
      this.invalidateStatus();
      this.draw();
      return;
    }
    if (!this.active || this.statusContextKey === contextKey) {
      this.draw();
      return;
    }

    this.githubStatus = null;
    this.statusContextKey = contextKey;
    this.draw();
    const requestId = ++this.statusRequestId;
    void this.loadStatus(contextKey, this.context.path, requestId);
  }

  private async loadStatus(
    contextKey: string,
    path: string,
    requestId: number,
  ) {
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
    this.draw();
  }

  private isCurrentRequest(contextKey: string, requestId: number) {
    return (
      requestId === this.statusRequestId &&
      contextKey === this.requestContextKey()
    );
  }

  private invalidateStatus() {
    this.statusRequestId += 1;
    this.statusContextKey = "";
    this.githubStatus = null;
  }

  private openGitHub(event: Event) {
    const kind = (event.currentTarget as HTMLButtonElement).dataset
      .sectionGithubKind as GitHubKind;
    if (!this.githubStatus?.github) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<GitHubShortcutIntent>("caffold:section-detail-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "open-github", kind },
      }),
    );
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define(
  "caffold-section-github-shortcuts",
  CaffoldSectionGithubShortcuts,
);

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
