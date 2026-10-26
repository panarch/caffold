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
export interface GitHubMenuIntent {
  type: "open-github-tool";
  reviewKind: string | null;
}

const GITHUB_DESTINATIONS = ["pulls", "issues"];

let taskDetailGithubInstanceId = 0;

/**
 * The Detail header's GitHub button, and the popover of GitHub work it
 * opens: Pull Requests and Issues.
 *
 * The Detail layout hands it whether GitHub is available and reads it right
 * after, so it draws at once.
 */
export class CaffoldTaskDetailGithub extends LitElement {
  private available = false;
  private readonly popoverId =
    `task-github-actions-${++taskDetailGithubInstanceId}`;

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
    const popover = this.githubPopover;
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
    const control = this.githubTrigger;
    const popover = this.githubPopover;
    if (!scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:github:open`,
          actionId: ACTION_HINT_ACTION.GITHUB_OPEN,
          label: control.getAttribute("aria-label") || "Open GitHub workspace",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            this.available &&
            this.githubTrigger === control &&
            this.githubPopover === popover &&
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
    const popover = this.githubPopover;
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
    const contextId = `${scopeId}:github`;
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: this.githubActionHintScope(contextId, popover),
          sessionBound: true,
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "GitHub workspace actions",
            popover,
            isCurrent: () =>
              this.isConnected &&
              this.available &&
              this.githubPopover === popover,
          }),
        },
      }),
    ];
  }

  render() {
    return html`
      <button
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
        id=${this.popoverId}
        class="task-github-popover"
        popover="auto"
        role="group"
        aria-label="GitHub workspace actions"
      >
        <button
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="pulls"
          @click=${this.openTool}
        >Pull Requests</button>
        <button
          type="button"
          popovertarget=${this.popoverId}
          popovertargetaction="hide"
          data-github-button-action
          data-review-kind="issues"
          @click=${this.openTool}
        >Issues</button>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  private githubActionHintScope(
    contextId: string,
    popover: HTMLElement,
  ): ActionHintScope {
    const targets = [
      ...popover.querySelectorAll<HTMLButtonElement>(
        ":scope > button[data-github-button-action]",
      ),
    ].flatMap((control) => {
      const destination = `${control.dataset.reviewKind ?? ""}`;
      if (!GITHUB_DESTINATIONS.includes(destination) || control.disabled) {
        return [];
      }
      return [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${contextId}:${destination}`,
          actionId: ACTION_HINT_ACTION.GITHUB_DESTINATION,
          label: control.textContent?.trim() || destination,
          control,
          clipRoots: [popover],
          badgeAtEnd: true,
          isActionable: () =>
            this.isConnected &&
            this.available &&
            this.githubPopover === popover &&
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
    if (event.target === this.githubPopover) {
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

  private get githubTrigger() {
    return this.querySelector<HTMLButtonElement>(
      ":scope > .task-github-button",
    );
  }

  private get githubPopover() {
    return this.querySelector<HTMLElement>(":scope > .task-github-popover");
  }
}

await compactIconButton.register(
  "caffold-task-detail-github",
  "> .task-github-button",
);

customElements.define("caffold-task-detail-github", CaffoldTaskDetailGithub);
