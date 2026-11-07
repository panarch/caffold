import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "./mermaid-preview-dialog/components/mermaid-diagram.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { CaffoldTaskMermaidDiagram } from "./mermaid-preview-dialog/components/mermaid-diagram.js";

import styles from "./mermaid-preview-dialog.css.js";

// What a Mermaid preview opens with: the diagram's source, and the control
// focus returns to when the preview closes.
export interface MermaidPreviewRequest {
  source?: string | null;
  opener?: Element | null;
}

/**
 * A Mermaid diagram an agent wrote, drawn over the Task screen. The dialog
 * belongs to one Task and closes when another Task opens.
 */
@customElement("caffold-task-mermaid-preview-dialog")
export class CaffoldTaskMermaidPreviewDialog extends CaffoldElement {
  @state()
  private accessor threadId = "";

  static override styles = styles;

  private opener: HTMLElement | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly diagram = new DrawnRef<CaffoldTaskMermaidDiagram>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  openMermaid({ source, opener }: MermaidPreviewRequest = {}) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    const diagram = this.diagram.value;
    if (diagram) {
      diagram.source = `${source ?? ""}`;
      diagram.active = true;
    }
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
          this.diagram.value?.actionHintScope({
            ...pull,
            scopeId: `${pull.scopeId}:diagram`,
          }),
        ),
      scroll: (pull) =>
        this.diagram.value?.scrollSurfaceScope({
          ...pull,
          scopeId: `${pull.scopeId}:diagram`,
          label: "Mermaid preview",
        }) ?? emptyScrollSurfaceScope(),
    });
  }

  override render() {
    const closeLabel = "Close Mermaid preview";
    const closeIcon = inlineIcon(
      "X",
      closeLabel,
      "task-mermaid-preview-close-icon",
    );
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: this.threadId
          ? `task-mermaid-preview:${encodeURIComponent(this.threadId)}`
          : "task-mermaid-preview",
      })}
      closedby="any"
      aria-labelledby="task-mermaid-preview-title"
      @close=${this.handleClose}
    >
      <article class="task-mermaid-preview-card">
        <header class="task-mermaid-preview-header">
          <h2
            id="task-mermaid-preview-title"
            class="task-mermaid-preview-title"
          >Mermaid preview</h2>
          <form method="dialog" class="task-mermaid-preview-close-form">
            <button
              ${this.hints.button({
                id: "close",
                label: closeLabel,
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="task-mermaid-preview-close"
              aria-label=${closeLabel}
              title=${closeLabel}
            >${closeIcon}</button>
          </form>
        </header>
        <caffold-task-mermaid-diagram
          ${drawn(this.diagram)}
        ></caffold-task-mermaid-diagram>
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
    const diagram = this.diagram.value;
    if (diagram) {
      diagram.active = false;
    }
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-mermaid-preview-dialog": CaffoldTaskMermaidPreviewDialog;
  }
}
