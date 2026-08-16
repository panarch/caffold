import { escapeHtml } from "../../../../../../../../components/dom.js";
import { renderInlineIcon, warmIcons } from "../../../../../../../../components/icons.js";
import { PENDING_CODEX_TASK_OPERATIONS } from "../../../../../../codex-status.js";
import {
  taskStatusView,
  taskThreadStatusType,
} from "../../../../../runtime-state.js";
import { taskThreadId, taskWorktreeLabel } from "../../../../../task-list-model.js";
import { formatRelativeAgePresentation } from "../../../../../task-format.js";
import {
  patchTaskStatusChip,
  renderTaskStatusChip,
} from "../../../../task-status.js";

export const ACTIVE_TASK_ROW_INTENT_EVENT = "caffold:active-task-row-intent";

const POINTER_DRAG_THRESHOLD_PX = 5;
const TASK_RUNNING_SPINNER_DURATION_MS = 800;
const UNSEEN_ATTENTION_PHASE_COUNT = 8;
const UNSEEN_ATTENTION_PHASE_INTERVAL_MS = 300;

class CaffoldActiveTaskRow extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.addEventListener("click", this.boundClick);
    this.addEventListener("keydown", this.boundKeydown);
    this.addEventListener("pointerdown", this.boundPointerDown);
    this.addEventListener("pointermove", this.boundPointerMove);
    this.addEventListener("pointerup", this.boundPointerUp);
    this.addEventListener("pointercancel", this.boundPointerCancel);
    this.addEventListener("lostpointercapture", this.boundLostPointerCapture);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.boundClick);
    this.removeEventListener("keydown", this.boundKeydown);
    this.removeEventListener("pointerdown", this.boundPointerDown);
    this.removeEventListener("pointermove", this.boundPointerMove);
    this.removeEventListener("pointerup", this.boundPointerUp);
    this.removeEventListener("pointercancel", this.boundPointerCancel);
    this.removeEventListener("lostpointercapture", this.boundLostPointerCapture);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.cancelPointerGesture({ announce: false });
  }

  // The parent list uses moveBefore(), so moving a row needs no reconnect work.
  connectedMoveCallback() {}

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      task: null,
      selectedThreadId: "",
      transportState: "idle",
      codexTaskOperations: PENDING_CODEX_TASK_OPERATIONS,
      reorderMode: false,
      reorderable: false,
      pending: false,
    };
    this.renderMode = "";
    this.pointerGesture = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundKeydown = (event) => this.handleKeydown(event);
    this.boundPointerDown = (event) => this.handlePointerDown(event);
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundPointerUp = (event) => this.handlePointerUp(event);
    this.boundPointerCancel = (event) => this.handlePointerCancel(event);
    this.boundLostPointerCapture = (event) =>
      this.handleLostPointerCapture(event);
    this.boundIconsReady = () => this.render({ replace: true });
    warmIcons();
  }

  setSnapshot(snapshot) {
    this.ensureState();
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
      selectedThreadId: `${snapshot?.selectedThreadId ?? this.snapshot.selectedThreadId ?? ""}`,
      reorderMode: Boolean(snapshot?.reorderMode),
      reorderable: Boolean(snapshot?.reorderable),
      pending: Boolean(snapshot?.pending),
    };
    if (this.snapshot.pending && this.pointerGesture) {
      this.cancelPointerGesture({ announce: false });
    }
    this.render();
  }

  focusHandle() {
    this.querySelector(":scope > .task-row .task-reorder-handle")?.focus();
  }

  containsReorderFocus(element) {
    return Boolean(
      element &&
        this.querySelector(":scope > .task-row .task-reorder-handle")
          ?.contains(element),
    );
  }

  setDropPosition(position = "") {
    this.toggleAttribute("data-task-drop-before", position === "before");
    this.toggleAttribute("data-task-drop-after", position === "after");
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-active-task-row-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const threadId = taskThreadId(this.snapshot.task);
    if (!threadId) {
      return;
    }
    const type = action.dataset.activeTaskRowAction;
    if (type === "open-task") {
      this.emitIntent("select-task", { threadId });
    } else if (type === "open-task-recovery") {
      this.emitIntent("select-task-recovery", { threadId });
    }
  }

  handleKeydown(event) {
    const handle = event.target instanceof Element
      ? event.target.closest(".task-reorder-handle")
      : null;
    if (!handle || !this.contains(handle) || handle.disabled) {
      return;
    }
    const direction = event.key === "ArrowUp"
      ? "up"
      : event.key === "ArrowDown"
        ? "down"
        : "";
    if (!direction) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.emitIntent("move", {
      threadId: taskThreadId(this.snapshot.task),
      direction,
    });
  }

  handlePointerDown(event) {
    const handle = event.target instanceof Element
      ? event.target.closest(".task-reorder-handle")
      : null;
    if (
      !handle ||
      !this.contains(handle) ||
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

  handlePointerMove(event) {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
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
      this.emitIntent("drag-start", {
        threadId: taskThreadId(this.snapshot.task),
        clientY: event.clientY,
      });
    }
    event.preventDefault();
    this.emitIntent("drag-move", {
      threadId: taskThreadId(this.snapshot.task),
      clientY: event.clientY,
    });
  }

  handlePointerUp(event) {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    const dragging = gesture.dragging;
    this.finishPointerGesture();
    if (dragging) {
      event.preventDefault();
      this.emitIntent("drag-end", {
        threadId: taskThreadId(this.snapshot.task),
        clientY: event.clientY,
      });
    }
  }

  handlePointerCancel(event) {
    if (this.pointerGesture?.pointerId !== event.pointerId) {
      return;
    }
    this.cancelPointerGesture();
  }

  handleLostPointerCapture(event) {
    if (this.pointerGesture?.pointerId !== event.pointerId) {
      return;
    }
    this.cancelPointerGesture();
  }

  cancelPointerGesture({ announce = true } = {}) {
    const dragging = Boolean(this.pointerGesture?.dragging);
    this.finishPointerGesture();
    if (dragging && announce) {
      this.emitIntent("drag-cancel", {
        threadId: taskThreadId(this.snapshot.task),
      });
    }
  }

  finishPointerGesture() {
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
      // Pointer capture may already have been released by the browser.
    }
  }

  emitIntent(type, detail = {}) {
    this.dispatchEvent(
      new CustomEvent(ACTIVE_TASK_ROW_INTENT_EVENT, {
        bubbles: true,
        detail: { type, ...detail },
      }),
    );
  }

  render({ replace = false } = {}) {
    this.ensureState();
    const task = this.snapshot.task;
    if (!task) {
      this.replaceChildren();
      this.renderMode = "";
      return;
    }
    const mode = this.snapshot.reorderMode && this.snapshot.reorderable
      ? "reorder"
      : "normal";
    const template = document.createElement("template");
    template.innerHTML = renderRow(this.snapshot, mode).trim();
    const nextRow = template.content.firstElementChild;
    const currentRow = this.querySelector(":scope > .task-row");
    if (
      replace ||
      this.renderMode !== mode ||
      !currentRow ||
      !nextRow ||
      !patchTaskRow(currentRow, nextRow, mode)
    ) {
      this.replaceChildren(nextRow);
    }
    this.renderMode = mode;
    initializeRunningSpinners(this);
  }
}

