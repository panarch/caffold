import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../action-hints.js";
import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../scroll-scope.js";
import { keyboardNavigationContext } from "../context.js";
import { KEYBOARD_SHORTCUT_CLOSE_EVENT } from "../shortcuts.js";
import "./presentation.js";
import "./shortcut-list.js";

const CLOSE_SELECTOR = ':scope button[data-action="close-shortcut-help"]';

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
    this.dialog.addEventListener("close", this.boundNativeClose);
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
    this.dialog.removeEventListener("close", this.boundNativeClose);
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
    // Without recent user activation a browser closes a modal dialog on Escape
    // or a back gesture without a cancel event.
    this.boundNativeClose = (event) => {
      if (this.ownerClosed) {
        this.ownerClosed = false;
        return;
      }
      this.dispatchClose("dialog", event);
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
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
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
    const close = this.dialog?.querySelector(CLOSE_SELECTOR);
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
    this.dialog.querySelector(CLOSE_SELECTOR)?.focus({ preventScroll: true });
    return true;
  }

  close() {
    if (!this.dialog?.open) {
      return false;
    }
    this.ownerClosed = true;
    this.dialog.close();
    return true;
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!dialog || !hintDialog || !hud || !selector) {
      return [];
    }
    return [keyboardNavigationContext({
      id: "app:keyboard-shortcuts",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
      scroll: {
        hud,
        selector,
        scope: this.scrollSurfaceScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog;
    const control = dialog?.querySelector(CLOSE_SELECTOR);
    if (!control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: "app:keyboard-shortcuts:close",
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.getAttribute("aria-label") || "Close keyboard shortcuts",
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog === dialog &&
          dialog.open &&
          dialog.querySelector(CLOSE_SELECTOR) === control,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope() {
    const dialog = this.dialog;
    const scrollport = dialog?.querySelector(
      ":scope > .keyboard-shortcut-card > caffold-keyboard-shortcut-list",
    );
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: "app:keyboard-shortcuts:list",
        label: "Keyboard shortcuts",
        scrollport,
        clipRoots: [dialog, scrollport],
        isEligible: () =>
          this.isConnected &&
          this.dialog === dialog &&
          dialog.open &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
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
