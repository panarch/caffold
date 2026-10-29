import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { type GitHubStatus, getGitHubStatus } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./github-shortcuts.css.js";

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
 * shown only while active and the repository is on GitHub.
 *
 * It asks GitHub about the repository while active, once for each directory.
 */
@customElement("caffold-section-github-shortcuts")
export class CaffoldSectionGithubShortcuts extends CaffoldElement {
  @state()
  private accessor githubStatus: GitHubStatus | null = null;

  static override styles = styles;

  @state()
  private accessor active = false;
  private context: GitHubShortcutsContext = {
    key: "",
    path: "",
    repository: false,
  };
  private statusContextKey = "";
  private statusRequestId = 0;
  private readonly hints = new ActionHints(this);

  override connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "complementary");
    setAttribute(this, "aria-label", "GitHub shortcuts");
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.active = false;
    this.invalidateStatus();
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

  protected override updated() {
    const hidden = !this.active || !this.githubStatus?.github;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  override render() {
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
      return;
    }
    if (!this.active || this.statusContextKey === contextKey) {
      return;
    }

    this.githubStatus = null;
    this.statusContextKey = contextKey;
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
}

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-section-github-shortcuts": CaffoldSectionGithubShortcuts;
  }

  interface HTMLElementEventMap {
    "caffold:section-detail-intent": CustomEvent<GitHubShortcutIntent>;
  }
}
