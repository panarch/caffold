import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type {
  LanguageServerFailure,
  LanguageServerStatus,
  Task,
  TaskResponseError,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import type { LanguageServerInstall } from "#app/pages/(task-workspace)/components/language-server-install-dialog.js";
import { languageServerMemory } from "#app/pages/(task-workspace)/language-servers.js";
import { scopedStyle } from "#app/scoped-style.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import {
  isTaskTransportStale,
  type TaskTransportState,
  taskThreadStatusType,
} from "#tasks/runtime-state.js";
import { type ListedTask, taskThreadId } from "#tasks/task-list-model.js";
import {
  LanguageServersLifecycle,
  type LanguageServersSnapshot,
} from "./actions/language-servers.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./actions.css.js";

/** The approval mode Caffold answers under, which is the one Jev judges for. */
const REVIEWED_PERMISSION_MODE = "caffold:ask-jev-first";
const PERMISSION_INSTRUCTIONS_ABOUT =
  "This Task keeps what your own prompts say it may and may not do, for Jev to read when it answers a permission request here.";
const PIN_ABOUT =
  "Pinned Tasks stay at the top of the Task list and the Task Switcher.";
const UNPIN_ABOUT =
  "This Task is pinned. Unpinning returns it to the top of its Section.";
const LANGUAGE_SERVERS_ABOUT =
  "Language servers answer Go to definition and Find references in this repository's code.";
const FORK_ABOUT =
  "Create a new Task at the project root with this conversation's history. Files and worktrees are not copied.";
const ARCHIVE_ABOUT =
  "Archive removes this task from the active list. If Caffold prepared its worktree, the worktree is removed and its branch is kept. Its open terminal is closed.";

// A request the Task screen runs for the Task: whether it runs, and why the
// last one failed.
export interface TaskActionState {
  loading: boolean;
  error: Error | null;
}

// What the actions show: the Task, whether its details have been read, its
// live connection, its agent and approval mode, whether it is pinned (null
// while the list has not placed it in a Section), and its Archive, Fork, and
// pin requests. Archive waits while the agent is working on the Task.
export interface TaskInfoActionsSnapshot {
  task: ListedTask | null;
  canonicalTaskAvailable: boolean;
  archiveBlockedByActive: boolean;
  transportState: TaskTransportState;
  provider: string;
  permissionMode: string;
  archiveState: TaskActionState;
  forkState: TaskActionState;
  pinned: boolean | null;
  pinState: TaskActionState;
}

type TaskInfoAction =
  | "archive"
  | "force-archive"
  | "fork"
  | "pin"
  | "unpin"
  | "permission-instructions";

export interface TaskInfoActionIntent {
  type: TaskInfoAction;
}

// Asks for a Task in which an agent installs language servers on the host:
// the servers a repository found missing, and the control focus returns to
// when the dialog closes. The install Task starts in the home folder
// whichever repository asked.
export interface LanguageServerInstallIntent {
  servers: LanguageServerInstall[];
  opener: HTMLElement | null;
}

/**
 * What can be done with the Task from its details popover: read what its
 * prompts settled, pin or unpin it, turn its repository's language servers on
 * or off, fork it, and archive it, each with why it cannot be done now.
 *
 * The language servers are read once before the popover opens and then
 * while it is open.
 */
