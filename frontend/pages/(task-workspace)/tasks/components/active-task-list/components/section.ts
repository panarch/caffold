import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.ts";
import {
  type TaskOperationsPresentation,
  taskStoreOperationsPresentation,
} from "#app/pages/(task-workspace)/task-store-status.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import { sectionLabel } from "#tasks/task-format.ts";
import { type ListedTask, taskThreadId } from "#tasks/task-list-model.ts";
import { moveListItemBefore } from "../move-list-item.ts";
import {
  CaffoldActiveTaskRow,
  type TaskRowIntent,
} from "./section/components/row.ts";

export const ACTIVE_TASK_SECTION_INTENT_EVENT =
  "caffold:active-task-section-intent";

// The component in each row a Section made. A row keeps it when it moves to
// another Section.
const rowComponents = new WeakMap<HTMLLIElement, CaffoldActiveTaskRow>();

export type ReorderMode = "none" | "tasks" | "sections";

// A Section as the list shows it. The Tasks awaiting recovery are shown as one
// more Section, with a label of their own and nothing to reorder.
export interface ListedSection {
  id: string;
  name: string;
  repository: boolean;
  label?: string;
  recovery?: boolean;
  tasks: ListedTask[];
}

// What a Section shows, as the list hands it over.
export interface SectionSnapshot {
  section: ListedSection | null;
  selectedSectionId: string;
  selectedThreadId: string;
  taskOperations: TaskOperationsPresentation;
  reorderMode: ReorderMode;
  // A move is being saved.
  pending: boolean;
}

// What the person asks of a Section through its header.
type SectionAction =
  | { type: "select-section" }
  | { type: "move"; direction: "up" | "down" }
  | { type: "drag-start" | "drag-move" | "drag-end"; clientY: number }
  | { type: "drag-cancel" };

export type SectionIntent =
  | ({ subject: "task" } & TaskRowIntent)
  | ({ subject: "section"; sectionId: string } & SectionAction);

const POINTER_DRAG_THRESHOLD_PX = 5;

interface PointerGesture {
  pointerId: number;
  handle: HTMLButtonElement;
  startX: number;
  startY: number;
  dragging: boolean;
}

/**
 * One Section of the Active list: a header that opens it and a list of its
 * Task rows.
 *
 * The header is this element's template. The rows are kept outside it: the
 * Section creates, removes, and moves them with `moveBefore()`, and takes in a
 * row another Section hands over, so a Task keeps its row element wherever it
 * goes. Its own intents and its rows' leave as
 * `ACTIVE_TASK_SECTION_INTENT_EVENT`.
 */
export class CaffoldActiveTaskSection extends LitElement {
  private snapshot: SectionSnapshot = {
    section: null,
    selectedSectionId: "",
    selectedThreadId: "",
    taskOperations: taskStoreOperationsPresentation(null),
    reorderMode: "none",
    pending: false,
  };
  private pointerGesture: PointerGesture | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly list = new DrawnRef<HTMLOListElement>(this);
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

  // `availableRows` are rows other Sections let go of, to be taken in by
  // thread. A caller that is still handing rows around leaves pruning to
  // `pruneRows()`.
  setSnapshot(
    snapshot: SectionSnapshot,
    {
      availableRows = new Map<string, HTMLLIElement>(),
      prune = true,
    }: { availableRows?: Map<string, HTMLLIElement>; prune?: boolean } = {},
  ) {
    this.snapshot = snapshot;
    if (
      this.pointerGesture &&
      (snapshot.pending || snapshot.reorderMode !== "sections")
    ) {
      this.cancelPointerGesture({ announce: false });
    }
    this.requestUpdate();
    this.performUpdate();
    this.reconcileRows(availableRows);
    if (prune) {
      this.pruneRows();
    }
  }

  focusHandle() {
    this.handle.value?.focus();
  }

  containsReorderFocus(element: Element | null) {
    if (!element || !this.contains(element)) {
      return false;
    }
    return (
      Boolean(this.handle.value?.contains(element)) ||
      this.rowComponents().some((row) => row.containsReorderFocus(element))
    );
  }

  setDropPosition(position: "before" | "after" | "" = "") {
    this.toggleAttribute("data-section-drop-before", position === "before");
    this.toggleAttribute("data-section-drop-after", position === "after");
  }

  rowFor(threadId: string) {
    if (!threadId) {
      return null;
    }
    return this.rows().find((row) => row.dataset.threadId === threadId) ?? null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    const own = this.hints.scope(pull);
    return mergeActionHintScopes(
      own,
      ...(this.snapshot.reorderMode === "sections"
        ? []
        : this.rowComponents().map((row) => row.actionHintScope(pull))),
    );
  }

  hasTaskRow(threadId: string) {
    return Boolean(this.rowFor(threadId));
  }

  containsTaskHandleFocus(threadId: string, element: Element | null) {
    return Boolean(
      this.rowComponentFor(threadId)?.containsReorderFocus(element),
    );
  }

