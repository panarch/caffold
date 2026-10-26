import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import {
  keyboardNavigationContext,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
import type { TaskStartIntent } from "#tasks/components/task-create.ts";
import "#tasks/components/task-turn-options.ts";
import type { CaffoldUpdateStatus } from "#app/api.ts";
import type {
  CaffoldTaskTurnOptions,
  TurnOptionsSelection,
} from "#tasks/components/task-turn-options.ts";

const SCOPE_ID = "caffold-update-task";
const RESTART_NOTICE =
  "Running Tasks keep going while Caffold restarts. Claude sessions stop if it takes more than 10 minutes. Open terminals close.";
const PERMISSION_HINT =
  "To let the agent recover Caffold even if the restore fails, choose the mode that allows everything (Full access or Allow all). Other modes can stop at the update command, and no one can answer approvals while Caffold restarts, including Ask Jev first.";

// The update an update Task runs: the version it goes to, the directory it
// runs in, and the command.
export interface UpdateTask {
  to: string;
  cwd: string;
  command: string;
}

/**
 * Starts a Task in which an agent updates Caffold and stays with it. The
 * dialog confirms the update and chooses the agent; the workspace creates the
 * Task through the Tasks page, as Start Task does.
 *
 * The workspace opens it and shows it at once, so it draws in place.
 */
export class CaffoldUpdateTaskDialog extends LitElement {
  private updateTask: UpdateTask | null = null;
  // Turn options load the agents' models as soon as they connect, so they
  // exist only while the dialog is open.
  private choosing = false;
  private ready = false;
  private pending = false;
  private error: Error | null = null;
  private opener: HTMLElement | null = null;
  private createRequestId = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  /**
   * Opens for an update the server offers: `status` is its update status with
   * an `updateTask`, and `composerSettings` are the update Section's last
   * turn settings, if it has any.
   */
  open({
    status,
    composerSettings,
    opener,
  }: {
    status?: CaffoldUpdateStatus | null;
    composerSettings?: unknown;
    opener?: unknown;
  } = {}) {
    const update = updateTaskFrom(status);
    if (!update) {
      return false;
    }
    this.updateTask = update;
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.createRequestId += 1;
    this.pending = false;
    this.error = null;
    this.choosing = true;
    this.draw();
    this.turnOptions()?.reset({
      cwd: update.cwd,
      initialSelection: normalizeComposerSettings(composerSettings) ?? {},
      placement: "below",
    });
    this.updateSetup();
    const dialog = this.dialog();
    if (dialog) {
      dialog.returnValue = "";
      if (!dialog.open) {
        dialog.showModal();
      }
    }
    return true;
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog();
    const body = dialog?.querySelector(".update-task-dialog-body");
    if (!dialog?.open || !body || !this.updateTask) {
      return emptyActionHintScope();
    }
    const ownScope = {
      blocked: false,
      targets: [
        ["cancel", '[data-update-task-dialog-action="cancel"]'],
        ["start", 'button[type="submit"]'],
      ].flatMap(([identity, selector]) => {
        const control = dialog.querySelector<HTMLButtonElement>(selector);
        if (!control) {
          return [];
        }
        return [
          buttonActionHintTarget({
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
          }),
        ];
      }),
      mutationRoots: [this],
      scrollRoots: [],
    };
    const turnOptions = this.turnOptions();
    const turnScope = {
      blocked: this.pending,
      targets: turnOptions
        ? [
            turnOptions.actionHintModelTarget({
              scopeId: SCOPE_ID,
              clipRoots: [dialog, body],
            }),
            turnOptions.actionHintPermissionTarget({
              scopeId: SCOPE_ID,
              clipRoots: [dialog, body],
            }),
          ].filter((target) => target !== null)
        : [],
      mutationRoots: turnOptions ? [turnOptions] : [],
      scrollRoots: [],
    };
    return mergeActionHintScopes(ownScope, turnScope);
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    const dialog = this.dialog();
    const scrollport = dialog?.querySelector(".update-task-dialog-body");
    if (!dialog?.open || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
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
        },
      ],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog?.open || !hintDialog || !hud || !selector || !this.updateTask) {
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
      this.turnOptions()?.keyboardNavigationContexts({ scopeId: SCOPE_ID }) ??
        [],
    );
  }

  render() {
    const update = this.updateTask;
    const outcome = update
      ? `An agent runs the update in a new Task. If ${update.to} does not start, the previous version is restored.`
      : "";
    return html`
      <dialog
        closedby="any"
        aria-labelledby="caffold-update-task-title"
        aria-describedby="caffold-update-task-description"
        aria-busy=${this.pending ? "true" : "false"}
        @close=${this.handleClose}
        @cancel=${this.holdWhilePending}
      >
        <form class="update-task-dialog-card" @submit=${this.submit}>
          <header>
            <h2 id="caffold-update-task-title">${
              update ? `Update Caffold to ${update.to}` : ""
            }</h2>
            <div
              id="caffold-update-task-description"
              class="update-task-dialog-description"
            >
              <p data-update-task-outcome>${outcome}</p>
              <p>${RESTART_NOTICE}</p>
            </div>
          </header>
          <div class="update-task-dialog-body">
            ${
              this.choosing
                ? html`<caffold-task-turn-options
                    @caffold:task-turn-options-change=${this.updateSetup}
                  ></caffold-task-turn-options>`
                : nothing
            }
            <p class="update-task-dialog-permission-hint">${PERMISSION_HINT}</p>
            <div class="update-task-dialog-error" aria-live="assertive">${
              this.error
                ? html`<p role="alert">${this.error.message}</p>`
                : nothing
            }</div>
          </div>
          <footer>
            <button
              type="button"
              class="update-task-dialog-button"
              data-update-task-dialog-action="cancel"
              ?disabled=${this.pending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              type="submit"
              class="update-task-dialog-button is-primary"
              ?disabled=${this.pending || !this.ready}
            >${this.pending ? "Starting..." : "Start Update"}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private async startUpdate() {
    const turnOptions = this.turnOptions();
    if (
      this.pending ||
      !this.updateTask ||
      !turnOptions?.readyForSubmission()
    ) {
      return;
    }
    const requestId = ++this.createRequestId;
    const options = turnOptions.submissionOptions();
    const prompt = updateTaskPrompt(this.updateTask);
    const intent: TaskStartIntent = {
      type: "start",
      request: { cwd: this.updateTask.cwd, titleSource: prompt, ...options },
      submission: {
        submissionId: `caffold-update:${Date.now()}:${requestId}`,
        prompt,
        attachments: [],
        options,
      },
      accepted: false,
      completion: null,
    };
    this.pending = true;
    this.error = null;
    this.updateSetup();
    try {
      this.dispatchEvent(
        new CustomEvent<TaskStartIntent>("caffold:task-create-intent", {
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
      this.turnOptions()?.resetFastMode();
      this.dialog()?.close("started");
    } catch (error) {
      if (requestId !== this.createRequestId) {
        return;
      }
      this.pending = false;
      this.error = error instanceof Error ? error : new Error(`${error}`);
      this.updateSetup();
    }
  }

  // Whether the update can start follows the turn options, which lock while
  // it is being started.
  private updateSetup() {
    const turnOptions = this.turnOptions();
    if (!this.updateTask || !turnOptions) {
      return;
    }
    this.ready = turnOptions.readyForSubmission();
    this.draw();
    turnOptions.setContext({
      cwd: this.updateTask.cwd,
      locked: this.pending,
      placement: "below",
    });
  }

  private submit(event: Event) {
    event.preventDefault();
    void this.startUpdate();
  }

  private cancel() {
    if (!this.pending) {
      this.dialog()?.close("cancel");
    }
  }

  private holdWhilePending(event: Event) {
    if (this.pending) {
      event.preventDefault();
    }
  }

  private handleClose() {
    if (this.pending) {
      return;
    }
    this.turnOptions()?.hidePopovers();
    this.choosing = false;
    this.draw();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  private dialog() {
    return this.querySelector<HTMLDialogElement>(":scope > dialog");
  }

  private turnOptions() {
    return this.querySelector<CaffoldTaskTurnOptions>(
      ":scope caffold-task-turn-options",
    );
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define("caffold-update-task-dialog", CaffoldUpdateTaskDialog);

/** What an update Task needs from the server's update status. */
export function updateTaskFrom(
  status: CaffoldUpdateStatus | null | undefined,
): UpdateTask | null {
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
export function updateTaskPrompt({ to, command }: UpdateTask) {
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

function normalizeComposerSettings(
  settings: unknown,
): TurnOptionsSelection | null {
  if (!settings || typeof settings !== "object") {
    return null;
  }
  const { model, effort, fastMode, permissionMode } = settings as Record<
    string,
    unknown
  >;
  return {
    model: `${model ?? ""}`,
    effort: `${effort ?? ""}`,
    fastMode: Boolean(fastMode),
    permissionMode: `${permissionMode ?? ""}`,
  };
}