@customElement("caffold-task-detail-info-actions")
export class CaffoldTaskDetailInfoActions extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: TaskInfoActionsSnapshot | null = null;
  @state()
  private accessor languageServers: LanguageServersSnapshot;

  static override styles = [
    scopedStyle(busySpin, ".task-detail-action-icon.is-busy"),
    scopedStyle(secondaryButton, ".task-secondary-button"),
    styles,
  ];

  private readonly hints = new ActionHints(this);
  private readonly iconsReady = () => this.requestUpdate();
  private readonly languageServersLifecycle = new LanguageServersLifecycle({
    onChange: (snapshot) => {
      this.languageServers = snapshot;
    },
  });
  private popoverOpen = false;
  private detailsButton: HTMLElement | null = null;

  constructor() {
    super();
    this.languageServers = this.languageServersLifecycle.snapshot;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.syncLanguageServers();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.setPopoverOpen(false, null);
  }

  /**
   * Task Info says when its popover opens and closes, and which button focus
   * returns to once a dialog an action opens takes the popover's place.
   */
  setPopoverOpen(open: boolean, detailsButton: HTMLElement | null) {
    this.popoverOpen = open;
    this.detailsButton = detailsButton;
    this.syncLanguageServers();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  // The Task's directory is known once its details are read, which can be
  // after the popover opened.
  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("snapshot")) {
      this.syncLanguageServers();
    }
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot?.task) {
      return nothing;
    }
    const forking = snapshot.forkState.loading;
    const forkUnavailable = forkDisabledReason(snapshot);
    const forkError = actionErrorMessage(snapshot.forkState.error);
    const createdTaskId = (snapshot.forkState.error as TaskResponseError | null)
      ?.createdTaskId;
    const pinned = snapshot.pinned;
    const pinning = snapshot.pinState.loading;
    const pinError = actionErrorMessage(snapshot.pinState.error);
    const pinLabel = pinned ? "Unpin task" : "Pin task";
    const pinIcon = pinned ? "PinOff" : "Pin";
    const archiving = snapshot.archiveState.loading;
    const archiveError = actionErrorMessage(snapshot.archiveState.error);
    const archiveFailure = snapshot.archiveState
      .error as TaskResponseError | null;
    const canForceArchive = Boolean(
      archiveFailure?.allowedActions?.includes("forceArchive") &&
        archiveFailure.worktreeId,
    );
    const threadId = taskThreadId(snapshot.task);
    const languageServers = this.languageServers;
    const repository = languageServers.repository;
    const servers = repository?.servers ?? [];
    const serversOn = repository?.enabled === true;
    // Statuses and choices follow only the latest answer.
    const serversKnown = languageServers.fresh;
    const turning = languageServers.turning;
    const serversBusy =
      turning !== null ||
      (serversKnown &&
        serversOn &&
        servers.some((server) => server.state === "starting"));
    const serversLabel =
      turning === "off"
        ? "Turning off language servers..."
        : serversBusy
          ? "Starting language servers..."
          : serversOn
            ? "Turn off language servers"
            : "Turn on language servers";
    const missingServers =
      serversKnown && serversOn ? notInstalled(servers) : [];
    const installLabel =
      missingServers.length === 1
        ? `Ask an agent to install ${missingServers[0].serverName}`
        : `Ask an agent to install ${missingServers.length} servers`;
    const serversError = actionErrorMessage(languageServers.error);
    return html`
      <div
        class="task-detail-task-action
          task-detail-permission-instructions-action"
        data-task-info-permission-instructions
        ?hidden=${!this.keepsPermissionInstructions()}
      >
        <p>${PERMISSION_INSTRUCTIONS_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:permission-instructions`,
            label: "What your prompts settled",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: this.keepsPermissionInstructions(),
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action="permission-instructions"
          @click=${this.requestAction}
        >${actionContent("ShieldCheck", "What your prompts settled")}</button>
      </div>
      <div
        class="task-detail-task-action task-detail-pin-action"
        ?hidden=${pinned === null}
      >
        <p>${pinned ? UNPIN_ABOUT : PIN_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:pin`,
            label: pinLabel,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: pinned !== null,
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action=${pinned ? "unpin" : "pin"}
          ?disabled=${pinning}
          @click=${this.requestAction}
        >${actionContent(
          pinIcon,
          pinning ? (pinned ? "Unpinning..." : "Pinning...") : pinLabel,
          pinning,
        )}</button>
        <p
          class="task-detail-action-error task-detail-pin-error"
          role="alert"
          ?hidden=${!pinError}
        >${pinError}</p>
      </div>
      <div
        class="task-detail-task-action task-detail-language-servers-action"
        ?hidden=${servers.length === 0}
      >
        <p>${LANGUAGE_SERVERS_ABOUT}</p>
        ${
          serversKnown && serversOn
            ? servers.map((server) => {
                const status = languageServerStatus(server);
                const said = languageServerSaid(server);
                return status
                  ? html`<p data-language-server=${server.language}>${status}</p>${
                      said
                        ? html`<p
                            class="task-detail-language-server-said"
                            data-language-server-said=${server.language}
                          >${said}</p>`
                        : nothing
                    }`
                  : nothing;
              })
            : nothing
        }
        <div class="task-detail-action-row">
          ${
            missingServers.length > 0
              ? html`<button
                  ${this.hints.button({
                    id: `${threadId}:language-server-install`,
                    label: installLabel,
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                    badgeAtEnd: true,
                  })}
                  type="button"
                  class="task-secondary-button"
                  data-task-info-action="install-language-servers"
                  @click=${this.requestLanguageServerInstall}
                >${actionContent("Bot", installLabel)}</button>`
              : nothing
          }
          <button
            ${this.hints.button({
              id: `${threadId}:language-servers`,
              label: serversLabel,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              when: servers.length > 0,
              badgeAtEnd: true,
            })}
            type="button"
            class="task-secondary-button"
            data-task-info-action=${
              serversOn
                ? "turn-off-language-servers"
                : "turn-on-language-servers"
            }
            ?disabled=${!serversKnown || serversBusy}
            @click=${this.turnLanguageServers}
          >${actionContent("CodeXml", serversLabel, serversBusy)}</button>
        </div>
        <p
          class="task-detail-action-error task-detail-language-servers-error"
          role="alert"
          ?hidden=${!serversError}
        >${serversError}</p>
      </div>
      <div class="task-detail-task-action task-detail-fork-action">
        <p>${FORK_ABOUT}</p>
        <p
          class="task-detail-fork-availability"
          ?hidden=${forking || Boolean(createdTaskId) || !forkUnavailable}
        >${forking ? "" : forkUnavailable}</p>
        ${
          createdTaskId
            ? nothing
            : html`<button
                ${this.hints.button({
                  id: `${threadId}:fork`,
                  label: "Fork task",
                  action: ACTION_HINT_ACTION.TASK_FORK,
                  badgeAtEnd: true,
                })}
                type="button"
                class="task-secondary-button"
                data-task-info-action="fork"
                title=${forking || !forkUnavailable ? nothing : forkUnavailable}
                ?disabled=${forking || Boolean(forkUnavailable)}
                @click=${this.requestAction}
              >${actionContent("Split", forking ? "Forking..." : "Fork task", forking)}</button>`
        }
        <p
          class="task-detail-action-error task-detail-fork-error"
          role="alert"
          ?hidden=${!forkError}
        >${forkError}</p>
        ${
          createdTaskId
            ? html`<a
                ${this.hints.link({
                  id: `${threadId}:open-fork`,
                  label: "Open forked task",
                  action: ACTION_HINT_ACTION.LINK_OPEN,
                })}
                class="task-secondary-button"
                href=${`/tasks/${encodeURIComponent(createdTaskId)}`}
              >${actionContent("ArrowRight", "Open forked task")}</a>`
            : nothing
        }
      </div>
      <div class="task-detail-task-action task-detail-archive-action">
        <p>${ARCHIVE_ABOUT}</p>
        <button
          ${this.hints.button({
            id: `${threadId}:archive`,
            label: "Archive task",
            action: ACTION_HINT_ACTION.TASK_ARCHIVE,
            badgeAtEnd: true,
          })}
          type="button"
          class="task-secondary-button"
          data-task-info-action="archive"
          ?disabled=${
            archiving ||
            snapshot.forkState.loading ||
            snapshot.archiveBlockedByActive
          }
          @click=${this.requestAction}
        >${actionContent(
          "Archive",
          archiving ? "Archiving..." : "Archive task",
          archiving,
        )}</button>
        <p
          class="task-detail-action-error task-detail-archive-error"
          role="alert"
          ?hidden=${!archiveError}
        >${archiveError}</p>
        ${
          canForceArchive
            ? html`
                <button
                  ${this.hints.button({
                    id: `${threadId}:force-archive`,
                    label: "Discard changes and archive",
                    action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                    badgeAtEnd: true,
                  })}
                  type="button"
                  class="task-secondary-button"
                  data-task-info-action="force-archive"
                  ?disabled=${
                    archiving ||
                    snapshot.forkState.loading ||
                    snapshot.archiveBlockedByActive
                  }
                  @click=${this.requestAction}
                >${actionContent("ArchiveX", "Discard changes and archive")}</button>
              `
            : nothing
        }
      </div>
    `;
  }

  // The record is kept and read only under the reviewed mode, so the action
  // that opens it is offered under that mode and no other.
  private keepsPermissionInstructions() {
    return this.snapshot?.permissionMode === REVIEWED_PERMISSION_MODE;
  }

  // Open, the section reads its repository and follows it; closed, it reads
  // it once ahead, so the section is there when the popover opens.
  private syncLanguageServers() {
    const path = this.isConnected ? languageServersPath(this.snapshot) : null;
    if (path === null) {
      this.languageServersLifecycle.stop();
    } else if (this.popoverOpen) {
      this.languageServersLifecycle.show(path);
    } else {
      this.languageServersLifecycle.hide();
      this.languageServersLifecycle.preload(path);
    }
  }

  private turnLanguageServers() {
    void this.languageServersLifecycle.turn(
      this.languageServers.repository?.enabled !== true,
    );
  }

  // Hands every server this repository lacks to one install Task, which
  // runs on the host.
  private requestLanguageServerInstall() {
    const servers = notInstalled(
      this.languageServers.repository?.servers ?? [],
    );
    if (servers.length === 0) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<LanguageServerInstallIntent>(
        "caffold:language-server-install-intent",
        {
          bubbles: true,
          composed: true,
          detail: {
            servers: servers.map(({ serverName, failure }) => ({
              serverName,
              ...(failure.toolchain ? { toolchain: failure.toolchain } : {}),
              installCommand: failure.installCommand,
              checkCommand: failure.checkCommand,
            })),
            opener: this.detailsButton,
          },
        },
      ),
    );
  }

  private requestAction(event: Event) {
    const type = (event.currentTarget as HTMLButtonElement).dataset
      .taskInfoAction as TaskInfoAction;
    this.dispatchEvent(
      new CustomEvent<TaskInfoActionIntent>(
        "caffold:task-detail-info-action-intent",
        {
          bubbles: true,
          composed: true,
          detail: { type },
        },
      ),
    );
  }
}

