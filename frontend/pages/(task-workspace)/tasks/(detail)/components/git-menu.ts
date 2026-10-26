import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { compactIconButton } from "#app/component-styles.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  KeyboardContexts,
} from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";

// What the menu asks the Detail layout to open.
export interface GitMenuIntent {
  type: "open-git-tool";
  reviewKind: string | null;
}

let taskDetailGitInstanceId = 0;

/**
 * The Detail header's Git button, and the popover of Git work it opens:
 * Compare and Log.
 *
 * The Detail layout hands it whether Git is available and reads it right
 * after, so it draws at once.
 */
export class CaffoldTaskDetailGit extends LitElement {
  private available = false;
  private readonly popoverId = `task-git-actions-${++taskDetailGitInstanceId}`;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly gitPopover = new DrawnRef<HTMLDivElement>(this);

  constructor() {
    super();
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  setSnapshot({ available = false }: { available?: boolean } = {}) {
    this.available = Boolean(available);
    this.requestUpdate();
    this.performUpdate();
    if (!this.available) {
      this.deactivate();
    }
  }

  deactivate() {
    const popover = this.gitPopover.value;
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

  render() {
    return html`
      <button
        ${this.hints.button({
          id: "git:open",
          label: "Open Git workspace",
          action: ACTION_HINT_ACTION.GIT_OPEN,
        })}
        type="button"
        class="task-git-button"
        popovertarget=${this.popoverId}
        aria-label="Open Git workspace"
        title="Open Git workspace"
        ?disabled=${!this.available}
      >
        <span class="task-git-icon" aria-hidden="true"></span>
      </button>
      <div
        ${drawn(this.gitPopover)}
        ${this.keyboard.popover({
          id: "git",
          label: "Git workspace actions",
          sessionBound: true,
        })}
        id=${this.popoverId}
        class="task-git-popover"
        popover="auto"
        role="group"
        aria-label="Git workspace actions"
      >
        <button
          ${this.hints.button({
            id: "compare",
            label: "Compare",
            action: ACTION_HINT_ACTION.GIT_DESTINATION,
            badgeAtEnd: true,
          })}
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="compare"
          @click=${this.openTool}
        >Compare</button>
        <button
          ${this.hints.button({
            id: "log",
            label: "Log",
            action: ACTION_HINT_ACTION.GIT_DESTINATION,
            badgeAtEnd: true,
          })}
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="log"
          @click=${this.openTool}
        >Log</button>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  private handleDismiss(event: Event) {
    if (event.target === this.gitPopover.value) {
      this.deactivate();
    }
  }

  private openTool(event: Event) {
    this.dispatchEvent(
      new CustomEvent<GitMenuIntent>("caffold:task-detail-git-intent", {
        bubbles: true,
        composed: true,
        detail: {
          type: "open-git-tool",
          reviewKind:
            (event.currentTarget as HTMLButtonElement).dataset.reviewKind ??
            null,
        },
      }),
    );
  }
}

await compactIconButton.register(
  "caffold-task-detail-git",
  "> .task-git-button",
);

customElements.define("caffold-task-detail-git", CaffoldTaskDetailGit);
