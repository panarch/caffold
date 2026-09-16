import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import "../../../../../../components/markdown-preview.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../action-hints.js";
import { emptyScrollSurfaceScope } from "../../../../../../scroll-scope.js";
import { keyboardNavigationContext } from "../../../../../../keyboard-navigation.js";
import "../../../../../../keyboard-navigation/components/presentation.js";

class CaffoldTaskMarkdownPreviewDialog extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    if (this.initialized) {
      this.refreshCloseIcon();
      return;
    }

    this.initialized = true;
    this.threadId = "";
    this.opener = null;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
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

  openMarkdown({ markdown, opener } = {}) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.preview().setMarkdown(markdown, { scroll: { top: 0, left: 0 } });
    const dialog = this.dialog();
    if (!dialog.open) {
      dialog.showModal();
    }
  }

  setThreadId(threadId) {
    const nextThreadId = `${threadId ?? ""}`;
    if (this.threadId && this.threadId !== nextThreadId) {
      this.dismiss();
    }
    this.threadId = nextThreadId;
  }

  // Leaving the Task does not return focus to a conversation that is no
  // longer the one in front of the user.
  dismiss() {
    this.opener = null;
    const dialog = this.dialog();
    if (dialog?.open) {
      dialog.close();
    }
  }

  handleClose() {
    if (this.dialog()?.open) {
      return;
    }
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const preview = this.preview();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!dialog || !preview || !hintDialog || !hud || !selector) {
      return [];
    }
    const threadId = `${this.threadId ?? ""}`;
    const scopeId = markdownPreviewScopeId(threadId);
    return [keyboardNavigationContext({
      id: scopeId,
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
      scroll: {
        hud,
        selector,
        scope: preview.scrollSurfaceScope?.({
          scopeId: `${scopeId}:preview`,
          label: "Markdown preview",
          clipRoots: [dialog],
          isCurrent: () =>
            this.isCurrentDialog(dialog, threadId) &&
            this.preview() === preview,
        }) ?? emptyScrollSurfaceScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    const control = dialog?.querySelector(".task-markdown-preview-close");
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    const threadId = `${this.threadId ?? ""}`;
    const scopeId = markdownPreviewScopeId(threadId);
    const preview = this.preview();
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: [buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:close`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.getAttribute("aria-label") || "Close Markdown preview",
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isCurrentDialog(dialog, threadId) &&
            dialog.querySelector(".task-markdown-preview-close") === control &&
            !control.disabled,
        })],
        mutationRoots: [this],
        scrollRoots: [],
      },
      preview?.actionHintScope?.({
        scopeId: `${scopeId}:preview`,
        linkActionId: ACTION_HINT_ACTION.LINK_OPEN,
        clipRoots: [dialog],
        isCurrent: () =>
          this.isCurrentDialog(dialog, threadId) &&
          this.preview() === preview,
      }),
    );
  }

  isCurrentDialog(dialog, threadId) {
    return (
      this.isConnected &&
      this.dialog() === dialog &&
      dialog.open &&
      Boolean(threadId) &&
      `${this.threadId ?? ""}` === threadId
    );
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  preview() {
    return this.querySelector(
      ":scope > dialog > .task-markdown-preview-card > caffold-markdown-preview",
    );
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-markdown-preview-title">
        <article class="task-markdown-preview-card">
          <header class="task-markdown-preview-header">
            <h2 id="task-markdown-preview-title" class="task-markdown-preview-title">Markdown preview</h2>
            <form method="dialog" class="task-markdown-preview-close-form">
              <button
                type="submit"
                class="task-markdown-preview-close"
                aria-label="Close Markdown preview"
                title="Close Markdown preview"
              >${renderInlineIcon(
                "X",
                "Close Markdown preview",
                "task-markdown-preview-close-icon",
              )}</button>
            </form>
          </header>
          <caffold-markdown-preview></caffold-markdown-preview>
        </article>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  refreshCloseIcon() {
    const closeButton = this.querySelector(".task-markdown-preview-close");
    if (closeButton) {
      closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close Markdown preview",
        "task-markdown-preview-close-icon",
      );
    }
  }
}

function markdownPreviewScopeId(threadId) {
  return threadId
    ? `task-markdown-preview:${encodeURIComponent(threadId)}`
    : "task-markdown-preview";
}

if (!customElements.get("caffold-task-markdown-preview-dialog")) {
  customElements.define(
    "caffold-task-markdown-preview-dialog",
    CaffoldTaskMarkdownPreviewDialog,
  );
}
