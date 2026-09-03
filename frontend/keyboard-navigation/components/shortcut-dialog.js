import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import { KEYBOARD_SHORTCUT_CLOSE_EVENT } from "../shortcuts.js";
import "./shortcut-list.js";

class CaffoldKeyboardShortcutDialog extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.attachIconListener();
    this.refreshCloseIcon();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.dialog.addEventListener("cancel", this.boundCancel);
    this.dialog.addEventListener("click", this.boundClick);
    void warmIcons();
  }

  disconnectedCallback() {
    if (this.iconsReadyListening) {
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
      this.iconsReadyListening = false;
    }
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.dialog.removeEventListener("cancel", this.boundCancel);
    this.dialog.removeEventListener("click", this.boundClick);
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.boundCancel = (event) => {
      event.preventDefault();
      this.dispatchClose("escape", event);
    };
    this.boundClick = (event) => {
      const close = event.target instanceof Element
        ? event.target.closest('button[data-action="close-shortcut-help"]')
        : null;
      if (!close || !this.dialog.contains(close)) {
        return;
      }
      event.preventDefault();
      this.dispatchClose("button", event);
    };
    this.innerHTML = `
      <dialog
        aria-labelledby="keyboard-shortcut-dialog-title"
        aria-describedby="keyboard-shortcut-dialog-description"
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
              type="button"
              class="keyboard-shortcut-close"
              data-action="close-shortcut-help"
              aria-label="Close keyboard shortcuts"
              title="Close keyboard shortcuts"
            >${renderInlineIcon(
              "X",
              "Close keyboard shortcuts",
              "keyboard-shortcut-close-icon",
            )}</button>
          </header>
          <caffold-keyboard-shortcut-list></caffold-keyboard-shortcut-list>
        </article>
      </dialog>
    `;
    this.dialog = this.querySelector(":scope > dialog");
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.refreshCloseIcon();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  refreshCloseIcon() {
    const close = this.dialog?.querySelector(
      ':scope button[data-action="close-shortcut-help"]',
    );
    if (close) {
      close.innerHTML = renderInlineIcon(
        "X",
        "Close keyboard shortcuts",
        "keyboard-shortcut-close-icon",
      );
    }
  }

  open() {
    this.ensureRendered();
    if (this.dialog.open) {
      return false;
    }
    this.dialog.showModal();
    this.dialog.querySelector(
      ':scope button[data-action="close-shortcut-help"]',
    )?.focus({ preventScroll: true });
    return true;
  }

  close() {
    if (!this.dialog?.open) {
      return false;
    }
    this.dialog.close();
    return true;
  }

  allowsNativeActivation(event) {
    return Boolean(
      (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        this.dialog?.contains(event.target)
    );
  }

  dispatchClose(reason, originalEvent) {
    this.dispatchEvent(
      new CustomEvent(KEYBOARD_SHORTCUT_CLOSE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { reason, originalEvent },
      }),
    );
  }
}

if (!customElements.get("caffold-keyboard-shortcut-dialog")) {
  customElements.define(
    "caffold-keyboard-shortcut-dialog",
    CaffoldKeyboardShortcutDialog,
  );
}
