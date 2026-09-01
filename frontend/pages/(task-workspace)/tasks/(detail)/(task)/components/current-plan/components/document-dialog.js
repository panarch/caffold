import { readFile } from "../../../../../../../../api.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../components/icons.js";
import "../../../../../../../../components/markdown-preview.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../../../../../scroll-scope.js";
import {
  keyboardNavigationContext,
} from "../../../../../../keyboard-navigation-context.js";
import "../../../../../../components/keyboard-navigation-presentation.js";

class CaffoldCurrentPlanDocumentDialog extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    if (this.initialized) {
      this.refreshCloseIcon();
      return;
    }
    this.initialized = true;
    this.requestId = 0;
    this.requestController = null;
    this.current = null;
    this.opener = null;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
    this.addEventListener("click", (event) => {
      if (event.target.closest?.('[data-current-plan-dialog-action="retry"]')) {
        void this.loadCurrent({ preserveScroll: true });
      }
    });
    warmIcons();
  }

  disconnectedCallback() {
    this.deactivate();
    if (this.iconsReadyListening) {
      window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
      this.iconsReadyListening = false;
    }
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

  preview() {
    return this.querySelector(":scope > dialog caffold-markdown-preview");
  }

  actionHintScope() {
    const dialog = this.dialog();
    const path = `${this.current?.path ?? ""}`;
    if (!dialog) {
      return emptyActionHintScope();
    }
    const controls = [
      ["close", ".current-plan-document-close"],
      ["retry", '[data-current-plan-dialog-action="retry"]'],
    ];
    return {
      blocked: false,
      targets: controls.flatMap(([identity, selector]) => {
        const control = dialog.querySelector(selector);
        if (!control) {
          return [];
        }
        return [buttonActionHintTarget({
          id: `current-plan-document:${encodeURIComponent(path)}:${identity}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.getAttribute("aria-label") ||
            control.textContent?.trim() || identity,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog() === dialog &&
            dialog.open &&
            this.current?.path === path &&
            Boolean(path) &&
            dialog.querySelector(selector) === control &&
            hasActionHintLayoutBox(control) &&
            !control.disabled,
        })];
      }),
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const preview = this.preview();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    if (!dialog || !preview || !hintDialog || !hud) {
      return [];
    }
    const path = `${this.current?.path ?? ""}`;
    const label = `${this.current?.label ?? "Document"}`.trim() || "Document";
    const scope = !path
      ? emptyScrollSurfaceScope()
      : {
          blocked: false,
          surfaces: [{
            id: `current-plan:${path}:preview`,
            label: `${label} document`,
            scrollport: preview,
            clipRoots: [dialog, preview],
            isEligible: () =>
              this.isConnected &&
              this.dialog() === dialog &&
              dialog.open &&
              this.current?.path === path &&
              this.preview() === preview &&
              !preview.hidden &&
              hasScrollLayoutBox(dialog) &&
              hasScrollLayoutBox(preview) &&
              hasVerticalScrollOverflow(preview),
          }],
          mutationRoots: [this, dialog, preview],
          resizeElements: [dialog, preview],
          scrollRoots: [preview],
        };
    return [keyboardNavigationContext({
      id: path ? `current-plan-document:${path}` : "current-plan-document",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
      scroll: { hud, scope },
    })];
  }

  openDocument({ label, document, displayPath, opener } = {}) {
    const path = `${document?.path ?? ""}`.trim();
    if (!path) {
      return false;
    }
    this.current = {
      label: `${label ?? document?.name ?? "Document"}`.trim() || "Document",
      path,
      displayPath: `${displayPath ?? ""}`.trim() || path,
      name: `${document?.name ?? ""}`.trim(),
    };
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.patchHeader();
    this.showLoading({ preserveContent: false });
    const dialog = this.dialog();
    if (!dialog.open) {
      dialog.showModal();
    }
    void this.loadCurrent();
    return true;
  }

  refreshOpenDocument() {
    if (!this.dialog()?.open || !this.current) {
      return;
    }
    void this.loadCurrent({ preserveScroll: true });
  }

  deactivate() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.opener = null;
    this.current = null;
    if (this.dialog()?.open) {
      this.dialog().close("deactivate");
    }
  }

  async loadCurrent({ preserveScroll = false } = {}) {
    const current = this.current;
    if (!current) {
      return;
    }
    const requestId = ++this.requestId;
    this.requestController?.abort();
    const controller = new AbortController();
    this.requestController = controller;
    const scroll = preserveScroll ? this.preview()?.getScrollState?.() : null;
    this.showLoading({ preserveContent: preserveScroll });
    try {
      const file = await readFile(current.path, controller.signal);
      if (!this.acceptRequest(requestId, current.path)) {
        return;
      }
      this.requestController = null;
      this.querySelector("[data-current-plan-dialog-status]").hidden = true;
      this.querySelector("[data-current-plan-dialog-error]").hidden = true;
      const preview = this.preview();
      preview.hidden = false;
      preview.setMarkdown(file.content, { scroll });
    } catch (error) {
      if (!this.acceptRequest(requestId, current.path) || error?.name === "AbortError") {
        return;
      }
      this.requestController = null;
      const message = this.querySelector("[data-current-plan-dialog-error-message]");
      message.textContent = error?.message ?? `${error}`;
      this.querySelector("[data-current-plan-dialog-status]").hidden = true;
      this.querySelector("[data-current-plan-dialog-error]").hidden = false;
      if (!preserveScroll) {
        this.preview().hidden = true;
      }
    }
  }

  acceptRequest(requestId, path) {
    return (
      requestId === this.requestId &&
      this.current?.path === path &&
      this.dialog()?.open
    );
  }

  showLoading({ preserveContent }) {
    const status = this.querySelector("[data-current-plan-dialog-status]");
    status.textContent = preserveContent ? "Refreshing document..." : "Loading document...";
    status.hidden = false;
    this.querySelector("[data-current-plan-dialog-error]").hidden = true;
    if (!preserveContent) {
      this.preview().hidden = true;
    }
  }

  patchHeader() {
    this.querySelector("[data-current-plan-dialog-title]").textContent = this.current.label;
    const path = this.querySelector("[data-current-plan-dialog-path]");
    path.textContent = this.current.displayPath;
    path.title = this.current.path;
  }

  handleClose() {
    this.requestId += 1;
    this.requestController?.abort();
    this.requestController = null;
    const opener = this.opener;
    this.opener = null;
    this.current = null;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="current-plan-document-title">
        <article class="current-plan-document-card">
          <header>
            <div>
              <h2 id="current-plan-document-title" data-current-plan-dialog-title>Plan</h2>
              <p data-current-plan-dialog-path></p>
            </div>
            <form method="dialog">
              <button
                type="submit"
                class="current-plan-document-close"
                aria-label="Close document"
                title="Close document"
              >${renderInlineIcon(
                "X",
                "Close document",
                "current-plan-document-close-icon",
              )}</button>
            </form>
          </header>
          <div class="current-plan-document-body">
            <p class="current-plan-document-status" role="status" data-current-plan-dialog-status>
              Loading document...
            </p>
            <div class="current-plan-document-error" role="alert" data-current-plan-dialog-error hidden>
              <p data-current-plan-dialog-error-message></p>
              <button type="button" data-current-plan-dialog-action="retry">Retry</button>
            </div>
            <caffold-markdown-preview hidden></caffold-markdown-preview>
          </div>
        </article>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  refreshCloseIcon() {
    const closeButton = this.querySelector(".current-plan-document-close");
    if (closeButton) {
      closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close document",
        "current-plan-document-close-icon",
      );
    }
  }
}

if (!customElements.get("caffold-current-plan-document-dialog")) {
  customElements.define(
    "caffold-current-plan-document-dialog",
    CaffoldCurrentPlanDocumentDialog,
  );
}