function renderRow(snapshot, mode) {
  const task = snapshot.task;
  const threadId = taskThreadId(task);
  const status =
    taskStatusView(task, snapshot.transportState)?.status ??
    taskThreadStatusType(task);
  const selected = threadId === snapshot.selectedThreadId
    ? ` aria-current="true"`
    : "";
  const busy = status === "running" ? ` aria-busy="true"` : "";
  if (mode === "reorder") {
    const label = `Reorder ${task.title}. Use Up and Down arrow keys to move.`;
    return `
      <div class="task-row task-row-reorder-mode" data-thread-id="${escapeHtml(threadId)}" data-task-status="${escapeHtml(status)}" title="${escapeHtml(task.title)}"${selected}${busy}>
        <span class="task-row-title">${escapeHtml(task.title)}</span>
        <span class="task-row-indicators task-row-reorder-slot">
          <button type="button" class="task-reorder-handle" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${snapshot.pending ? " disabled" : ""}>
            ${renderInlineIcon("Grip", "Reorder", "task-reorder-handle-icon")}
          </button>
        </span>
      </div>
    `;
  }

  const unseen = Boolean(
    threadId && task?.unseen && threadId !== snapshot.selectedThreadId,
  );
  const recoveryCopy = task?.recovery && task?.conversationAvailable === false
    ? recoveryReasonCopy(task.recovery.reason)
    : "";
  const meta = recoveryCopy
    ? `<span class="task-row-recovery-status" title="${escapeHtml(recoveryCopy)}">
        ${renderInlineIcon("TriangleAlert", recoveryCopy, "task-row-recovery-icon")}
      </span>`
    : unseen
      ? renderUnseenTaskRowMeta(task)
      : renderTaskRowMeta(task, snapshot.transportState);
  const worktree = task?.worktree?.linked
    ? `<span class="task-row-worktree" title="${escapeHtml(taskWorktreeLabel(task))}">
        ${renderInlineIcon("GitBranch", "Linked worktree", "task-row-worktree-icon")}
      </span>`
    : "";
  const action = recoveryCopy ? "open-task-recovery" : "open-task";
  const blocked = snapshot.codexTaskOperations?.blocked !== false;
  const title = blocked
    ? snapshot.codexTaskOperations.title
    : recoveryCopy
      ? `${task.title} — ${recoveryCopy}`
      : task.title;
  return `
    <button type="button" class="task-row" data-active-task-row-action="${action}" data-thread-id="${escapeHtml(threadId)}" data-task-status="${escapeHtml(status)}"${task?.recovery ? ` data-task-recovery-reason="${escapeHtml(task.recovery.reason ?? "")}"` : ""} title="${escapeHtml(title)}"${selected}${busy}${blocked ? " disabled" : ""}>
      <span class="task-row-title">${escapeHtml(task.title)}</span>
      <span class="task-row-indicators">${worktree}${meta}</span>
    </button>
  `;
}

