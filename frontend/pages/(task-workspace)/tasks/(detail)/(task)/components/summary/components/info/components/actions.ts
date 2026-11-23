import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
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
import { type DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
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
import switchStyle from "#app/component-styles/switch.css.js";
import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./actions.css.js";

/** The agents whose conversations Caffold can fork. */
const FORKING_PROVIDERS = ["codex", "claude", "grok", "copilot"];
const IDLE_ONLY = "Available when the Task is idle.";
const ARCHIVING = "Unavailable while the Task is archiving.";
const FORKING = "Unavailable while the Task is forking.";

// A request the Task screen runs for the Task: whether it runs, and why the
// last one failed.
export interface TaskActionState {
  loading: boolean;
  error: Error | null;
}

// What the actions show: the Task, whether its details have been read, its
// live connection, its agent and approval mode, whether it is pinned (null
// while the list has not placed it in a Section), whether Caffold prepared the
// worktree it runs in, and its Archive, Fork, and pin requests. Archive waits
// while the agent is working on the Task.
export interface TaskInfoActionsSnapshot {
  task: ListedTask | null;
  canonicalTaskAvailable: boolean;
  archiveBlockedByActive: boolean;
  transportState: TaskTransportState;
  provider: string;
  archiveState: TaskActionState;
  forkState: TaskActionState;
  pinned: boolean | null;
  pinState: TaskActionState;
  worktreePrepared: boolean;
}

type TaskInfoAction = "archive" | "force-archive" | "fork" | "pin" | "unpin";

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
 * What can be done with the Task from its details popover, as a list of rows:
 * pin or unpin it, turn its repository's language servers on or off, fork it,
 * and archive it. Each row says what it does, or why it cannot be done now;
 * what a row reports, such as each server's state or why the last request
 * failed, and what can be done about it, sits under the row. While the Task archives, every other row and the
 * buttons under it wait.
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
    scopedStyle(switchStyle, ".task-detail-language-servers-switch"),
    styles,
  ];

  private readonly hints = new ActionHints(this);
  private readonly rowIcons = new DrawnRefs<HTMLElement>(this);
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
    const threadId = taskThreadId(snapshot.task);
    const archiving = snapshot.archiveState.loading;
    // Every row but Archive waits while the Task archives. A row whose own
    // request runs keeps showing it; any other says why it waits.
    const archiveWait = archiving ? ARCHIVING : "";
    const pinned = snapshot.pinned;
    const pinning = snapshot.pinState.loading;
    const pinError = actionErrorMessage(snapshot.pinState.error);
    const pinLabel = pinned ? "Unpin task" : "Pin task";
    const pinDescription = pinned
      ? "Return it to its Section."
      : "Keep it at the top of the Task list.";
    const forking = snapshot.forkState.loading;
    // Until the Task's details name its agent, Fork waits dimmed for them.
    const forkOffered = snapshot.provider
      ? FORKING_PROVIDERS.includes(snapshot.provider)
      : !snapshot.canonicalTaskAvailable;
    const forkUnavailable = archiveWait || forkDisabledReason(snapshot);
    const forkError = actionErrorMessage(snapshot.forkState.error);
    const createdTaskId = (snapshot.forkState.error as TaskResponseError | null)
      ?.createdTaskId;
    const archiveUnavailable = archiving
      ? ""
      : forking
        ? FORKING
        : snapshot.archiveBlockedByActive
          ? IDLE_ONLY
          : "";
    const archiveError = actionErrorMessage(snapshot.archiveState.error);
    const archiveFailure = snapshot.archiveState
      .error as TaskResponseError | null;
    const canForceArchive = Boolean(
      archiveFailure?.allowedActions?.includes("forceArchive") &&
        archiveFailure.worktreeId,
    );
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
    const serversDescription =
      turning === "off"
        ? "Turning off language servers..."
        : serversBusy
          ? "Starting language servers..."
          : archiveWait || "Go to definition and Find references.";
    const missingServers =
      serversKnown && serversOn ? notInstalled(servers) : [];
    const installLabel =
      missingServers.length === 1
        ? `Ask an agent to install ${missingServers[0].serverName}`
        : `Ask an agent to install ${missingServers.length} servers`;
    const serversError = actionErrorMessage(languageServers.error);
    // Each language's line shows only while the servers are on.
    const serverLines = serversKnown && serversOn;
    return html`
      <hr class="task-detail-actions-divider">
      ${
        pinned === null
          ? nothing
          : html`<button
                ${this.hints.button({
                  id: `${threadId}:pin`,
                  label: pinLabel,
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                  anchor: () => this.rowIcons.get("pin"),
                  badgeAt: "center",
                })}
                type="button"
                class="task-detail-action"
                data-task-info-action=${pinned ? "unpin" : "pin"}
                ?disabled=${pinning || archiving}
                @click=${this.requestAction}
              >
                ${actionIcon(pinned ? "PinOff" : "Pin", this.rowIcons.of("pin"), pinning)}
                <span class="task-detail-action-label">${
                  pinning ? (pinned ? "Unpinning..." : "Pinning...") : pinLabel
                }</span>
                <span class="task-detail-action-description">${
                  (!pinning && archiveWait) || pinDescription
                }</span>
              </button>
              ${
                pinError
                  ? html`<div class="task-detail-action-under">
                      <p
                        class="task-detail-action-error task-detail-pin-error"
                        role="alert"
                      >${pinError}</p>
                    </div>`
                  : nothing
              }`
      }
      ${
        servers.length === 0
          ? nothing
          : html`<label
                class="task-detail-action task-detail-language-servers-action"
              >
                ${actionIcon("CodeXml", this.rowIcons.of("language-servers"), serversBusy)}
                <span
                  class="task-detail-action-label"
                  id=${`${threadId}-language-servers-label`}
                >Language servers</span>
                <span
                  class="task-detail-action-description"
                  id=${`${threadId}-language-servers-description`}
                >${serversDescription}</span>
                <input
                  ${this.hints.switch({
                    id: `${threadId}:language-servers`,
                    label: serversOn
                      ? "Turn off language servers"
                      : "Turn on language servers",
                    action: ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE,
                    // The whole row toggles the switch, so its badge sits on
                    // the row's icon like every other row's.
                    anchor: () => this.rowIcons.get("language-servers"),
                    badgeAt: "center",
                  })}
                  type="checkbox"
                  role="switch"
                  class="task-detail-language-servers-switch"
                  data-task-info-action=${
                    serversOn
                      ? "turn-off-language-servers"
                      : "turn-on-language-servers"
                  }
                  aria-labelledby=${`${threadId}-language-servers-label`}
                  aria-describedby=${`${threadId}-language-servers-description`}
                  .checked=${live(turning ? turning === "on" : serversOn)}
                  ?disabled=${!serversKnown || serversBusy || archiving}
                  @change=${this.turnLanguageServers}
                >
              </label>
              ${
                serverLines || serversError || missingServers.length > 0
                  ? html`<div class="task-detail-action-under">
                      ${
                        serverLines
                          ? servers.map((server) => {
                              const status = languageServerStatus(server);
                              const said = languageServerSaid(server);
                              return status
                                ? html`<p
                                      class="task-detail-action-note"
                                      data-language-server=${server.language}
                                    >${status}</p>${
                                      said
                                        ? html`<p
                                            class="task-detail-action-note task-detail-language-server-said"
                                            data-language-server-said=${server.language}
                                          >${said}</p>`
                                        : nothing
                                    }`
                                : nothing;
                            })
                          : nothing
                      }
                      ${
                        serversError
                          ? html`<p
                              class="task-detail-action-error task-detail-language-servers-error"
                              role="alert"
                            >${serversError}</p>`
                          : nothing
                      }
                      ${
                        missingServers.length > 0
                          ? html`<button
                              ${this.hints.button({
                                id: `${threadId}:language-server-install`,
                                label: installLabel,
                                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                                badgeAt: "top-right",
                              })}
                              type="button"
                              class="task-secondary-button task-detail-follow-up"
                              data-task-info-action="install-language-servers"
                              ?disabled=${archiving}
                              @click=${this.requestLanguageServerInstall}
                            >${actionContent("Bot", installLabel)}</button>`
                          : nothing
                      }
                    </div>`
                  : nothing
              }`
      }
      ${
        forkOffered
          ? html`<button
                ${this.hints.button({
                  id: `${threadId}:fork`,
                  label: "Fork task",
                  action: ACTION_HINT_ACTION.TASK_FORK,
                  anchor: () => this.rowIcons.get("fork"),
                  badgeAt: "center",
                })}
                type="button"
                class="task-detail-action"
                data-task-info-action="fork"
                ?disabled=${forking || Boolean(forkUnavailable) || Boolean(createdTaskId)}
                @click=${this.requestAction}
              >
                ${actionIcon("Split", this.rowIcons.of("fork"), forking)}
                <span class="task-detail-action-label">${
                  forking ? "Forking..." : "Fork task"
                }</span>
                <span class="task-detail-action-description">${
                  forking || createdTaskId || !forkUnavailable
                    ? "Copies the conversation, not the files, into a new Task."
                    : forkUnavailable
                }</span>
              </button>
              ${
                forkError || createdTaskId
                  ? html`<div class="task-detail-action-under">
                      ${
                        forkError
                          ? html`<p
                              class="task-detail-action-error task-detail-fork-error"
                              role="alert"
                            >${forkError}</p>`
                          : nothing
                      }
                      ${
                        createdTaskId
                          ? html`<a
                              ${this.hints.link({
                                id: `${threadId}:open-fork`,
                                label: "Open forked task",
                                action: ACTION_HINT_ACTION.LINK_OPEN,
                              })}
                              class="task-secondary-button task-detail-follow-up"
                              href=${`/tasks/${encodeURIComponent(createdTaskId)}`}
                            >${actionContent("ArrowRight", "Open forked task")}</a>`
                          : nothing
                      }
                    </div>`
                  : nothing
              }`
          : nothing
      }
      <hr class="task-detail-actions-divider">
      <button
        ${this.hints.button({
          id: `${threadId}:archive`,
          label: "Archive task",
          action: ACTION_HINT_ACTION.TASK_ARCHIVE,
          anchor: () => this.rowIcons.get("archive"),
          badgeAt: "center",
        })}
        type="button"
        class="task-detail-action"
        data-task-info-action="archive"
        ?disabled=${archiving || Boolean(archiveUnavailable)}
        @click=${this.requestAction}
      >
        ${actionIcon("Archive", this.rowIcons.of("archive"), archiving)}
        <span class="task-detail-action-label">${
          archiving ? "Archiving..." : "Archive task"
        }</span>
        <span class="task-detail-action-description">${
          archiveUnavailable ||
          (snapshot.worktreePrepared
            ? "Removes its worktree and keeps the branch."
            : "Removes it from the active list.")
        }</span>
      </button>
      ${
        archiveError || canForceArchive
          ? html`<div class="task-detail-action-under">
              ${
                archiveError
                  ? html`<p
                      class="task-detail-action-error task-detail-archive-error"
                      role="alert"
                    >${archiveError}</p>`
                  : nothing
              }
              ${
                canForceArchive
                  ? html`<button
                      ${this.hints.button({
                        id: `${threadId}:force-archive`,
                        label: "Discard changes and archive",
                        action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                        badgeAt: "top-right",
                      })}
                      type="button"
                      class="task-secondary-button task-detail-follow-up"
                      data-task-info-action="force-archive"
                      ?disabled=${archiving || Boolean(archiveUnavailable)}
                      @click=${this.requestAction}
                    >${actionContent("ArchiveX", "Discard changes and archive")}</button>`
                  : nothing
              }
            </div>`
          : nothing
      }
    `;
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
    if (this.snapshot?.archiveState.loading) {
      return;
    }
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
    if (servers.length === 0 || this.snapshot?.archiveState.loading) {
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

// A row's or a button's icon. A row's icon is its keyboard badge's anchor.
// While the action runs, the busy icon turns in the icon's place.
function actionIcon(
  icon: string,
  badgeAnchor?: DrawnRef<HTMLElement>,
  busy = false,
) {
  return html`<span
    ${badgeAnchor ? drawn(badgeAnchor) : nothing}
    class=${busy ? "task-detail-action-icon is-busy" : "task-detail-action-icon"}
    aria-hidden="true"
  >${inlineIcon(busy ? "LoaderCircle" : icon, "", "task-detail-action-svg")}</span>`;
}

// A follow-up button's icon before its label.
function actionContent(icon: string, label: string) {
  return html`${actionIcon(icon)}<span>${label}</span>`;
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

// Why an agent that forks cannot fork the Task now, besides an archive, or
// nothing.
function forkDisabledReason(snapshot: TaskInfoActionsSnapshot) {
  if (!snapshot.canonicalTaskAvailable) {
    return "Available once Task details load.";
  }
  if (isTaskTransportStale(snapshot.transportState)) {
    return "Unavailable while the Task connection is interrupted.";
  }
  if (taskThreadStatusType(snapshot.task) !== "idle") {
    return IDLE_ONLY;
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
