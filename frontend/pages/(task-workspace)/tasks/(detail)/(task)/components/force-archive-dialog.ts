import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

import styles from "./force-archive-dialog.css.js";

export interface ForceArchiveConfirmation {
  threadId: string;
  worktreeId: string;
}

interface ForceArchiveTarget extends ForceArchiveConfirmation {
  title: string;
  path: string;
}

// The native dialog owns confirmation. Task Detail owns the mutation and
// rechecks this captured identity before sending it to the server.
@customElement("caffold-task-force-archive-dialog")
export class CaffoldTaskForceArchiveDialog extends CaffoldElement {
  static override styles = styles;

  @state()
  private accessor target: ForceArchiveTarget | null = null;

  private opener: HTMLElement | null = null;
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);

  openTask(target: ForceArchiveTarget, opener?: Element | null) {
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return;
    }
    this.target = { ...target };
    this.opener = opener instanceof HTMLElement ? opener : null;
    dialog.returnValue = "";
    dialog.showModal();
  }

  reset() {
    this.target = null;
    this.opener = null;
    this.dialog.value?.close();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.reset();
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
    });
  }

  override render() {
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({
          id: `force-archive:${this.target?.threadId ?? ""}`,
        })}
        closedby="any"
        aria-labelledby="force-archive-title"
        aria-describedby="force-archive-description"
        @close=${this.handleClose}
      >
        <form method="dialog" class="force-archive-card">
          <h2 id="force-archive-title">Discard changes and archive?</h2>
          <p class="task-title">${this.target?.title ?? ""}</p>
          <p class="worktree-path">${this.target?.path ?? ""}</p>
          <p id="force-archive-description">
            This deletes the Task's worktree folder, including uncommitted
            changes, untracked files, and ignored files.
            Discarded changes cannot be restored.
          </p>
          <p>The conversation and local Git branches will be kept.</p>
          <footer>
            <button
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              value="cancel"
              autofocus
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "confirm",
                label: "Discard changes and archive",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="confirm"
              value="confirm"
            >Discard changes and archive</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private handleClose() {
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return;
    }
    const target = this.target;
    const opener = this.opener;
    this.target = null;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
    if (target && dialog.returnValue === "confirm") {
      this.dispatchEvent(
        new CustomEvent<ForceArchiveConfirmation>(
          "caffold:task-force-archive-confirmed",
          {
            bubbles: true,
            composed: true,
            detail: {
              threadId: target.threadId,
              worktreeId: target.worktreeId,
            },
          },
        ),
      );
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-force-archive-dialog": CaffoldTaskForceArchiveDialog;
  }
  interface HTMLElementEventMap {
    "caffold:task-force-archive-confirmed": CustomEvent<ForceArchiveConfirmation>;
  }
}
