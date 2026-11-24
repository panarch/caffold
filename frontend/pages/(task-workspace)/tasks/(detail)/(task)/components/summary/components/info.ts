import { html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { Task, TaskWorktree } from "#app/api.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import {
  directoryPathDisplay,
  type ServerPaths,
} from "#tasks/components/directory-path.js";
import "#tasks/components/task-status-chip.js";
import { formatTaskStatus, taskStatusView } from "#tasks/runtime-state.js";
import {
  cleanRelativeTaskPath,
  sectionLabel,
  shortId,
} from "#tasks/task-format.js";
import { taskThreadId } from "#tasks/task-list-model.js";
import "./info/components/actions.js";
import "./info/components/copy-value.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { returnPopoverFocus } from "#app/popover-focus.js";
import { scopedStyle } from "#app/scoped-style.js";
import type {
  CaffoldTaskDetailInfoActions,
  TaskInfoActionIntent,
  TaskInfoActionsSnapshot,
} from "./info/components/actions.js";
import type { CaffoldTaskDetailInfoCopyValue } from "./info/components/copy-value.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import actionIcon from "#tasks/component-styles/action-icon.css.js";
import styles from "./info.css.js";

let taskInfoInstanceId = 0;

// What Task Info asks of the Task screen: one of its actions.
export type TaskInfoIntent = TaskInfoActionIntent;

// What Task Info shows: what its actions show, the directory the Task screen
// works in, for a Task whose own is not known, and the server's root and home
// directory, which decide how a path reads.
export interface TaskInfoSnapshot extends TaskInfoActionsSnapshot {
  contextPath: string;
  serverPaths: ServerPaths;
}

// A snapshot from an owner that may leave fields out, with each field it
// left out at its resting value.
export function taskInfoSnapshot(
  snapshot: Partial<TaskInfoSnapshot> = {},
): TaskInfoSnapshot {
  return {
    task: snapshot.task ?? null,
    canonicalTaskAvailable: Boolean(snapshot.canonicalTaskAvailable),
    archiveBlockedByActive: Boolean(snapshot.archiveBlockedByActive),
    transportState: snapshot.transportState ?? "idle",
    contextPath: `${snapshot.contextPath ?? "."}`,
    provider: `${snapshot.provider ?? ""}`,
    archiveState: {
      loading: Boolean(snapshot.archiveState?.loading),
      error: snapshot.archiveState?.error ?? null,
    },
    pinned: snapshot.pinned ?? null,
    pinState: {
      loading: Boolean(snapshot.pinState?.loading),
      error: snapshot.pinState?.error ?? null,
    },
    worktreePrepared: Boolean(snapshot.worktreePrepared),
    serverPaths: snapshot.serverPaths ?? {},
  };
}

/**
 * The Task's details button in the summary: its status, and a popover with
 * the Task's title and status, where it works, and its Task ID above its
 * actions.
 *
 * Where it works reads as one line: the repository, or the folder outside
 * Git, the branch, and whether the Task runs in a worktree of its own.
 * Pressing the line unfolds the full paths, each with Copy; they fold again
 * when the popover closes.
 *
 * The popover closes when another Task takes this one's place.
 */
