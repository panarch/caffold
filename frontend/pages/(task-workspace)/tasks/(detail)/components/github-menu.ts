import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  KeyboardContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

// What the menu asks the Detail layout to open.
export interface GitHubMenuIntent {
  type: "open-github-tool";
  reviewKind: string | null;
}

let taskDetailGithubInstanceId = 0;

await compactIconButton.register(
  "caffold-task-detail-github",
  "> .task-github-button",
);

/**
 * The Detail header's GitHub button, and the popover of GitHub work it
 * opens: Pull Requests and Issues.
 */
@customElement("caffold-task-detail-github")
export class CaffoldTaskDetailGithub extends LitElement {
  @state()
  private accessor available = false;

  private readonly popoverId =
    `task-github-actions-${++taskDetailGithubInstanceId}`;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly githubPopover = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  setSnapshot({ available = false }: { available?: boolean } = {}) {
    this.available = Boolean(available);
    if (!this.available) {
      this.deactivate();
    }
  }

  deactivate() {
    const popover = this.githubPopover.value;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  actionHintScope({ scopeId = "task-detail", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  keyboardNavigationContexts({
    scopeId = "task-detail",
  }: {
    scopeId?: string;
  } = {}) {
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  override render() {
    return html`
      <button
        ${this.hints.button({
          id: "github:open",
          label: "Open GitHub workspace",
          action: ACTION_HINT_ACTION.GITHUB_OPEN,
        })}
        type="button"
        class="task-github-button"
        popovertarget=${this.popoverId}
        aria-label="Open GitHub workspace"
        title="Open GitHub workspace"
        ?disabled=${!this.available}
      >
        <span class="task-github-icon" aria-hidden="true"></span>
      </button>
      <div
        ${drawn(this.githubPopover)}
        ${this.keyboard.popover({
          id: "github",
          label: "GitHub workspace actions",
          sessionBound: true,
        })}
        id=${this.popoverId}
        class="task-github-popover"
        popover="auto"
        role="group"
        aria-label="GitHub workspace actions"
      >
        <button
          ${this.hints.button({
            id: "pulls",
            label: "Pull Requests",
            action: ACTION_HINT_ACTION.GITHUB_DESTINATION,
            badgeAtEnd: true,
          })}
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="pulls"
          @click=${this.openTool}
        >Pull Requests</button>
        <button
          ${this.hints.button({
            id: "issues",
            label: "Issues",
            action: ACTION_HINT_ACTION.GITHUB_DESTINATION,
            badgeAtEnd: true,
          })}
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="issues"
          @click=${this.openTool}
        >Issues</button>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  private handleDismiss(event: Event) {
    if (event.target === this.githubPopover.value) {
      this.deactivate();
    }
  }

  private openTool(event: Event) {
    this.dispatchEvent(
      new CustomEvent<GitHubMenuIntent>("caffold:task-detail-github-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: "open-github-tool",
          reviewKind:
            (event.currentTarget as HTMLButtonElement).dataset.reviewKind ??
            null,
        },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-github": CaffoldTaskDetailGithub;
  }
}
