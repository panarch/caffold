import { html, LitElement, nothing, type PropertyValues } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import type { Task, TaskWorktree } from "#app/api.js";
import { compactIconButton } from "#app/component-styles.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
  popoverScrollSurfaceScope,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#tasks/components/task-status-chip.ts";
import { formatTaskStatus, taskStatusView } from "#tasks/runtime-state.js";
import { shortId } from "#tasks/task-format.js";
import { taskThreadId } from "#tasks/task-list-model.js";
import "./info/components/actions.ts";
import type {
  CaffoldTaskDetailInfoActions,
  TaskInfoActionIntent,
  TaskInfoActionsSnapshot,
} from "./info/components/actions.ts";

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
 * The summary hands it the snapshot it draws, and reads its Action Hints and
 * keyboard context right after, so those first finish any drawing that is
 * due. The popover closes when another Task takes this one's place.
 */
export class CaffoldTaskDetailInfo extends LitElement {
  static properties = {
    snapshot: { attribute: false },
  };

  declare snapshot: TaskInfoSnapshot;
  private readonly popoverId = `task-detail-info-${++taskInfoInstanceId}`;
  private readonly iconsReady = () => this.requestUpdate();

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
    return html`
      <button
        type="button"
        class="task-detail-info-button"
        popovertarget=${this.popoverId}
        aria-label=${`Task details, ${statusLabel}`}
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
            <dd data-task-info-field="thread">${taskThreadId(task)}</dd>
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
          .snapshot=${this.snapshot}
          @caffold:task-detail-info-action-intent=${this.actionIntent}
        ></caffold-task-detail-info-actions>
        <caffold-keyboard-navigation-presentation
        ></caffold-keyboard-navigation-presentation>
      </div>
    `;
  }

  deactivate() {
    const popover = this.infoPopover;
    if (!popover?.matches(":popover-open")) {
      return;
    }
    try {
      popover.hidePopover();
    } catch {
      // The component may have been detached during a parent transition.
    }
  }

  actionHintScope({
    scopeId = "task-detail",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const threadId = taskThreadId(this.snapshot.task);
    const control = this.infoButton;
    const popover = this.infoPopover;
    if (!threadId || !scopeId || !control || !popover) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${threadId}:details:open`,
          actionId: ACTION_HINT_ACTION.TASK_DETAILS_OPEN,
          label: control.getAttribute("aria-label") || "Task details",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            taskThreadId(this.snapshot.task) === threadId &&
            this.infoButton === control &&
            this.infoPopover === popover &&
            control.getAttribute("popovertarget") === popover.id &&
            !control.disabled &&
            !popover.matches(":popover-open"),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  keyboardNavigationContexts({
    scopeId = "task-detail",
  }: {
    scopeId?: string;
  } = {}) {
    this.performUpdate();
    const threadId = taskThreadId(this.snapshot.task);
    const popover = this.infoPopover;
    const presentation =
      popover?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const dialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!threadId || !scopeId || !popover || !dialog || !hud || !selector) {
      return [];
    }
    const contextId = `${scopeId}:${threadId}:details`;
    const actions = popover.querySelector<CaffoldTaskDetailInfoActions>(
      ":scope > caffold-task-detail-info-actions",
    );
    return [
      keyboardNavigationContext({
        id: contextId,
        kind: "popover",
        root: popover,
        actionHints: {
          dialog,
          scope: mergeActionHintScopes(
            actions?.actionHintScope({
              scopeId: contextId,
              clipRoots: [popover],
            }),
            {
              blocked: false,
              targets: [],
              mutationRoots: [popover],
              scrollRoots: [popover],
            },
          ),
          sessionBound: true,
        },
        scroll: {
          hud,
          selector,
          scope: popoverScrollSurfaceScope({
            id: contextId,
            label: "Task details",
            popover,
            isCurrent: () =>
              this.isConnected &&
              taskThreadId(this.snapshot.task) === threadId &&
              this.infoPopover === popover,
          }),
        },
      }),
    ];
  }

  private handleDismiss(event: Event) {
    if (event.target === this.infoPopover) {
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

  private get infoButton() {
    return this.querySelector<HTMLButtonElement>(
      ":scope > .task-detail-info-button",
    );
  }

  private get infoPopover() {
    return this.querySelector<HTMLElement>(":scope > .task-detail-popover");
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
