import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { ACTION_HINT_ACTION, ActionHints } from "../../action-hints.js";
import { DrawnRef, drawn } from "../../components/drawn-refs.js";
import { inlineIcon, warmIcons } from "../../components/icons.js";
import { ScrollSurfaces } from "../../scroll-scope.js";
import { KeyboardContexts } from "../context.js";
import { KEYBOARD_SHORTCUT_CLOSE_EVENT } from "../shortcuts.js";
import "./presentation.js";
import "./shortcut-list.js";

export interface KeyboardShortcutCloseDetail {
  reason: string;
  originalEvent: Event;
}

const CLOSE_LABEL = "Close keyboard shortcuts";

/**
 * The keyboard shortcut help, over the whole app. It asks the keyboard
 * navigation to close it, so the shortcut that opened it also closes it.
 */
@customElement("caffold-keyboard-shortcut-dialog")
export class CaffoldKeyboardShortcutDialog extends LitElement {
  // Whether the dialog is closing because the controller asked, which needs
  // no request back.
  private ownerClosed = false;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly closeButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly list = new DrawnRef<HTMLElement>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  override render() {
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({ id: "app:keyboard-shortcuts" })}
      aria-labelledby="keyboard-shortcut-dialog-title"
      aria-describedby="keyboard-shortcut-dialog-description"
      @cancel=${this.handleCancel}
      @close=${this.handleClose}
    >
      <article class="keyboard-shortcut-card">
        <header>
          <div>
            <h2 id="keyboard-shortcut-dialog-title">Keyboard shortcuts</h2>
            <p id="keyboard-shortcut-dialog-description">
              Keyboard navigation is available outside editing fields.
            </p>
          </div>
          <button
            ${drawn(this.closeButton)}
            ${this.hints.button({
              id: "close",
              label: CLOSE_LABEL,
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="button"
            class="keyboard-shortcut-close"
            data-action="close-shortcut-help"
            aria-label=${CLOSE_LABEL}
            title=${CLOSE_LABEL}
            @click=${this.closeFromButton}
          >${inlineIcon("X", CLOSE_LABEL, "keyboard-shortcut-close-icon")}</button>
        </header>
        <caffold-keyboard-shortcut-list
          ${drawn(this.list)}
          ${this.surfaces.surface({
            id: "list",
            label: () => "Keyboard shortcuts",
            clipRoots: () => [this.list.value],
          })}
        ></caffold-keyboard-shortcut-list>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  open() {
    const dialog = this.dialog.value;
    if (!dialog || dialog.open) {
      return false;
    }
    dialog.showModal();
    this.closeButton.value?.focus({ preventScroll: true });
    return true;
  }

  close() {
    const dialog = this.dialog.value;
    if (!dialog?.open) {
      return false;
    }
    this.ownerClosed = true;
    dialog.close();
    return true;
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
      scroll: (pull) => this.surfaces.scope(pull),
    });
  }

  private handleCancel(event: Event) {
    event.preventDefault();
    this.dispatchClose("escape", event);
  }

  // Without recent user activation a browser closes a modal dialog on Escape
  // or a back gesture without a cancel event.
  private handleClose(event: Event) {
    if (this.ownerClosed) {
      this.ownerClosed = false;
      return;
    }
    this.dispatchClose("dialog", event);
  }

  private closeFromButton(event: Event) {
    event.preventDefault();
    this.dispatchClose("button", event);
  }

  private dispatchClose(reason: string, originalEvent: Event) {
    this.dispatchEvent(
      new CustomEvent<KeyboardShortcutCloseDetail>(
        KEYBOARD_SHORTCUT_CLOSE_EVENT,
        {
          bubbles: true,
          composed: true,
          detail: { reason, originalEvent },
        },
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-keyboard-shortcut-dialog": CaffoldKeyboardShortcutDialog;
  }

  interface HTMLElementEventMap {
    [KEYBOARD_SHORTCUT_CLOSE_EVENT]: CustomEvent<KeyboardShortcutCloseDetail>;
  }
}
