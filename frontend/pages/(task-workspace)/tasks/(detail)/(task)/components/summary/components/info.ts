import { html, LitElement, nothing, type PropertyValues } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { Task, TaskWorktree } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  KeyboardContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#tasks/components/task-status-chip.js";
import { formatTaskStatus, taskStatusView } from "#tasks/runtime-state.js";
import { shortId } from "#tasks/task-format.js";
import { taskThreadId } from "#tasks/task-list-model.js";
import "./info/components/actions.js";
import type {
  CaffoldTaskDetailInfoActions,
  TaskInfoActionIntent,
  TaskInfoActionsSnapshot,
} from "./info/components/actions.js";

let taskInfoInstanceId = 0;

// What Task Info asks of the Task screen: one of its actions.
export type TaskInfoIntent = TaskInfoActionIntent;

// What Task Info shows: what its actions show, and the directory the Task
// screen works in, for a Task whose own is not known.
export interface TaskInfoSnapshot extends TaskInfoActionsSnapshot {
  contextPath: string;
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
    permissionMode: `${snapshot.permissionMode ?? ""}`,
    archiveState: {
      loading: Boolean(snapshot.archiveState?.loading),
      error: snapshot.archiveState?.error ?? null,
    },
    forkState: {
      loading: Boolean(snapshot.forkState?.loading),
      error: snapshot.forkState?.error ?? null,
    },
  };
}

/**
 * The Task's details button in the summary: its status, and a popover with
 * the Task's thread, directory, and worktree above its actions.
 *
 * The popover closes when another Task takes this one's place.
 */
export class CaffoldTaskDetailInfo extends LitElement {
  static properties = {
    snapshot: { attribute: false },
  };

  declare snapshot: TaskInfoSnapshot;
  private readonly popoverId = `task-detail-info-${++taskInfoInstanceId}`;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly infoButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly infoPopover = new DrawnRef<HTMLDivElement>(this);
  private readonly actions = new DrawnRef<CaffoldTaskDetailInfoActions>(this);

  constructor() {
    super();
    this.snapshot = taskInfoSnapshot();
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, (event) =>
      this.handleDismiss(event),
    );
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.deactivate();
  }

  protected willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("snapshot") &&
      taskThreadId(changed.get("snapshot")?.task) !==
        taskThreadId(this.snapshot.task)
    ) {
      this.deactivate();
    }
  }

  render() {
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
    const worktree = canonical?.worktree ?? null;
    const directory = canonical
      ? canonical.cwdPath || canonical.cwd || this.snapshot.contextPath
      : "";
    const threadId = taskThreadId(task);
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
        aria-label="Task details"
      >
        <dl>
          <div>
            <dt>Task</dt>
            <dd data-task-info-field="task">${task.title}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd data-task-info-field="status">${statusLabel}</dd>
          </div>
          <div>
            <dt>Thread</dt>
            <dd data-task-info-field="thread">${threadId}</dd>
          </div>
          <div data-task-info-provider-context ?hidden=${!canonical}>
            <dt>Working directory</dt>
            <dd data-task-info-field="working-directory">${directory}</dd>
          </div>
          <div data-task-info-worktree ?hidden=${!worktree}>
            <dt>Worktree</dt>
            <dd data-task-info-field="worktree-path">${worktree?.rootPath}</dd>
          </div>
          <div data-task-info-worktree ?hidden=${!worktree}>
            <dt>Branch</dt>
            <dd data-task-info-field="worktree-ref">${worktreeRef(
              worktree,
            )}</dd>
          </div>
        </dl>
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
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) =>
        mergeActionHintScopes(this.actions.value?.actionHintScope(pull)),
    });
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

await compactIconButton.register(
  "caffold-task-detail-info",
  "> .task-detail-info-button",
);

customElements.define("caffold-task-detail-info", CaffoldTaskDetailInfo);

function worktreeRef(worktree: TaskWorktree | null) {
  const branch = `${worktree?.branch ?? ""}`.trim();
  return branch || shortId(worktree?.headSha ?? "");
}
