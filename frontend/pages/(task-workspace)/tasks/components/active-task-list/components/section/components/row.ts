import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import type { ActiveTaskRecovery } from "#app/api.ts";
import {
  type TaskOperationsPresentation,
  taskStoreOperationsPresentation,
} from "#app/pages/(task-workspace)/task-store-status.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import "#tasks/components/task-status-chip.ts";
import { taskStatusView, taskThreadStatusType } from "#tasks/runtime-state.ts";
import { formatRelativeAgePresentation } from "#tasks/task-format.ts";
import { type ListedTask, taskThreadId } from "#tasks/task-list-model.ts";

export const ACTIVE_TASK_ROW_INTENT_EVENT = "caffold:active-task-row-intent";

// What a row shows, as its Section hands it over.
export interface TaskRowSnapshot {
  task: ListedTask | null;
  selectedThreadId: string;
  taskOperations: TaskOperationsPresentation;
  // The list is reordering Tasks, and this row can move.
  reorderMode: boolean;
  reorderable: boolean;
  // A move is being saved.
  pending: boolean;
}

export type TaskRowIntent =
  | { type: "select-task" | "select-task-recovery"; threadId: string }
  | { type: "move"; threadId: string; direction: "up" | "down" }
  | {
      type: "drag-start" | "drag-move" | "drag-end";
      threadId: string;
      clientY: number;
    }
  | { type: "drag-cancel"; threadId: string };

const POINTER_DRAG_THRESHOLD_PX = 5;
const UNSEEN_ATTENTION_PHASE_COUNT = 8;
const UNSEEN_ATTENTION_PHASE_INTERVAL_MS = 300;

interface PointerGesture {
  pointerId: number;
  handle: HTMLButtonElement;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * One Task in an Active list Section: a button that opens it, or, while the
 * list reorders Tasks, its title beside a handle to move it by.
 *
 * Its Section hands it the Task and the list's mode and moves it with
 * `moveBefore()`, which keeps a gesture in progress, focus, and a spinner
 * going. What the person does with it leaves as `ACTIVE_TASK_ROW_INTENT_EVENT`.
 */
export class CaffoldActiveTaskRow extends LitElement {
  private snapshot: TaskRowSnapshot = {
    task: null,
    selectedThreadId: "",
    taskOperations: taskStoreOperationsPresentation(null),
    reorderMode: false,
    reorderable: false,
    pending: false,
  };
  private pointerGesture: PointerGesture | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly handle = new DrawnRef<HTMLButtonElement>(this);

