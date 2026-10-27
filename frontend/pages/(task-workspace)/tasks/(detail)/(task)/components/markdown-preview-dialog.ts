import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import { KeyboardContexts } from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
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
  static properties = {
    threadId: { state: true },
  };

  declare private threadId: string;
  private opener: HTMLElement | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly preview = new DrawnRef<CaffoldMarkdownPreview>(this);

  constructor() {
    super();
    this.threadId = "";
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  openMarkdown({ markdown, opener }: MarkdownPreviewRequest = {}) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.preview.value?.setMarkdown(markdown, { scroll: { top: 0, left: 0 } });
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
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
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) =>
        mergeActionHintScopes(
          this.hints.scope(pull),
          this.preview.value?.actionHintScope({
            ...pull,
            scopeId: `${pull.scopeId}:preview`,
            actions: { link: ACTION_HINT_ACTION.LINK_OPEN },
          }),
        ),
      scroll: (pull) =>
        this.preview.value?.scrollSurfaceScope({
          ...pull,
          scopeId: `${pull.scopeId}:preview`,
          label: "Markdown preview",
        }) ?? emptyScrollSurfaceScope(),
    });
  }

  render() {
    const closeLabel = "Close Markdown preview";
    const closeIcon = inlineIcon(
      "X",
      closeLabel,
      "task-markdown-preview-close-icon",
    );
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: this.threadId
          ? `task-markdown-preview:${encodeURIComponent(this.threadId)}`
          : "task-markdown-preview",
      })}
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
              ${this.hints.button({
                id: "close",
                label: closeLabel,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="task-markdown-preview-close"
              aria-label=${closeLabel}
              title=${closeLabel}
            >${closeIcon}</button>
          </form>
        </header>
        <caffold-markdown-preview
          ${drawn(this.preview)}
        ></caffold-markdown-preview>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private handleClose() {
    if (this.dialog.value?.open) {
      return;
    }
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }
}

customElements.define(
  "caffold-task-markdown-preview-dialog",
  CaffoldTaskMarkdownPreviewDialog,
);
