import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";

export const TASK_IMAGE_PREVIEW_EVENT = "caffold:task-image-preview";

export function requestTaskImagePreview(target, image = {}) {
  const src = `${image.src ?? ""}`.trim();
  if (!src) {
    return false;
  }
  target.dispatchEvent(
    new CustomEvent(TASK_IMAGE_PREVIEW_EVENT, {
      bubbles: true,
      composed: true,
      detail: {
        src,
        name: `${image.name ?? ""}`.trim(),
      },
    }),
  );
  return true;
}

class CaffoldTaskImagePreviewDialog extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    if (this.initialized) {
      this.refreshCloseIcon();
      return;
    }

    this.initialized = true;
    this.render();
    this.image().addEventListener("error", () => this.showUnavailable());
    this.dialog().addEventListener("close", () => this.reset());
    warmIcons();
  }

  disconnectedCallback() {
    if (!this.iconsReadyListening) {
      return;
    }
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = false;
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.refreshCloseIcon();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  image() {
    return this.querySelector("[data-task-image-preview-image]");
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    if (!dialog || !hintDialog) {
      return [];
    }
    return [keyboardNavigationContext({
      id: "task-image-preview",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    const control = dialog?.querySelector(".task-image-preview-close");
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: "task-image-preview:close",
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.getAttribute("aria-label") || "Close image preview",
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          dialog.querySelector(".task-image-preview-close") === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  openImage(image = {}) {
    const src = `${image.src ?? ""}`.trim();
    if (!src) {
      return false;
    }
    const name = `${image.name ?? ""}`.trim() || "Attached image";
    const dialog = this.dialog();
    const preview = this.image();
    this.querySelector("[data-task-image-preview-name]").textContent = name;
    this.querySelector("[data-task-image-preview-unavailable]").hidden = true;
    preview.hidden = false;
    preview.alt = name;
    preview.removeAttribute("src");
    preview.src = src;
    if (!dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  dismiss() {
    const dialog = this.dialog();
    if (dialog?.open) {
      dialog.close();
    }
  }

  showUnavailable() {
    this.image().hidden = true;
    this.querySelector("[data-task-image-preview-unavailable]").hidden = false;
  }

  reset() {
    const preview = this.image();
    preview.hidden = false;
    preview.removeAttribute("src");
    preview.alt = "";
    this.querySelector("[data-task-image-preview-name]").textContent = "";
    this.querySelector("[data-task-image-preview-unavailable]").hidden = true;
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-image-preview-title">
        <article class="task-image-preview-card">
          <header class="task-image-preview-header">
            <div>
              <h2 id="task-image-preview-title">Image preview</h2>
              <p data-task-image-preview-name></p>
            </div>
            <form method="dialog">
              <button
                type="submit"
                class="task-image-preview-close"
                aria-label="Close image preview"
                title="Close image preview"
                autofocus
              >${renderInlineIcon(
                "X",
                "Close image preview",
                "task-image-preview-close-icon",
              )}</button>
            </form>
          </header>
          <div class="task-image-preview-body">
            <div class="task-image-preview-viewport">
              <img data-task-image-preview-image alt="">
              <p class="task-image-preview-unavailable" data-task-image-preview-unavailable hidden>
                Image preview unavailable.
              </p>
            </div>
          </div>
        </article>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  refreshCloseIcon() {
    const closeButton = this.querySelector(".task-image-preview-close");
    if (closeButton) {
      closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close image preview",
        "task-image-preview-close-icon",
      );
    }
  }
}

if (!customElements.get("caffold-task-image-preview-dialog")) {
  customElements.define(
    "caffold-task-image-preview-dialog",
    CaffoldTaskImagePreviewDialog,
  );
}
