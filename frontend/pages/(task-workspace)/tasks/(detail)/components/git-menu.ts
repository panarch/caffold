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
import { inlineIcon, warmIcons } from "#components/icons.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import actionIcon from "#tasks/component-styles/action-icon.css.js";
import styles from "./git-menu.css.js";

// What the menu asks the Detail layout to open.
export type GitMenuIntent =
  | { surface: "git"; kind: "compare" | "log" }
  | { surface: "github"; kind: "pulls" | "issues" };

let taskDetailGitInstanceId = 0;

/**
 * The Detail header's entry point for Git and GitHub in a repository.
 */
@customElement("caffold-task-detail-git")
export class CaffoldTaskDetailGit extends CaffoldElement {
  @state()
  private accessor available = false;

  static override styles = [
    scopedStyle(compactIconButton, ".task-git-button"),
    scopedStyle(actionIcon, ".task-action-icon"),
    styles,
  ];

  private readonly popoverId = `task-git-actions-${++taskDetailGitInstanceId}`;
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly gitPopover = new DrawnRef<HTMLDivElement>(this);
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
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
          label: "Open Git and GitHub",
          action: ACTION_HINT_ACTION.GIT_OPEN,
        })}
        type="button"
        class="task-git-button"
        popovertarget=${this.popoverId}
        aria-label="Open Git and GitHub"
        title="Open Git and GitHub"
        ?disabled=${!this.available}
      >
        <span class="task-git-icon" aria-hidden="true"></span>
      </button>
      <div
        ${drawn(this.gitPopover)}
        ${this.keyboard.popover({
          id: "git",
          label: "Git and GitHub actions",
          sessionBound: true,
        })}
        id=${this.popoverId}
        class="task-git-popover"
        popover="auto"
        @beforetoggle=${returnPopoverFocus}
        @caffold:keyboard-session-dismiss=${this.handleDismiss}
        role="group"
        aria-label="Git and GitHub actions"
      >
        ${this.destination("Compare", "GitCompareArrows", {
          surface: "git",
          kind: "compare",
        })}
        ${this.destination("Log", "Logs", { surface: "git", kind: "log" })}
        <hr class="task-git-divider">
        ${this.destination("Pull Requests", "GitPullRequest", {
          surface: "github",
          kind: "pulls",
        })}
        ${this.destination("Issues", "CircleDot", {
          surface: "github",
          kind: "issues",
        })}
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  private destination(label: string, icon: string, intent: GitMenuIntent) {
    return html`
      <button
        ${this.hints.button({
          id: intent.kind,
          label,
          action:
            intent.surface === "git"
              ? ACTION_HINT_ACTION.GIT_DESTINATION
              : ACTION_HINT_ACTION.GITHUB_DESTINATION,
          badgeAt: "center-right",
        })}
        type="button"
        popovertarget=${this.popoverId}
        popovertargetaction="hide"
        @click=${() => this.openTool(intent)}
      >${inlineIcon(icon, "", "task-action-icon task-git-action-icon")}<span>${label}</span></button>
    `;
  }

  private handleDismiss(event: Event) {
    if (event.target === this.gitPopover.value) {
      this.deactivate();
    }
  }

  private openTool(intent: GitMenuIntent) {
    this.dispatchEvent(
      new CustomEvent<GitMenuIntent>("caffold:task-detail-git-intent", {
        bubbles: true,
        composed: true,
        detail: intent,
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
