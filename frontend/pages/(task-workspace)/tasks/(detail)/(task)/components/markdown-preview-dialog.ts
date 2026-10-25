import { html, LitElement } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#components/markdown-preview.ts";
import type { CaffoldMarkdownPreview } from "#components/markdown-preview.ts";

// What a Markdown preview opens with: the Markdown, and the control focus
// returns to when the preview closes.
export interface MarkdownPreviewRequest {
  markdown?: string | null;
  opener?: Element | null;
}

/**
 * Markdown an agent wrote, drawn over the Task screen. The dialog belongs to
 * one Task and closes when another Task opens.
 */
export class CaffoldTaskMarkdownPreviewDialog extends LitElement {
  private threadId = "";
  private opener: HTMLElement | null = null;
  private readonly iconsReady = () => this.requestUpdate();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.performUpdate();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  openMarkdown({ markdown, opener }: MarkdownPreviewRequest = {}) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.preview.setMarkdown(markdown, { scroll: { top: 0, left: 0 } });
    const dialog = this.dialog;
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  setThreadId(threadId: string) {
    if (this.threadId && this.threadId !== threadId) {
      this.dismiss();
    }
    this.threadId = threadId;
  }

  // Leaving the Task does not return focus to a conversation that is no
  // longer the one in front of the user.
  dismiss() {
    this.opener = null;
    const dialog = this.dialog;
    if (dialog?.open) {
      dialog.close();
    }
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const preview = this.preview;
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog || !preview || !hintDialog || !hud || !selector) {
      return [];
    }
    const threadId = this.threadId;
    const scopeId = markdownPreviewScopeId(threadId);
    return [
      keyboardNavigationContext({
        id: scopeId,
        kind: "modal",
        root: dialog,
        actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
        scroll: {
          hud,
          selector,
          scope: preview.scrollSurfaceScope({
            scopeId: `${scopeId}:preview`,
            label: "Markdown preview",
            clipRoots: [dialog],
            isCurrent: () =>
              this.isCurrentDialog(dialog, threadId) &&
              this.preview === preview,
          }),
        },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const control = this.closeButton;
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    const threadId = this.threadId;
    const scopeId = markdownPreviewScopeId(threadId);
    const preview = this.preview;
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: [
          buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:close`,
            actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
            label:
              control.getAttribute("aria-label") || "Close Markdown preview",
            control,
            clipRoots: [dialog],
            isActionable: () =>
              this.isCurrentDialog(dialog, threadId) &&
              this.closeButton === control &&
              !control.disabled,
          }),
        ],
        mutationRoots: [this],
        scrollRoots: [],
      },
      preview?.actionHintScope({
        scopeId: `${scopeId}:preview`,
        linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
        clipRoots: [dialog],
        isCurrent: () =>
          this.isCurrentDialog(dialog, threadId) && this.preview === preview,
      }),
    );
  }

  render() {
    const closeLabel = "Close Markdown preview";
    const closeIcon = inlineIcon(
      "X",
      closeLabel,
      "task-markdown-preview-close-icon",
    );
    return html`<dialog
      closedby="any"
      aria-labelledby="task-markdown-preview-title"
      @close=${this.handleClose}
    >
      <article class="task-markdown-preview-card">
        <header class="task-markdown-preview-header">
          <h2
            id="task-markdown-preview-title"
            class="task-markdown-preview-title"
          >Markdown preview</h2>
          <form method="dialog" class="task-markdown-preview-close-form">
            <button
              type="submit"
              class="task-markdown-preview-close"
              aria-label=${closeLabel}
              title=${closeLabel}
            >${closeIcon}</button>
          </form>
        </header>
        <caffold-markdown-preview></caffold-markdown-preview>
      </article>
      <caffold-keyboard-navigation-presentation
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private handleClose() {
    if (this.dialog.open) {
      return;
    }
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }

  private isCurrentDialog(dialog: HTMLDialogElement, threadId: string) {
    return (
      this.isConnected &&
      this.dialog === dialog &&
      dialog.open &&
      Boolean(threadId) &&
      this.threadId === threadId
    );
  }

  private get dialog() {
    return this.querySelector(":scope > dialog") as HTMLDialogElement;
  }

  private get closeButton() {
    return this.dialog?.querySelector<HTMLButtonElement>(
      ".task-markdown-preview-close",
    );
  }

  private get preview() {
    return this.querySelector(
      ":scope > dialog > .task-markdown-preview-card > caffold-markdown-preview",
    ) as CaffoldMarkdownPreview;
  }
}

function markdownPreviewScopeId(threadId: string) {
  return threadId
    ? `task-markdown-preview:${encodeURIComponent(threadId)}`
    : "task-markdown-preview";
}

customElements.define(
  "caffold-task-markdown-preview-dialog",
  CaffoldTaskMarkdownPreviewDialog,
);
