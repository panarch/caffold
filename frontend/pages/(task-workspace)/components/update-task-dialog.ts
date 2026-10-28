import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  KeyboardContexts,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import "#tasks/components/task-turn-options.js";
import type { CaffoldUpdateStatus } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type {
  CaffoldTaskTurnOptions,
  TurnOptionsSelection,
} from "#tasks/components/task-turn-options.js";
import type { TaskStartIntent } from "../task-create-intent-event.js";
import { TASK_CREATE_INTENT_EVENT } from "../task-create-intent-event.js";

import styles from "./update-task-dialog.css.js";

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
@customElement("caffold-update-task-dialog")
export class CaffoldUpdateTaskDialog extends CaffoldElement {
  static override styles = styles;

  private updateTask: UpdateTask | null = null;
  // Turn options load the agents' models as soon as they connect, so they
  // exist only while the dialog is open.
  private choosing = false;
  private ready = false;
  private pending = false;
  private error: Error | null = null;
  private opener: HTMLElement | null = null;
  private createRequestId = 0;
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly turnOptions = new DrawnRef<CaffoldTaskTurnOptions>(this);

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
    this.turnOptions.value?.reset({
      cwd: update.cwd,
      initialSelection: normalizeComposerSettings(composerSettings) ?? {},
      placement: "below",
    });
    this.updateSetup();
    const dialog = this.dialog.value;
    if (dialog) {
      dialog.returnValue = "";
      if (!dialog.open) {
        dialog.showModal();
      }
    }
    return true;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    const body = this.body.value;
    const own = this.hints.scope(pull);
    const turnScope = this.turnOptions.value?.actionHintScope({
      scopeId: pull.scopeId,
      clipRoots: [...(pull.clipRoots ?? []), ...(body ? [body] : [])],
    });
    return mergeActionHintScopes(
      own,
      turnScope && { ...turnScope, blocked: this.pending },
    );
  }

  keyboardNavigationContexts() {
    const contexts = this.keyboard.contexts({
      actionHints: (pull) => this.actionHintScope(pull),
      scroll: (pull) => this.surfaces.scope(pull),
    });
    return mergeKeyboardNavigationContexts(
      contexts,
      ...contexts.map(
        ({ id }) =>
          this.turnOptions.value?.keyboardNavigationContexts({ scopeId: id }) ??
          [],
      ),
    );
  }

  override render() {
    const update = this.updateTask;
    const outcome = update
      ? `An agent runs the update in a new Task. If ${update.to} does not start, the previous version is restored.`
      : "";
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({
          id: "caffold-update-task",
          when: Boolean(update),
        })}
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
          <div
            ${drawn(this.body)}
            ${this.surfaces.surface({
              id: "body",
              label: () => "Caffold update",
              clipRoots: () => [this.body.value],
            })}
            class="update-task-dialog-body"
          >
            ${
              this.choosing
                ? html`<caffold-task-turn-options
                    ${drawn(this.turnOptions)}
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
              ${this.hints.button({
                id: "cancel",
                label: "Cancel",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="button"
              class="update-task-dialog-button"
              data-update-task-dialog-action="cancel"
              ?disabled=${this.pending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "start",
                label: "Start Update",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="update-task-dialog-button is-primary"
              ?disabled=${this.pending || !this.ready}
            >${this.pending ? "Starting..." : "Start Update"}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private async startUpdate() {
    const turnOptions = this.turnOptions.value;
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
        new CustomEvent<TaskStartIntent>(TASK_CREATE_INTENT_EVENT, {
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
      this.turnOptions.value?.resetFastMode();
      this.dialog.value?.close("started");
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
    const turnOptions = this.turnOptions.value;
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
      this.dialog.value?.close("cancel");
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
    this.turnOptions.value?.hidePopovers();
    this.choosing = false;
    this.draw();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => opener.focus());
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-update-task-dialog": CaffoldUpdateTaskDialog;
  }
}