function recoveryReasonCopy(reason) {
  return {
    codexArchived: "Archived in Codex",
    threadMissing: "Thread unavailable",
    temporarilyUnavailable: "Temporarily unavailable",
    sectionPlacementPending: "Section placement pending",
  }[reason] ?? "Recovery required";
}

function renderUnseenTaskRowMeta(task) {
  const attentionDelayMs = unseenAttentionDelayMs(taskThreadId(task));
  return `
    <span class="task-row-meta task-unseen-complete" title="Completed - not viewed" aria-label="Completed - not viewed" style="--task-unseen-attention-delay: ${attentionDelayMs}ms"></span>
  `;
}

function renderTaskRowMeta(task, transportState) {
  const status = renderTaskStatusChip(task, "task-row-meta", {
    label: false,
    transportState,
  });
  if (status) {
    return status;
  }
  const ms = task.lastCompletedMs ?? task.recencyMs ?? task.updatedMs;
  const date = new Date(Number(ms));
  const dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
  const age = formatRelativeAgePresentation(ms);
  return `
    <time class="task-row-meta task-row-time" datetime="${escapeHtml(dateTime)}" aria-label="${escapeHtml(age.label)}">
      ${escapeHtml(age.text)}
    </time>
  `;
}

function unseenAttentionDelayMs(threadId) {
  let checksum = 0;
  for (const [index, character] of [...threadId].entries()) {
    checksum += character.codePointAt(0) * (index + 1);
  }
  const phase = checksum % UNSEEN_ATTENTION_PHASE_COUNT;
  return 0 - phase * UNSEEN_ATTENTION_PHASE_INTERVAL_MS;
}