// An action's icon before its label. While the action runs, the busy icon
// turns in the icon's place.
function actionContent(icon: string, label: string, busy = false) {
  return html`<span
      class=${busy ? "task-detail-action-icon is-busy" : "task-detail-action-icon"}
      aria-hidden="true"
    >${inlineIcon(busy ? "LoaderCircle" : icon, "", "task-detail-action-svg")}</span>
    <span>${label}</span>`;
}

function actionErrorMessage(error: Error | null) {
  return error ? `${error.message ?? error}` : "";
}

// The repository a Task's language servers belong to is asked for by its
// worktree, or by its directory outside one. A directory outside Caffold's
// root has none.
function languageServersPath(snapshot: TaskInfoActionsSnapshot | null) {
  if (!snapshot?.task || !snapshot.canonicalTaskAvailable) {
    return null;
  }
  const task = snapshot.task as Task;
  return task.worktree?.rootPath ?? task.cwdPath ?? null;
}

type NotInstalledServer = LanguageServerStatus & {
  failure: Extract<LanguageServerFailure, { kind: "notInstalled" }>;
};

function notInstalled(servers: readonly LanguageServerStatus[]) {
  return servers.filter(
    (server): server is NotInstalledServer =>
      server.state === "failed" && server.failure?.kind === "notInstalled",
  );
}

