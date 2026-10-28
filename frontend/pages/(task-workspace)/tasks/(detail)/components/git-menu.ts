import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { returnPopoverFocus } from "#app/popover-focus.js";
import { scopedStyle } from "#app/scoped-style.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import styles from "./git-menu.css.js";

// What the menu asks the Detail layout to open.
export interface GitMenuIntent {
  type: "open-git-tool";
  reviewKind: string | null;
}

let taskDetailGitInstanceId = 0;

/**
 * The Detail header's Git button, and the popover of Git work it opens:
 * Compare and Log.
 */
@customElement("caffold-task-detail-git")
export class CaffoldTaskDetailGit extends CaffoldElement {
  @state()
  private accessor available = false;

  static override styles = [
    scopedStyle(compactIconButton, ".task-git-button"),
    styles,
  ];

  private readonly popoverId = `task-git-actions-${++taskDetailGitInstanceId}`;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly gitPopover = new DrawnRef<HTMLDivElement>(this);

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

  override render() {
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
        @beforetoggle=${returnPopoverFocus}
        @caffold:keyboard-session-dismiss=${this.handleDismiss}
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-git": CaffoldTaskDetailGit;
  }

  interface HTMLElementEventMap {
    "caffold:task-detail-git-intent": CustomEvent<GitMenuIntent>;
  }
}