function patchTaskRow(current, next, mode) {
  if (current.tagName !== next.tagName) {
    return false;
  }
  const currentTitle = current.querySelector(":scope > .task-row-title");
  const nextTitle = next.querySelector(":scope > .task-row-title");
  const currentIndicators = current.querySelector(":scope > .task-row-indicators");
  const nextIndicators = next.querySelector(":scope > .task-row-indicators");
  if (!currentTitle || !nextTitle || !currentIndicators || !nextIndicators) {
    return false;
  }
  syncElementAttributes(current, next, [
    "type",
    "class",
    "data-active-task-row-action",
    "data-thread-id",
    "data-task-status",
    "data-task-recovery-reason",
    "title",
    "aria-current",
    "aria-busy",
    "disabled",
  ]);
  if (currentTitle.textContent !== nextTitle.textContent) {
    currentTitle.textContent = nextTitle.textContent;
  }
  syncElementAttributes(currentIndicators, nextIndicators, ["class"]);
  if (mode === "reorder") {
    const currentHandle = currentIndicators.querySelector(":scope > .task-reorder-handle");
    const nextHandle = nextIndicators.querySelector(":scope > .task-reorder-handle");
    if (!currentHandle || !nextHandle) {
      return false;
    }
    syncElementAttributes(currentHandle, nextHandle, [
      "type",
      "class",
      "aria-label",
      "title",
      "disabled",
    ]);
    return true;
  }
  patchTaskRowIndicator(currentIndicators, nextIndicators, ".task-row-worktree");
  patchTaskRowIndicator(currentIndicators, nextIndicators, ".task-row-meta");
  patchTaskRowIndicator(
    currentIndicators,
    nextIndicators,
    ".task-row-recovery-status",
  );
  return true;
}

function patchTaskRowIndicator(currentIndicators, nextIndicators, selector) {
  const current = currentIndicators.querySelector(`:scope > ${selector}`);
  const next = nextIndicators.querySelector(`:scope > ${selector}`);
  if (current && next && patchMatchingTaskRowIndicator(current, next)) {
    initializeRunningSpinners(current);
    return;
  }
  if (current && next) {
    current.replaceWith(next);
    initializeRunningSpinners(next);
    return;
  }
  if (current) {
    current.remove();
    return;
  }
  if (!next) {
    return;
  }
  const meta = currentIndicators.querySelector(":scope > .task-row-meta");
  currentIndicators.insertBefore(next, selector === ".task-row-worktree" ? meta : null);
  initializeRunningSpinners(next);
}

function patchMatchingTaskRowIndicator(current, next) {
  if (current.matches(".task-status-chip") && next.matches(".task-status-chip")) {
    patchTaskStatusChip(current, next);
    return true;
  }
  if (current.matches(".task-row-worktree") && next.matches(".task-row-worktree")) {
    syncElementAttributes(current, next, ["class", "title"]);
    return true;
  }
  if (
    current.matches(".task-row-recovery-status") &&
    next.matches(".task-row-recovery-status")
  ) {
    syncElementAttributes(current, next, ["class", "title"]);
    return true;
  }
  if (
    current.matches(".task-unseen-complete") &&
    next.matches(".task-unseen-complete")
  ) {
    syncElementAttributes(current, next, [
      "class",
      "title",
      "aria-label",
      "style",
    ]);
    return true;
  }
  if (current.matches(".task-row-time") && next.matches(".task-row-time")) {
    syncElementAttributes(current, next, ["class", "datetime", "aria-label"]);
    if (current.textContent !== next.textContent) {
      current.textContent = next.textContent;
    }
    return true;
  }
  return false;
}

function initializeRunningSpinners(root) {
  const spinners = root.matches?.(".task-status-spinner")
    ? [root]
    : root.querySelectorAll(".task-status-spinner");
  for (const spinner of spinners) {
    if (!spinner.closest('.task-row[data-task-status="running"]')) {
      spinner.style.removeProperty("animation-delay");
      continue;
    }
    if (spinner.style.animationDelay) {
      continue;
    }
    const delayMs =
      0 - (Math.random() * (TASK_RUNNING_SPINNER_DURATION_MS - 1) + 1);
    spinner.style.animationDelay = `${delayMs}ms`;
  }
}

function syncElementAttributes(element, nextElement, names) {
  for (const name of names) {
    if (nextElement.hasAttribute(name)) {
      const value = nextElement.getAttribute(name);
      if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
      }
    } else if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }
}

if (!customElements.get("caffold-active-task-row")) {
  customElements.define("caffold-active-task-row", CaffoldActiveTaskRow);
}