// One language's line under the section while its servers are on, as
// "Rust: ready · rust-analyzer · 2.8 GB". A failed server's line says which
// check failed, never what the tool printed.
function languageServerStatus(server: LanguageServerStatus) {
  const name = server.languageName;
  switch (server.state) {
    case "starting":
      return server.progress
        ? `${name}: getting ready · ${server.progress}`
        : `${name}: getting ready`;
    case "ready": {
      const memory = languageServerMemory(server.memoryBytes);
      return [`${name}: ready`, server.serverName, memory]
        .filter(Boolean)
        .join(" · ");
    }
    case "sleeping":
      return `${name}: sleeping`;
    case "failed": {
      const failure = server.failure;
      if (failure?.kind === "notInstalled") {
        return failure.toolchain
          ? `${name}: ${server.serverName} is not installed for the ${failure.toolchain} toolchain.`
          : `${name}: ${server.serverName} is not installed.`;
      }
      return failure?.kind === "stopped"
        ? `${name}: ${server.serverName} stopped.`
        : `${name}: ${server.serverName} could not start.`;
    }
    default:
      return "";
  }
}

// What a server that could not start printed, shown as it is under its
// line.
function languageServerSaid({ state, failure }: LanguageServerStatus) {
  return state === "failed" && failure?.kind === "couldNotStart"
    ? failure.reason
    : "";
}

function forkDisabledReason(snapshot: TaskInfoActionsSnapshot) {
  if (!snapshot.canonicalTaskAvailable) {
    return "Fork is unavailable until Task details load.";
  }
  if (!["codex", "claude", "grok"].includes(snapshot.provider ?? "")) {
    return "Fork is available for Codex, Claude and Grok Tasks.";
  }
  if (isTaskTransportStale(snapshot.transportState)) {
    return "Fork is unavailable while the Task connection is interrupted.";
  }
  if (snapshot.archiveState.loading) {
    return "Another Task action is in progress.";
  }
  if (taskThreadStatusType(snapshot.task) !== "idle") {
    return "Fork is available when the Task is idle.";
  }
  return "";
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-info-actions": CaffoldTaskDetailInfoActions;
  }

  interface HTMLElementEventMap {
    "caffold:task-detail-info-action-intent": CustomEvent<TaskInfoActionIntent>;
    "caffold:language-server-install-intent": CustomEvent<LanguageServerInstallIntent>;
  }
}