  focusTaskHandle(threadId: string) {
    this.rowComponentFor(threadId)?.focusHandle();
  }

  // Marks where a dragged row would land and answers the Task it would go
  // before: `null` for the end, `undefined` when the row is not in this list.
  updateTaskDropTarget(threadId: string, clientY: number) {
    const list = this.list.value;
    const source = this.rowFor(threadId);
    if (!Number.isFinite(clientY) || !list || source?.parentElement !== list) {
      return undefined;
    }
    const candidates = this.rows().filter((row) => row !== source);
    const before =
      candidates.find((row) => {
        const bounds = row.getBoundingClientRect();
        return clientY < bounds.top + bounds.height / 2;
      }) ?? null;
    this.clearTaskDropTarget();
    const target = before ?? candidates.at(-1) ?? source;
    this.rowComponentFor(target.dataset.threadId ?? "")?.setDropPosition(
      before ? "before" : "after",
    );
    return before?.dataset.threadId ?? null;
  }

  clearTaskDropTarget() {
    for (const row of this.rowComponents()) {
      row.setDropPosition();
    }
  }

  // A Task changed without moving: only its row draws again.
  updateTask(task: ListedTask) {
    const threadId = taskThreadId(task);
    const row = this.rowFor(threadId);
    const section = this.snapshot.section;
    if (!threadId || !row || !section) {
      return false;
    }
    this.snapshot = {
      ...this.snapshot,
      section: {
        ...section,
        tasks: section.tasks.map((candidate) =>
          taskThreadId(candidate) === threadId ? task : candidate,
        ),
      },
    };
    this.syncRow(row, task);
    return true;
  }

  // Lets go of the rows of Tasks that moved to another Section, and removes
  // the rows of Tasks that left the list.
  transferableRows(localThreadIds: Set<string>, listedThreadIds: Set<string>) {
    const rows = new Map<string, HTMLLIElement>();
    for (const row of this.rows()) {
      const threadId = row.dataset.threadId ?? "";
      if (localThreadIds.has(threadId)) {
        continue;
      }
      if (listedThreadIds.has(threadId)) {
        rows.set(threadId, row);
      } else {
        row.remove();
      }
    }
    return rows;
  }

  moveTaskRow(threadId: string, beforeThreadId: string | null) {
    const list = this.list.value;
    const row = this.rowFor(threadId);
    const before = beforeThreadId ? this.rowFor(beforeThreadId) : null;
    if (
      !list ||
      row?.parentElement !== list ||
      (beforeThreadId && before?.parentElement !== list) ||
      row.nextElementSibling === before ||
      (!before && row === list.lastElementChild)
    ) {
      return;
    }
    moveListItemBefore(list, row, before);
  }

  pruneRows() {
    const listed = new Set(
      (this.snapshot.section?.tasks ?? []).map(taskThreadId),
    );
    for (const row of this.rows()) {
      if (!listed.has(row.dataset.threadId ?? "")) {
        row.remove();
      }
    }
  }

  // The header names the Section, counts its Tasks, and holds its reorder
  // handle; the rows' list stays empty here and is the Section's to fill.
  render() {
    const { section } = this.snapshot;
    const header = section ? this.header(section) : nothing;
    return html`<div class="task-repository-header">${header}</div>
      <ol
        ${drawn(this.list)}
        class="task-list"
        @caffold:active-task-row-intent=${this.forwardTaskIntent}
      ></ol>`;
  }

  updated() {
    const { section, reorderMode } = this.snapshot;
    if (this.dataset.reorderMode !== reorderMode) {
      this.dataset.reorderMode = reorderMode;
    }
    const sectionId = section && !section.recovery ? section.id : undefined;
    if (this.dataset.sectionId !== sectionId) {
      if (sectionId === undefined) {
        delete this.dataset.sectionId;
      } else {
        this.dataset.sectionId = sectionId;
      }
    }
  }

