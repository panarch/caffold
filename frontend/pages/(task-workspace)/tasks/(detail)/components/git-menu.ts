import { html, LitElement } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { compactIconButton } from "#app/component-styles.ts";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";

// What the menu asks the Detail layout to open.
export interface GitMenuIntent {
  type: "open-git-tool";
  reviewKind: string | null;
}

const GIT_DESTINATIONS = ["compare", "log"];

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
    const popover = this.gitPopover;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  actionHintScope({
    scopeId = "task-detail",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const control = this.gitTrigger;
    const popover = this.gitPopover;
    if (!scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:git:open`,
          actionId: ACTION_HINT_ACTION.GIT_OPEN,
          label: control.getAttribute("aria-label") || "Open Git workspace",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            this.available &&
            this.gitTrigger === control &&
            this.gitPopover === popover &&
            control.getAttribute("popovertarget") === popover.id &&
            !control.disabled &&
            !popover.matches(":popover-open"),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({
    scopeId = "task-detail",
  }: {
    scopeId?: string;
  } = {}) {
    this.performUpdate();
    const popover = this.gitPopover;
    const presentation =
      popover?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!scopeId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:git`;
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: this.gitActionHintScope(contextId, popover),
          sessionBound: true,
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "Git workspace actions",
            popover,
            isCurrent: () =>
              this.isConnected && this.available && this.gitPopover === popover,
          }),
        },
      }),
    ];
  }

  render() {
    return html`
      <button
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
        id=${this.popoverId}
        class="task-git-popover"
        popover="auto"
        role="group"
        aria-label="Git workspace actions"
      >
        <button
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="compare"
          @click=${this.openTool}
        >Compare</button>
        <button
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-git-button-action
          data-review-kind="log"
          @click=${this.openTool}
        >Log</button>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  private gitActionHintScope(
    contextId: string,
    popover: HTMLElement,
  ): ActionHintScope {
    const targets = [
      ...popover.querySelectorAll<HTMLButtonElement>(
        ":scope > button[data-git-button-action]",
      ),
    ].flatMap((control) => {
      const destination = `${control.dataset.reviewKind ?? ""}`;
      if (!GIT_DESTINATIONS.includes(destination) || control.disabled) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${contextId}:${destination}`,
          actionId: ACTION_HINT_ACTION.GIT_DESTINATION,
          label: control.textContent?.trim() || destination,
          control,
          clipRoots: [popover],
          badgeAtEnd: true,
          isActionable: () =>
            this.isConnected &&
            this.available &&
            this.gitPopover === popover &&
            popover.matches(":popover-open") &&
            popover.contains(control) &&
            control.dataset.reviewKind === destination &&
            !control.disabled,
        }),
      ];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [popover],
      scrollRoots: [popover],
    };
  }

  private handleDismiss(event: Event) {
    if (event.target === this.gitPopover) {
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

  private get gitTrigger() {
    return this.querySelector<HTMLButtonElement>(":scope > .task-git-button");
  }

  private get gitPopover() {
    return this.querySelector<HTMLElement>(":scope > .task-git-popover");
  }
}

await compactIconButton.register(
  "caffold-task-detail-git",
  "> .task-git-button",
);

customElements.define("caffold-task-detail-git", CaffoldTaskDetailGit);
