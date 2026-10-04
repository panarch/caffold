import "#tasks/components/task-turn-options.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "#app/scroll-scope.js";
import "#app/keyboard-navigation/components/presentation.js";

const SCOPE_ID = "caffold-update-task";

/**
 * Starts a Task in which an agent updates Caffold and stays with it. The
 * dialog confirms the update and chooses the agent; the workspace creates the
 * Task through the Tasks page, as Start Task does.
 */
class CaffoldUpdateTaskDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.update = null;
    this.opener = null;
    this.pending = false;
    this.error = null;
    this.createRequestId = 0;
    this.render();
    this.dialog().addEventListener("close", () => this.handleClose());
    this.dialog().addEventListener("cancel", (event) => {
      if (this.pending) {
        event.preventDefault();
      }
    });
    this.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-update-task-dialog-action]");
      if (action?.dataset.updateTaskDialogAction === "cancel" && !this.pending) {
        this.dialog().close("cancel");
      }
    });
    this.addEventListener("caffold:task-turn-options-change", (event) => {
      if (event.target === this.turnOptions()) {
        this.patch();
      }
    });
    this.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.startUpdate();
    });
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  turnOptions() {
    return this.querySelector(":scope caffold-task-turn-options");
  }

  /**
   * Opens for an update the server offers: `status` is its update status with
   * an `updateTask`, and `composerSettings` are the update Section's last
   * turn settings, if it has any.
   */
  open({ status, composerSettings, opener } = {}) {
    const update = updateTaskFrom(status);
    if (!update) {
      return false;
    }
    this.update = update;
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.createRequestId += 1;
    this.pending = false;
    this.error = null;
    this.querySelector("#caffold-update-task-title").textContent =
      `Update Caffold to ${update.to}`;
    this.querySelector("[data-update-task-outcome]").textContent =
      `An agent runs the update in a new Task. If ${update.to} does not start, the previous version is restored.`;
    // Turn options load the agents' models as soon as they connect, so they
    // exist only while the dialog is open.
    if (!this.turnOptions()) {
      this.querySelector(".update-task-dialog-body").prepend(
        document.createElement("caffold-task-turn-options"),
      );
    }
    this.turnOptions().reset({
      cwd: update.cwd,
      initialSelection: normalizeComposerSettings(composerSettings) ?? {},
      placement: "below",
    });
    this.patch();
    const dialog = this.dialog();
    dialog.returnValue = "";
    if (!dialog.open) {
      dialog.showModal();
    }
    return true;
  }

  async startUpdate() {
    if (
      this.pending ||
      !this.update ||
      !this.turnOptions()?.readyForSubmission()
    ) {
      return;
    }
    const requestId = ++this.createRequestId;
    const options = this.turnOptions().submissionOptions();
    const prompt = updateTaskPrompt(this.update);
    const intent = {
      type: "start",
      request: { cwd: this.update.cwd, titleSource: prompt, ...options },
      submission: {
        submissionId: `caffold-update:${Date.now()}:${requestId}`,
        prompt,
        images: [],
        attachments: [],
        options,
      },
      accepted: false,
      completion: null,
    };
    this.pending = true;
    this.error = null;
    this.patch();
    try {
      this.dispatchEvent(
        new CustomEvent("caffold:task-create-intent", {
          bubbles: true,
          composed: true,
          detail: intent,
        }),
      );
      if (!intent.accepted || !intent.completion) {
        throw new Error("Another Task is still being created.");
      }
      await intent.completion;
      if (requestId !== this.createRequestId) {
        return;
      }
      this.pending = false;
      this.turnOptions().resetFastMode();
      this.dialog().close("started");
    } catch (error) {
      if (requestId !== this.createRequestId) {
        return;
      }
      this.pending = false;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.patch();
    }
  }

  handleClose() {
    if (this.pending) {
      return;
    }
    this.turnOptions()?.hidePopovers();
    this.turnOptions()?.remove();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  patch() {
    if (!this.update || !this.turnOptions()) {
      return;
    }
    const error = this.querySelector(".update-task-dialog-error");
    error.replaceChildren();
    if (this.error) {
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = this.error.message;
      error.append(message);
    }
    this.querySelector('[data-update-task-dialog-action="cancel"]').disabled =
      this.pending;
    const submit = this.querySelector('button[type="submit"]');
    submit.disabled = this.pending || !this.turnOptions().readyForSubmission();
    submit.textContent = this.pending ? "Starting..." : "Start Update";
    this.dialog().setAttribute("aria-busy", this.pending ? "true" : "false");
    this.turnOptions().setContext({
      cwd: this.update.cwd,
      locked: this.pending,
      placement: "below",
    });
  }

  actionHintScope() {
    const dialog = this.dialog();
    const body = dialog?.querySelector(".update-task-dialog-body");
    if (!dialog?.open || !body || !this.update) {
      return emptyActionHintScope();
    }
    const ownScope = {
      blocked: false,
      targets: [
        ["cancel", '[data-update-task-dialog-action="cancel"]'],
        ["start", 'button[type="submit"]'],
      ].flatMap(([identity, selector]) => {
        const control = dialog.querySelector(selector);
        if (!control) {
          return [];
        }
        return [buttonActionHintTarget({
          invalidationOwner: this,
          id: `${SCOPE_ID}:${identity}`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.textContent?.trim() || identity,
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog() === dialog &&
            dialog.open &&
            dialog.querySelector(selector) === control &&
            !control.disabled,
        })];
      }),
      mutationRoots: [this],
      scrollRoots: [],
    };
    const turnOptions = this.turnOptions();
    const turnScope = {
      blocked: this.pending,
      targets: [
        turnOptions?.actionHintModelTarget({
          scopeId: SCOPE_ID,
          clipRoots: [dialog, body],
        }),
        turnOptions?.actionHintPermissionTarget({
          scopeId: SCOPE_ID,
          clipRoots: [dialog, body],
        }),
      ].filter(Boolean),
      mutationRoots: [turnOptions].filter(Boolean),
      scrollRoots: [],
    };
    return mergeActionHintScopes(ownScope, turnScope);
  }

  scrollSurfaceScope() {
    const dialog = this.dialog();
    const scrollport = dialog?.querySelector(".update-task-dialog-body");
    if (!dialog?.open || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${SCOPE_ID}:body`,
        label: "Caffold update",
        scrollport,
        clipRoots: [dialog, scrollport],
        isEligible: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          dialog.querySelector(".update-task-dialog-body") === scrollport &&
          hasScrollLayoutBox(dialog) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!dialog?.open || !hintDialog || !hud || !selector || !this.update) {
      return [];
    }
    const modalContext = keyboardNavigationContext({
      id: SCOPE_ID,
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
    });
    return mergeKeyboardNavigationContexts(
      [modalContext],
      this.turnOptions()?.keyboardNavigationContexts({ scopeId: SCOPE_ID }) ?? [],
    );
  }

  render() {
    this.innerHTML = `
      <dialog
        closedby="any"
        aria-labelledby="caffold-update-task-title"
        aria-describedby="caffold-update-task-description"
      >
        <form class="update-task-dialog-card">
          <header>
            <h2 id="caffold-update-task-title"></h2>
            <div id="caffold-update-task-description" class="update-task-dialog-description">
              <p data-update-task-outcome></p>
              <p>Running Tasks keep going while Caffold restarts. Claude sessions stop if it takes more than 10 minutes. Open terminals close.</p>
            </div>
          </header>
          <div class="update-task-dialog-body">
            <p class="update-task-dialog-permission-hint">To let the agent recover Caffold even if the restore fails, choose the mode that allows everything (Full access or Allow all). Other modes can stop at the update command, and no one can answer approvals while Caffold restarts, including Ask Jev first.</p>
            <div class="update-task-dialog-error" aria-live="assertive"></div>
          </div>
          <footer>
            <button
              type="button"
              class="update-task-dialog-button"
              data-update-task-dialog-action="cancel"
            >Cancel</button>
            <button
              type="submit"
              class="update-task-dialog-button is-primary"
            >Start Update</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }
}

/** What an update Task needs from the server's update status. */
export function updateTaskFrom(status) {
  const to = `${status?.latestRelease?.version ?? ""}`.trim();
  const cwd = `${status?.updateTask?.cwd ?? ""}`.trim();
  const command = `${status?.updateTask?.command ?? ""}`.trim();
  if (!to || !cwd || !command || status?.runningAttempt) {
    return null;
  }
  return { to, cwd, command };
}

/**
 * The update Task's first prompt. The Task names itself from it, because a
 * Task is named by its agent on the first turn.
 */
export function updateTaskPrompt({ to, command }) {
  return [
    `Update Caffold on this Mac to ${to}.`,
    "",
    `1. Name this Task exactly "Update Caffold to ${to}".`,
    "2. Run this command and wait for it to finish. It can take several minutes, and Caffold restarts while it runs:",
    "",
    "   ```",
    `   ${command}`,
    "   ```",
    "",
    "3. Report the result in one or two sentences.",
    "",
    'If the command is cut off, the update keeps going on its own: follow attempts/<latest>/attempt.json in this directory until its outcome is no longer "running". If it reports that the restore failed, read that attempt\'s attempt.json and log.txt, find out why Caffold is not running, and bring a working Caffold back. Do not change anything unrelated to this update.',
  ].join("\n");
}

function normalizeComposerSettings(settings) {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  return {
    model: `${settings.model ?? ""}`,
    effort: `${settings.effort ?? ""}`,
    fastMode: Boolean(settings.fastMode),
    permissionMode: `${settings.permissionMode ?? ""}`,
  };
}

customElements.define("caffold-update-task-dialog", CaffoldUpdateTaskDialog);