  // A selectable Section opens from a button; a recovery group, or any Section
  // while the list reorders, shows the same name without one.
  private header(section: ListedSection) {
    const { reorderMode, selectedSectionId, pending } = this.snapshot;
    const label = section.label ?? sectionLabel(section.name);
    const [icon, iconLabel] = section.recovery
      ? ["CircleAlert", "Section recovery"]
      : section.repository
        ? ["FolderGit2", "Git repository"]
        : ["Folder", "Directory"];
    const name = html`${inlineIcon(
      icon,
      iconLabel,
      "task-repository-icon",
    )}<span class="task-repository-label">${label}</span>`;
    const current = section.recovery
      ? nothing
      : selectedSectionId === section.id
        ? "page"
        : "false";
    const select =
      !section.recovery && reorderMode === "none"
        ? html`<button
            ${this.hints.button({
              id: `section:${section.id}`,
              label: `Open section: ${label}`,
              action: ACTION_HINT_ACTION.SECTION_OPEN,
            })}
            type="button"
            class="task-repository-select"
            title=${section.name}
            data-section-id=${section.id}
            aria-current=${current}
            data-active-task-section-action="open-section"
            @click=${this.openSection}
          >${name}</button>`
        : html`<div
            class="task-repository-select"
            title=${section.name}
            data-section-id=${section.recovery ? nothing : section.id}
            aria-current=${current}
          >${name}</div>`;
    const handle = section.recovery
      ? nothing
      : html`<button
          ${drawn(this.handle)}
          ${this.hints.reorderHandle({
            id: `section:${section.id}:reorder`,
            label: `Reorder ${label}`,
            action: ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS,
            when: reorderMode === "sections",
          })}
          type="button"
          class="section-reorder-handle"
          data-section-id=${section.id}
          aria-label=${`Reorder ${label}`}
          title=${`Reorder ${label}`}
          ?disabled=${pending}
          @keydown=${this.handleHandleKeydown}
          @pointerdown=${this.handlePointerDown}
        >${inlineIcon(
          "Grip",
          "Reorder Section",
          "section-reorder-handle-icon",
        )}</button>`;
    return html`${select}<span class="task-repository-count"
      >${section.tasks.length}</span
    >${handle}`;
  }

  // The rows in the Section's order: kept where they are, taken in from
  // another Section, or new.
  private reconcileRows(availableRows: Map<string, HTMLLIElement>) {
    const section = this.snapshot.section;
    const list = this.list.value;
    if (!section || !list) {
      return;
    }
    const listed = new Set(section.tasks.map(taskThreadId));
    const nextListedRow = (start: Element | null) => {
      let row = start;
      while (row && !listed.has(row.getAttribute("data-thread-id") ?? "")) {
        row = row.nextElementSibling;
      }
      return row;
    };
    let nextRow = nextListedRow(list.firstElementChild);
    for (const task of section.tasks) {
      const threadId = taskThreadId(task);
      const row =
        this.rowFor(threadId) ??
        availableRows.get(threadId) ??
        document.createElement("li");
      availableRows.delete(threadId);
      row.dataset.threadId = threadId;
      row.dataset.taskListKey = section.id;
      this.syncRow(row, task);
      if (row === nextRow) {
        nextRow = nextListedRow(nextRow.nextElementSibling);
      } else {
        moveListItemBefore(list, row, nextRow);
      }
    }
  }

  private syncRow(row: HTMLLIElement, task: ListedTask) {
    let component = rowComponents.get(row);
    if (!component) {
      component = new CaffoldActiveTaskRow();
      rowComponents.set(row, component);
      row.replaceChildren(component);
    }
    const { section, selectedThreadId, taskOperations, reorderMode, pending } =
      this.snapshot;
    component.setSnapshot({
      task,
      selectedThreadId,
      taskOperations,
      reorderMode: reorderMode === "tasks",
      reorderable: !section?.recovery,
      pending,
    });
  }

  private openSection(event: Event) {
    event.stopPropagation();
    const sectionId = this.snapshot.section?.id;
    if (sectionId) {
      this.emitIntent({ type: "select-section" });
    }
  }

  private forwardTaskIntent(event: CustomEvent<TaskRowIntent>) {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target !== this.rowComponentFor(event.detail.threadId)
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent<SectionIntent>(ACTIVE_TASK_SECTION_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { subject: "task", ...event.detail },
      }),
    );
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
    this.emitIntent({ type: "move", direction });
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
      this.emitIntent({ type: "drag-start", clientY: event.clientY });
    }
    event.preventDefault();
    this.emitIntent({ type: "drag-move", clientY: event.clientY });
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
      this.emitIntent({ type: "drag-end", clientY: event.clientY });
    }
  }

  private handlePointerCancel(event: PointerEvent) {
    if (this.pointerGesture?.pointerId === event.pointerId) {
      this.cancelPointerGesture();
    }
  }

  cancelPointerGesture({ announce = true } = {}) {
    const dragging = Boolean(this.pointerGesture?.dragging);
    this.finishPointerGesture();
    if (dragging && announce) {
      this.emitIntent({ type: "drag-cancel" });
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

  private emitIntent(action: SectionAction) {
    this.dispatchEvent(
      new CustomEvent<SectionIntent>(ACTIVE_TASK_SECTION_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: {
          subject: "section",
          sectionId: this.snapshot.section?.id ?? "",
          ...action,
        },
      }),
    );
  }

  // The rows this Section holds, in their order.
  private rows() {
    return [...(this.list.value?.children ?? [])] as HTMLLIElement[];
  }

  private rowComponents() {
    return this.rows().flatMap((row) => {
      const component = rowComponents.get(row);
      return component ? [component] : [];
    });
  }

  private rowComponentFor(threadId: string) {
    const row = this.rowFor(threadId);
    return (row && rowComponents.get(row)) ?? null;
  }
}

customElements.define("caffold-active-task-section", CaffoldActiveTaskSection);