@customElement("caffold-task-detail-info")
export class CaffoldTaskDetailInfo extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: TaskInfoSnapshot = taskInfoSnapshot();
  @state()
  private accessor pathsOpen = false;

  static override styles = [
    scopedStyle(compactIconButton, ".task-detail-info-button"),
    scopedStyle(actionIcon, ".task-action-icon"),
    styles,
  ];

  private readonly popoverId = `task-detail-info-${++taskInfoInstanceId}`;
  private readonly pathsId = `${this.popoverId}-paths`;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly infoButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly infoPopover = new DrawnRef<HTMLDivElement>(this);
  private readonly actions = new DrawnRef<CaffoldTaskDetailInfoActions>(this);
  private readonly copies = new DrawnRefs<CaffoldTaskDetailInfoCopyValue>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.deactivate();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("snapshot") &&
      taskThreadId(changed.get("snapshot")?.task) !==
        taskThreadId(this.snapshot.task)
    ) {
      this.pathsOpen = false;
      this.deactivate();
    }
  }

  override render() {
    const task = this.snapshot.task;
    if (!task) {
      return nothing;
    }
    // Only a Task read from its details carries its directory and worktree.
    const canonical = this.snapshot.canonicalTaskAvailable
      ? (task as Task)
      : null;
    const statusLabel = canonical ? formatTaskStatus(task) : "unavailable";
    const showsStatus = Boolean(canonical) && taskStatusView(task) !== null;
    const location = canonical
      ? taskLocation(canonical, this.snapshot.serverPaths)
      : null;
    const claudeConfigDir = canonical?.claudeConfigDir ?? "";
    const threadId = taskThreadId(task);
    const taskIdLabel = "Task ID";
    const label = `Task details, ${statusLabel}`;
    return html`
      <button
        ${drawn(this.infoButton)}
        ${this.hints.button({
          id: `${threadId}:details:open`,
          label,
          action: ACTION_HINT_ACTION.TASK_DETAILS_OPEN,
        })}
        type="button"
        class="task-detail-info-button"
        popovertarget=${this.popoverId}
        aria-label=${label}
        title=${`Status: ${statusLabel}`}
      >${
        showsStatus
          ? html`<caffold-task-status-chip
              class="task-detail-status"
              .task=${task}
            ></caffold-task-status-chip>`
          : inlineIcon("Info", "Task details", "task-action-icon")
      }</button>
      <div
        ${drawn(this.infoPopover)}
        ${this.keyboard.popover({
          id: `${threadId}:details`,
          label: "Task details",
          sessionBound: true,
        })}
        id=${this.popoverId}
        class="task-detail-popover"
        popover="auto"
        @beforetoggle=${this.handleBeforeToggle}
        @caffold:keyboard-session-dismiss=${this.handleDismiss}
        aria-label="Task details"
      >
        <div class="task-detail-popover-head">
          <span
            class="task-detail-popover-title"
            data-task-info-field="title"
          >${task.title}</span>
          <span
            class="task-detail-popover-status"
            data-task-info-field="status"
          >${statusLabel}</span>
        </div>
        <div class="task-detail-meta">
          ${
            location
              ? html`
                  <button
                    ${this.hints.disclosure({
                      id: `${threadId}:details:location`,
                      label: this.pathsOpen ? "Hide paths" : "Show paths",
                      action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
                    })}
                    type="button"
                    class="task-detail-location"
                    data-task-info-field="location"
                    aria-expanded=${this.pathsOpen ? "true" : "false"}
                    aria-controls=${this.pathsId}
                    title=${this.pathsOpen ? "Hide paths" : "Show paths"}
                    @click=${this.togglePaths}
                  >
                    <span class="task-detail-location-parts">
                      <span class="task-detail-location-repository">${inlineIcon(
                        "Folder",
                        "",
                        "task-detail-location-icon",
                      )}<span>${location.place}</span></span>
                      ${
                        location.ref
                          ? html`<span class="task-detail-location-branch">${inlineIcon(
                              "GitBranch",
                              "",
                              "task-detail-location-icon",
                            )}<span>${location.ref}</span></span>`
                          : nothing
                      }
                      ${
                        location.linked
                          ? html`<span class="task-detail-location-worktree"
                              >worktree</span
                            >`
                          : nothing
                      }
                    </span>
                    <span
                      class="task-detail-location-chevron"
                      aria-hidden="true"
                    >${inlineIcon("ChevronDown", "", "task-detail-location-icon")}</span>
                  </button>
                  <div
                    id=${this.pathsId}
                    class="task-detail-paths"
                    ?hidden=${!this.pathsOpen}
                  >
                    ${location.paths.map(
                      ({ name, label, copyLabel, path }) => html`
                        <div
                          class="task-detail-path"
                          data-task-info-path=${name}
                        >
                          <span class="task-detail-path-name">${label}</span>
                          <span class="task-detail-path-value">${path
                            .split("/")
                            .map((part, index) =>
                              index === 0 ? part : html`/<wbr>${part}`,
                            )}</span>
                          <caffold-task-detail-info-copy-value
                            ${drawn(this.copies.of(name))}
                            .value=${path}
                            .label=${copyLabel}
                          ></caffold-task-detail-info-copy-value>
                        </div>
                      `,
                    )}
                  </div>
                `
              : nothing
          }
          <div class="task-detail-meta-line">
            <span class="task-detail-meta-name">${taskIdLabel}</span>
            <span class="task-detail-meta-value" data-task-info-field="thread">${threadId}</span>
            <caffold-task-detail-info-copy-value
              ${drawn(this.copies.of("thread"))}
              .value=${threadId}
              .label=${taskIdLabel}
            ></caffold-task-detail-info-copy-value>
          </div>
          ${
            claudeConfigDir
              ? html`<div class="task-detail-meta-line">
                  <span class="task-detail-meta-name">Claude config</span>
                  <span
                    class="task-detail-meta-value"
                    data-task-info-field="claude-config-dir">${claudeConfigDir}</span>
                  <caffold-task-detail-info-copy-value
                    ${drawn(this.copies.of("claude-config-dir"))}
                    .value=${claudeConfigDir}
                    .label=${"Claude config directory"}
                  ></caffold-task-detail-info-copy-value>
                </div>`
              : nothing
          }
        </div>
        <caffold-task-detail-info-actions
          ${drawn(this.actions)}
          .snapshot=${this.snapshot}
          @caffold:task-detail-info-action-intent=${this.actionIntent}
        ></caffold-task-detail-info-actions>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  deactivate() {
    const popover = this.infoPopover.value;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  // Where focus returns once what the popover opened closes.
  detailsButton() {
    return this.infoButton.value ?? null;
  }

  actionHintScope({ scopeId = "task-detail", ...pull }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  keyboardNavigationContexts({
    scopeId = "task-detail",
  }: {
    scopeId?: string;
  } = {}) {
    const threadId = taskThreadId(this.snapshot.task);
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) =>
        mergeActionHintScopes(
          this.hints.scope(pull),
          ...COPIED_VALUES.map((name) =>
            this.copies.get(name)?.actionHintScope({
              ...pull,
              scopeId: `${pull.scopeId}:${threadId}:details:${name}`,
            }),
          ),
          this.actions.value?.actionHintScope(pull),
        ),
    });
  }

  private togglePaths() {
    this.pathsOpen = !this.pathsOpen;
  }

  // Its actions follow the popover as it shows and hides, not a task later,
  // so nothing they read runs on once it is closed. Closed, it folds its
  // paths.
  private handleBeforeToggle(event: ToggleEvent) {
    returnPopoverFocus(event);
    if (event.target !== this.infoPopover.value) {
      return;
    }
    const open = event.newState === "open";
    if (!open) {
      this.pathsOpen = false;
    }
    this.actions.value?.setPopoverOpen(open, this.infoButton.value ?? null);
  }

  private handleDismiss(event: Event) {
    if (event.target === this.infoPopover.value) {
      this.deactivate();
    }
  }

  private actionIntent(event: CustomEvent<TaskInfoActionIntent>) {
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<TaskInfoIntent>("caffold:task-detail-info-intent", {
        bubbles: true,
        composed: true,
        detail: { type: event.detail.type },
      }),
    );
  }
}

// The values the popover copies, each by the name its Copy is drawn under.
const COPIED_VALUES = [
  "path",
  "repository",
  "worktree",
  "working-directory",
  "thread",
  "claude-config-dir",
] as const;

// One path the location line unfolds: its name, what Copy calls it, and how
// it reads.
interface TaskPath {
  name: "path" | "repository" | "worktree" | "working-directory";
  label: string;
  copyLabel: string;
  path: string;
}

// Where a Task works, as its location line reads it: the repository, or the
// folder outside Git, with the folder inside the repository it works in; the
// branch, or the commit a detached checkout sits on; whether the checkout is
// a worktree of its own; and the paths behind them.
function taskLocation(task: Task, server: ServerPaths) {
  const shown = (path: string | null | undefined) =>
    path == null ? task.cwd : directoryPathDisplay(path, server);
  const directory = shown(task.cwdPath);
  const worktree = task.worktree;
  if (!worktree) {
    return {
      place: sectionLabel(task.cwdPath ?? task.cwd),
      ref: "",
      linked: false,
      paths: [taskPath("path", "Path", "path", directory)],
    };
  }
  const inside = cleanRelativeTaskPath(worktree.relativeCwd);
  const repository = worktree.repositoryRootPath || worktree.rootPath;
  const repositoryPath = taskPath(
    "repository",
    "Repository",
    "repository path",
    shown(repository),
  );
  const paths = worktree.linked
    ? [
        repositoryPath,
        taskPath(
          "worktree",
          "Worktree",
          "worktree path",
          shown(worktree.rootPath),
        ),
      ]
    : inside
      ? [repositoryPath]
      : [taskPath("path", "Path", "path", directory)];
  if (inside) {
    paths.push(
      taskPath(
        "working-directory",
        "Working directory",
        "working directory path",
        directory,
      ),
    );
  }
  return {
    place: [sectionLabel(repository), inside].filter(Boolean).join("/"),
    ref: worktreeRef(worktree),
    linked: worktree.linked,
    paths,
  };
}

function taskPath(
  name: TaskPath["name"],
  label: string,
  copyLabel: string,
  path: string,
): TaskPath {
  return { name, label, copyLabel, path };
}

function worktreeRef(worktree: TaskWorktree) {
  const branch = `${worktree.branch ?? ""}`.trim();
  return branch || shortId(worktree.headSha);
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-info": CaffoldTaskDetailInfo;
  }

  interface HTMLElementEventMap {
    "caffold:task-detail-info-intent": CustomEvent<TaskInfoIntent>;
  }
}
