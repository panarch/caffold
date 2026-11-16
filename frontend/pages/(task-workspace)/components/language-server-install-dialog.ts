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
import { CaffoldElement } from "#app/caffold-element.js";
import type {
  CaffoldTaskTurnOptions,
  TurnOptionsSelection,
} from "#tasks/components/task-turn-options.js";
import type { TaskStartIntent } from "../task-create-intent-event.js";
import { TASK_CREATE_INTENT_EVENT } from "../task-create-intent-event.js";

import styles from "./language-server-install-dialog.css.js";

// A server an install Task installs on the host: its name, the rustup
// toolchain it goes into for Rust, and the commands that install it and show
// it runs.
export interface LanguageServerInstall {
  serverName: string;
  toolchain?: string;
  installCommand: string;
  checkCommand: string;
}

/**
 * Starts a Task in which an agent installs language servers on the host and
 * checks that each runs. The Task runs in the home folder whichever
 * repository asked, so it never shares a Task's worktree; each install names
 * where it goes. The dialog confirms the install and chooses the agent; the
 * workspace creates the Task through the Tasks page, as Start Task does.
 *
 * The workspace opens it and shows it at once, so it draws in place.
 */
@customElement("caffold-language-server-install-dialog")
export class CaffoldLanguageServerInstallDialog extends CaffoldElement {
  static override styles = styles;

  private servers: LanguageServerInstall[] = [];
  // The home folder the Task starts in, or null when Caffold serves no home
  // folder.
  private path: string | null = null;
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
   * Opens for the servers to install, in a Task at the home folder `path`.
   * `composerSettings` are the last turn settings of that folder's Section,
   * if it has any, as Start Task there would use them.
   */
  open({
    servers,
    path,
    composerSettings,
    opener,
  }: {
    servers: LanguageServerInstall[];
    path: string | null;
    composerSettings?: unknown;
    opener?: HTMLElement | null;
  }) {
    if (this.pending || servers.length === 0) {
      return false;
    }
    this.servers = servers;
    this.path = path;
    this.opener = opener ?? null;
    this.createRequestId += 1;
    this.error =
      path === null
        ? new Error(
            "Caffold serves no home folder, so it has nowhere to start the install.",
          )
        : null;
    this.choosing = true;
    this.draw();
    this.turnOptions.value?.reset({
      cwd: path ?? "",
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
    const servers = this.servers;
    const open = servers.length > 0;
    return html`
      <dialog
        ${drawn(this.dialog)}
        ${this.keyboard.modal({
          id: "language-server-install",
          when: open,
        })}
        closedby="any"
        aria-labelledby="language-server-install-title"
        aria-describedby="language-server-install-description"
        aria-busy=${this.pending ? "true" : "false"}
        @close=${this.handleClose}
        @cancel=${this.holdWhilePending}
      >
        <form class="language-server-install-card" @submit=${this.submit}>
          <header>
            <h2 id="language-server-install-title">${
              open ? installTitle(servers) : ""
            }</h2>
            <p id="language-server-install-description">${
              open ? installOutcome(servers) : ""
            }</p>
            <ul class="language-server-install-list">
              ${servers.map(
                (server) => html`<li>
                  <span>${installTarget(server)}</span>
                  <code>${server.installCommand}</code>
                </li>`,
              )}
            </ul>
          </header>
          <div
            ${drawn(this.body)}
            ${this.surfaces.surface({
              id: "body",
              label: () => "Language server install",
              clipRoots: () => [this.body.value],
            })}
            class="language-server-install-body"
          >
            ${
              this.choosing
                ? html`<caffold-task-turn-options
                    ${drawn(this.turnOptions)}
                    @caffold:task-turn-options-change=${this.updateSetup}
                  ></caffold-task-turn-options>`
                : nothing
            }
            <div class="language-server-install-error" aria-live="assertive">${
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
              class="language-server-install-button"
              data-language-server-install-action="cancel"
              ?disabled=${this.pending}
              @click=${this.cancel}
            >Cancel</button>
            <button
              ${this.hints.button({
                id: "start",
                label: "Start Install",
                action: ACTION_HINT_ACTION.DIALOG_BUTTON,
              })}
              type="submit"
              class="language-server-install-button is-primary"
              ?disabled=${this.pending || !this.ready || this.path === null}
            >${this.pending ? "Starting..." : "Start Install"}</button>
          </footer>
        </form>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private async startInstall() {
    const turnOptions = this.turnOptions.value;
    const path = this.path;
    if (
      this.pending ||
      this.servers.length === 0 ||
      path === null ||
      !turnOptions?.readyForSubmission()
    ) {
      return;
    }
    const requestId = ++this.createRequestId;
    const options = turnOptions.submissionOptions();
    const prompt = languageServerInstallPrompt(this.servers);
    const intent: TaskStartIntent = {
      type: "start",
      request: { cwd: path, titleSource: prompt, ...options },
      submission: {
        submissionId: `language-server-install:${Date.now()}:${requestId}`,
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

  // Whether the install can start follows the turn options, which lock while
  // it is being started.
  private updateSetup() {
    const turnOptions = this.turnOptions.value;
    if (this.servers.length === 0 || !turnOptions) {
      return;
    }
    this.ready = turnOptions.readyForSubmission();
    this.draw();
    turnOptions.setContext({
      cwd: this.path ?? "",
      locked: this.pending,
      placement: "below",
    });
  }

  private submit(event: Event) {
    event.preventDefault();
    void this.startInstall();
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

function installTitle(servers: readonly LanguageServerInstall[]) {
  return servers.length === 1
    ? `Install ${servers[0].serverName}`
    : "Install language servers";
}

function installOutcome(servers: readonly LanguageServerInstall[]) {
  return servers.length === 1
    ? `An agent installs ${servers[0].serverName} in a new Task in your home folder, then checks that it runs.`
    : "An agent installs these in a new Task in your home folder, then checks that each runs.";
}

// What a server is installed for: for Rust, the toolchain it goes into.
function installTarget({ serverName, toolchain }: LanguageServerInstall) {
  return toolchain
    ? `${serverName} for the ${toolchain} toolchain`
    : serverName;
}

/**
 * The install Task's first prompt. The Task names itself from it, because a
 * Task is named by its agent on the first turn.
 */
export function languageServerInstallPrompt(
  servers: readonly LanguageServerInstall[],
) {
  return [
    "Install language servers on this host.",
    "",
    `1. Name this Task exactly "${installTitle(servers)}".`,
    "2. For each server below, run its install command and wait for it to finish, then run its check command and confirm it prints a version.",
    "",
    ...servers.flatMap((server) => [
      `   - ${installTarget(server)}`,
      `     Install: \`${server.installCommand}\``,
      `     Check: \`${server.checkCommand}\``,
    ]),
    "",
    "3. Report the result in one or two sentences.",
    "",
    "Do not change anything unrelated to this install.",
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
    "caffold-language-server-install-dialog": CaffoldLanguageServerInstallDialog;
  }
}
