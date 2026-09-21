import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import {
  forgetTaskPermissionInstructions,
  getTaskPermissionInstructions,
} from "../../../../../../api.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../../action-hints.js";
import { emptyScrollSurfaceScope } from "../../../../../../scroll-scope.js";
import { keyboardNavigationContext } from "../../../../../../keyboard-navigation.js";
import "../../../../../../keyboard-navigation/components/presentation.js";

const EMPTY_MESSAGE =
  "Nothing yet. A prompt that says what this Task may do is kept here while it runs under Ask Jev first.";

/**
 * What this Task's own prompts permitted, for a person to read and to forget.
 *
 * The record grows with the conversation, so it is read here rather than in the
 * Task details popover it opens from: a popover is for the facts that fit
 * beside it, and this is a page of the person's own sentences.
 */
class CaffoldTaskPermissionInstructionsDialog extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    if (this.initialized) {
      this.refreshCloseIcon();
      return;
    }
    this.initialized = true;
    this.threadId = "";
    this.opener = null;
    this.request = 0;
    this.state = { loading: false, instructions: null, error: "" };
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
    this.addEventListener("click", (event) => this.handleClick(event));
    warmIcons();
  }

  disconnectedCallback() {
    this.request += 1;
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

  open({ threadId, opener } = {}) {
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.threadId = `${threadId ?? ""}`;
    const dialog = this.dialog();
    if (!dialog.open) {
      dialog.showModal();
    }
    void this.load();
  }

  setThreadId(threadId) {
    const nextThreadId = `${threadId ?? ""}`;
    if (this.threadId && this.threadId !== nextThreadId) {
      this.dismiss();
    }
    this.threadId = nextThreadId;
  }

  // Leaving the Task does not return focus to a conversation that is no longer
  // the one in front of the user.
  dismiss() {
    this.opener = null;
    this.request += 1;
    const dialog = this.dialog();
    if (dialog?.open) {
      dialog.close();
    }
  }

  handleClose() {
    if (this.dialog()?.open) {
      return;
    }
    this.request += 1;
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }

  handleClick(event) {
    const button = event.target.closest(
      'button[data-permission-instructions-action="forget"]',
    );
    if (!button || button.disabled) {
      return;
    }
    void this.forget();
  }

  async load() {
    const threadId = this.threadId;
    if (!threadId) {
      return;
    }
    const request = ++this.request;
    this.state = { loading: true, instructions: null, error: "" };
    this.patch();
    try {
      const payload = await getTaskPermissionInstructions(threadId);
      if (!this.isCurrent(request, threadId)) {
        return;
      }
      this.state = {
        loading: false,
        instructions: instructionsOf(payload),
        error: "",
      };
    } catch (error) {
      if (!this.isCurrent(request, threadId)) {
        return;
      }
      this.state = {
        loading: false,
        instructions: null,
        error: error?.message ?? "Caffold could not read what this Task permitted.",
      };
    }
    this.patch();
  }

  async forget() {
    const threadId = this.threadId;
    if (!threadId) {
      return;
    }
    const request = ++this.request;
    this.state = { ...this.state, loading: true, error: "" };
    this.patch();
    try {
      const payload = await forgetTaskPermissionInstructions(threadId);
      if (!this.isCurrent(request, threadId)) {
        return;
      }
      this.state = {
        loading: false,
        instructions: instructionsOf(payload),
        error: "",
      };
    } catch (error) {
      if (!this.isCurrent(request, threadId)) {
        return;
      }
      this.state = {
        ...this.state,
        loading: false,
        error: error?.message ?? "Caffold could not forget what this Task permitted.",
      };
    }
    this.patch();
  }

  isCurrent(request, threadId) {
    return (
      this.isConnected &&
      request === this.request &&
      this.threadId === threadId &&
      Boolean(this.dialog()?.open)
    );
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
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
      id: scopeId(this.threadId),
      kind: "modal",
      root: dialog,
      actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
      scroll: { hud, selector, scope: emptyScrollSurfaceScope() },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    if (!dialog?.open) {
      return emptyActionHintScope();
    }
    const threadId = `${this.threadId ?? ""}`;
    const targets = [
      [".task-permission-instructions-close", "Close what this Task permitted"],
      [
        'button[data-permission-instructions-action="forget"]',
        "Forget what this Task permitted",
      ],
    ].flatMap(([selector, label]) => {
      const control = dialog.querySelector(selector);
      if (!control || control.disabled || control.hidden) {
        return [];
      }
      return [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId(threadId)}:${selector}`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.getAttribute("aria-label") || label,
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          `${this.threadId ?? ""}` === threadId &&
          dialog.querySelector(selector) === control &&
          !control.disabled &&
          !control.hidden,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  render() {
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-permission-instructions-title">
        <article class="task-permission-instructions-card">
          <header class="task-permission-instructions-header">
            <h2 id="task-permission-instructions-title" class="task-permission-instructions-title">What this Task's prompts permitted</h2>
            <form method="dialog" class="task-permission-instructions-close-form">
              <button
                type="submit"
                class="task-permission-instructions-close"
                aria-label="Close what this Task permitted"
                title="Close what this Task permitted"
              >${renderInlineIcon(
                "X",
                "Close what this Task permitted",
                "task-permission-instructions-close-icon",
              )}</button>
            </form>
          </header>
          <p class="task-permission-instructions-note">
            Your own messages, oldest first. A later one overrides an earlier one it
            contradicts. Jev reads these before your extra rules when it answers a
            permission request for this Task.
          </p>
          <div class="task-permission-instructions-body">
            <pre class="task-permission-instructions-text"></pre>
          </div>
          <p class="task-permission-instructions-error" role="alert" hidden></p>
          <footer class="task-permission-instructions-footer">
            <button
              type="button"
              class="task-secondary-button"
              data-permission-instructions-action="forget"
            >Forget these</button>
          </footer>
        </article>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  patch() {
    const text = this.querySelector(".task-permission-instructions-text");
    const error = this.querySelector(".task-permission-instructions-error");
    const forget = this.querySelector(
      'button[data-permission-instructions-action="forget"]',
    );
    if (!text || !error || !forget) {
      return;
    }
    const { loading, instructions, message } = presentation(this.state);
    text.textContent = message;
    text.dataset.empty = String(!instructions);
    error.textContent = this.state.error;
    error.hidden = !this.state.error;
    forget.disabled = loading || !instructions;
  }

  refreshCloseIcon() {
    const close = this.querySelector(".task-permission-instructions-close");
    if (close) {
      close.innerHTML = renderInlineIcon(
        "X",
        "Close what this Task permitted",
        "task-permission-instructions-close-icon",
      );
    }
  }
}

function presentation(state) {
  if (state.loading) {
    return { loading: true, instructions: null, message: "Reading..." };
  }
  const instructions = `${state.instructions ?? ""}`.trim();
  return {
    loading: false,
    instructions: instructions || null,
    message: instructions || EMPTY_MESSAGE,
  };
}

function instructionsOf(payload) {
  const instructions = payload?.instructions;
  return typeof instructions === "string" ? instructions : null;
}

function scopeId(threadId) {
  return threadId
    ? `task-permission-instructions:${encodeURIComponent(threadId)}`
    : "task-permission-instructions";
}

if (!customElements.get("caffold-task-permission-instructions-dialog")) {
  customElements.define(
    "caffold-task-permission-instructions-dialog",
    CaffoldTaskPermissionInstructionsDialog,
  );
}