  // A captured pointer's events reach the handle and rise to this element,
  // which follows the gesture from there.
  constructor() {
    super();
    this.addEventListener("pointermove", (event) =>
      this.handlePointerMove(event),
    );
    this.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    this.addEventListener("pointercancel", (event) =>
      this.handlePointerCancel(event),
    );
    this.addEventListener("lostpointercapture", (event) =>
      this.handlePointerCancel(event),
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
    this.cancelPointerGesture({ announce: false });
  }

  // A move within the list stays connected.
  connectedMoveCallback() {}

  setSnapshot(snapshot: TaskRowSnapshot) {
    this.snapshot = snapshot;
    if (snapshot.pending) {
      this.cancelPointerGesture({ announce: false });
    }
    this.requestUpdate();
    this.performUpdate();
  }

  focusHandle() {
    this.handle.value?.focus();
  }

  containsReorderFocus(element: Element | null) {
    return Boolean(element && this.handle.value?.contains(element));
  }

  setDropPosition(position: "before" | "after" | "" = "") {
    this.toggleAttribute("data-task-drop-before", position === "before");
    this.toggleAttribute("data-task-drop-after", position === "after");
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  render() {
    const { task, selectedThreadId, taskOperations, pending } = this.snapshot;
    if (!task) {
      return nothing;
    }
    const threadId = taskThreadId(task);
    const status = taskStatusView(task)?.status ?? taskThreadStatusType(task);
    const selected = threadId === selectedThreadId ? "true" : nothing;
    const busy = status === "running" ? "true" : nothing;
    if (this.snapshot.reorderMode && this.snapshot.reorderable) {
      const label = `Reorder ${task.title}. Use Up and Down arrow keys to move.`;
      return html`<div
        class="task-row task-row-reorder-mode"
        data-thread-id=${threadId}
        data-task-status=${status}
        title=${task.title}
        aria-current=${selected}
        aria-busy=${busy}
      >
        <span class="task-row-title">${task.title}</span>
        <span class="task-row-indicators task-row-reorder-slot"><button
          ${drawn(this.handle)}
          ${this.hints.reorderHandle({
            id: `task:${threadId}:reorder`,
            label,
            action: ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS,
          })}
          type="button"
          class="task-reorder-handle"
          aria-label=${label}
          title=${label}
          ?disabled=${pending}
          @keydown=${this.handleHandleKeydown}
          @pointerdown=${this.handlePointerDown}
        >${inlineIcon(
          "Grip",
          "Reorder",
          "task-reorder-handle-icon",
        )}</button></span>
      </div>`;
    }
    const recovery = "recovery" in task ? recoveryCopy(task) : "";
    const action = recovery ? "open-task-recovery" : "open-task";
    const blocked = taskOperations.blocked;
    const title = blocked
      ? taskOperations.title
      : recovery
        ? `${task.title} — ${recovery}`
        : task.title;
    return html`<button
      ${this.hints.button({
        id: `task:${threadId}`,
        label: recovery
          ? `Open task recovery: ${task.title}`
          : `Open task: ${task.title}`,
        action: recovery
          ? ACTION_HINT_ACTION.TASK_OPEN_RECOVERY
          : ACTION_HINT_ACTION.TASK_OPEN,
        when: !this.snapshot.reorderMode,
      })}
      type="button"
      class="task-row"
      data-active-task-row-action=${action}
      data-thread-id=${threadId}
      data-task-status=${status}
      data-task-recovery-reason=${
        "recovery" in task ? task.recovery.reason : nothing
      }
      title=${title}
      aria-current=${selected}
      aria-busy=${busy}
      ?disabled=${blocked}
      @click=${this.handleOpen}
    >
      <span class="task-row-title">${task.title}</span>
      <span class="task-row-indicators">${
        task.worktree === true
          ? html`<span class="task-row-worktree">${inlineIcon(
              "GitBranch",
              "Linked worktree",
              "task-row-worktree-icon",
            )}</span>`
          : nothing
      }${this.rowMeta(task, recovery)}</span>
    </button>`;
  }

  // The one thing a row says beside its title: why it needs recovering, that
  // it finished unseen, what the agent is doing, or when it last finished.
  private rowMeta(task: ListedTask, recovery: string) {
    const threadId = taskThreadId(task);
    if (recovery) {
      const icon = inlineIcon(
        "TriangleAlert",
        recovery,
        "task-row-recovery-icon",
      );
      return html`<span class="task-row-recovery-status" title=${recovery}
        >${icon}</span
      >`;
    }
    if (task.unseen && threadId !== this.snapshot.selectedThreadId) {
      const attentionDelayMs = unseenAttentionDelayMs(threadId);
      return html`<span
        class="task-row-meta task-unseen-complete"
        title="Completed - not viewed"
        aria-label="Completed - not viewed"
        style="--task-unseen-attention-delay: ${attentionDelayMs}ms"
      ></span>`;
    }
    if (taskStatusView(task)) {
      return html`<caffold-task-status-chip
        class="task-row-meta"
        .task=${task}
        staggered
      ></caffold-task-status-chip>`;
    }
    const ms = task.lastCompletedMs ?? task.recencyMs ?? task.updatedMs;
    const date = new Date(ms);
    const age = formatRelativeAgePresentation(ms);
    return html`<time
      class="task-row-meta task-row-time"
      datetime=${Number.isNaN(date.getTime()) ? "" : date.toISOString()}
      aria-label=${age.label}
    >${age.text}</time>`;
  }

  private handleOpen(event: Event) {
    event.stopPropagation();
    const task = this.snapshot.task;
    const threadId = taskThreadId(task);
    if (!task || !threadId) {
      return;
    }
    this.emitIntent({
      type: "recovery" in task ? "select-task-recovery" : "select-task",
      threadId,
    });
  }

  private handleHandleKeydown(event: KeyboardEvent) {
    const direction =
      event.key === "ArrowUp"
        ? "up"
        : event.key === "ArrowDown"
          ? "down"
          : null;
    if (!direction || this.handle.value?.disabled) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.emitIntent({
      type: "move",
      threadId: taskThreadId(this.snapshot.task),
      direction,
    });
  }

  private handlePointerDown(event: PointerEvent) {
    const handle = this.handle.value;
    if (
      !handle ||
      handle.disabled ||
      event.button !== 0 ||
      event.isPrimary === false
    ) {
      return;
    }
    handle.focus({ preventScroll: true });
    this.pointerGesture = {
      pointerId: event.pointerId,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      this.pointerGesture = null;
    }
  }

  private handlePointerMove(event: PointerEvent) {
    const gesture = this.pointerGesture;
    if (gesture?.pointerId !== event.pointerId) {
      return;
    }
    const threadId = taskThreadId(this.snapshot.task);
    if (!gesture.dragging) {
      const distance = Math.hypot(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY,
      );
      if (distance < POINTER_DRAG_THRESHOLD_PX) {
        return;
      }
      gesture.dragging = true;
      this.toggleAttribute("data-dragging", true);
      this.emitIntent({ type: "drag-start", threadId, clientY: event.clientY });
    }
    event.preventDefault();
    this.emitIntent({ type: "drag-move", threadId, clientY: event.clientY });
  }

  private handlePointerUp(event: PointerEvent) {
    const gesture = this.pointerGesture;
    if (gesture?.pointerId !== event.pointerId) {
      return;
    }
    const dragging = gesture.dragging;
    this.finishPointerGesture();
    if (dragging) {
      event.preventDefault();
      this.emitIntent({
        type: "drag-end",
        threadId: taskThreadId(this.snapshot.task),
        clientY: event.clientY,
      });
    }
  }

  private handlePointerCancel(event: PointerEvent) {
    if (this.pointerGesture?.pointerId === event.pointerId) {
      this.cancelPointerGesture();
    }
  }

  private cancelPointerGesture({ announce = true } = {}) {
    const dragging = Boolean(this.pointerGesture?.dragging);
    this.finishPointerGesture();
    if (dragging && announce) {
      this.emitIntent({
        type: "drag-cancel",
        threadId: taskThreadId(this.snapshot.task),
      });
    }
  }

  private finishPointerGesture() {
    const gesture = this.pointerGesture;
    this.pointerGesture = null;
    this.removeAttribute("data-dragging");
    if (!gesture) {
      return;
    }
    try {
      if (gesture.handle.hasPointerCapture(gesture.pointerId)) {
        gesture.handle.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // The browser may already have released the capture.
    }
  }

  private emitIntent(detail: TaskRowIntent) {
    this.dispatchEvent(
      new CustomEvent<TaskRowIntent>(ACTIVE_TASK_ROW_INTENT_EVENT, {
        bubbles: true,
        detail,
      }),
    );
  }
}

function recoveryCopy(task: ActiveTaskRecovery) {
  return (
    {
      codexArchived: "Archived in Codex",
      threadMissing: "Thread unavailable",
      temporarilyUnavailable: "Temporarily unavailable",
      sectionPlacementPending: "Section placement pending",
    }[task.recovery.reason] ?? "Recovery required"
  );
}

// Unseen rows blink out of step, each at a phase its thread id picks.
function unseenAttentionDelayMs(threadId: string) {
  let checksum = 0;
  for (const [index, character] of [...threadId].entries()) {
    checksum += (character.codePointAt(0) ?? 0) * (index + 1);
  }
  const phase = checksum % UNSEEN_ATTENTION_PHASE_COUNT;
  return 0 - phase * UNSEEN_ATTENTION_PHASE_INTERVAL_MS;
}

customElements.define("caffold-active-task-row", CaffoldActiveTaskRow);
