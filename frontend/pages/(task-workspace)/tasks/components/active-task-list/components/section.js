import { renderInlineIcon, warmIcons } from "../../../../../../components/icons.js";
import { taskStoreOperationsPresentation } from "../../../../codex-status.js";
import { taskThreadId } from "../../../task-list-model.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  reorderHandleActionHintTarget,
} from "../../../../../../action-hints.js";
import {
  ACTIVE_TASK_ROW_INTENT_EVENT,
} from "./section/components/row.js";

export const ACTIVE_TASK_SECTION_INTENT_EVENT =
  "caffold:active-task-section-intent";

const POINTER_DRAG_THRESHOLD_PX = 5;

class CaffoldActiveTaskSection extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureDom();
    this.addEventListener("click", this.boundClick);
    this.addEventListener("keydown", this.boundKeydown);
    this.addEventListener("pointerdown", this.boundPointerDown);
    this.addEventListener("pointermove", this.boundPointerMove);
    this.addEventListener("pointerup", this.boundPointerUp);
    this.addEventListener("pointercancel", this.boundPointerCancel);
    this.addEventListener("lostpointercapture", this.boundLostPointerCapture);
    this.addEventListener(ACTIVE_TASK_ROW_INTENT_EVENT, this.boundTaskIntent);
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
    this.removeEventListener(ACTIVE_TASK_ROW_INTENT_EVENT, this.boundTaskIntent);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.cancelPointerGesture({ announce: false });
  }

  // The parent list and this Section use moveBefore(), so moving a Section or
  // one of its Task rows needs no reconnect work.
  connectedMoveCallback() {}

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      section: null,
      selectedSectionId: "",
      selectedThreadId: "",
      transportState: "idle",
      taskOperations: taskStoreOperationsPresentation(null),
      reorderMode: "none",
      pending: false,
    };
    this.pointerGesture = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundKeydown = (event) => this.handleKeydown(event);
    this.boundPointerDown = (event) => this.handlePointerDown(event);
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundPointerUp = (event) => this.handlePointerUp(event);
    this.boundPointerCancel = (event) => this.handlePointerCancel(event);
    this.boundLostPointerCapture = (event) =>
      this.handleLostPointerCapture(event);
    this.boundTaskIntent = (event) => this.handleTaskIntent(event);
    this.boundIconsReady = () => this.renderHeader();
    warmIcons();
  }

  ensureDom() {
    if (
      this.querySelector(":scope > .task-repository-header") &&
      this.querySelector(":scope > .task-list")
    ) {
      return;
    }
    const header = document.createElement("div");
    header.className = "task-repository-header";
    const list = document.createElement("ol");
    list.className = "task-list";
    this.replaceChildren(header, list);
  }

  setSnapshot(snapshot, { availableRows = new Map(), prune = true } = {}) {
    this.ensureState();
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
      selectedSectionId:
        `${snapshot?.selectedSectionId ?? this.snapshot.selectedSectionId ?? ""}`,
      selectedThreadId:
        `${snapshot?.selectedThreadId ?? this.snapshot.selectedThreadId ?? ""}`,
      reorderMode: normalizeReorderMode(
        snapshot?.reorderMode ?? this.snapshot.reorderMode,
      ),
      pending: Boolean(snapshot?.pending),
    };
    if (
      this.pointerGesture &&
      (this.snapshot.pending || this.snapshot.reorderMode !== "sections")
    ) {
      this.cancelPointerGesture({ announce: false });
    }
    this.render({ availableRows, prune });
  }

  focusHandle() {
    this.querySelector(
      ":scope > .task-repository-header > .section-reorder-handle",
    )?.focus();
  }

  containsReorderFocus(element) {
    if (!element || !this.contains(element)) {
      return false;
    }
    const sectionHandle = this.querySelector(
      ":scope > .task-repository-header > .section-reorder-handle",
    );
    if (sectionHandle?.contains(element)) {
      return true;
    }
    return [...this.querySelectorAll(
      ":scope > .task-list > li > caffold-active-task-row",
    )].some((component) => component.containsReorderFocus(element));
  }

  setDropPosition(position = "") {
    this.toggleAttribute("data-section-drop-before", position === "before");
    this.toggleAttribute("data-section-drop-after", position === "after");
  }

  rowFor(threadId) {
    if (!threadId) {
      return null;
    }
    return this.querySelector(
      `:scope > .task-list > li[data-thread-id="${CSS.escape(threadId)}"]`,
    );
  }

  rowComponentFor(threadId) {
    return this.rowFor(threadId)?.querySelector(
      ":scope > caffold-active-task-row",
    ) ?? null;
  }

  actionHintTargets(options = {}) {
    const section = this.snapshot.section;
    if (this.snapshot.reorderMode === "sections") {
      const target = sectionReorderActionHintTarget(this, options);
      return target ? [target] : [];
    }
    const rows = [...this.querySelectorAll(
      ":scope > .task-list > li > caffold-active-task-row",
    )];
    if (this.snapshot.reorderMode === "tasks") {
      return rows.flatMap((row) => {
        const target = row.reorderActionHintTarget(options);
        return target ? [target] : [];
      });
    }
    const sectionControl = this.querySelector(
      ':scope > .task-repository-header > button[data-active-task-section-action="open-section"]',
    );
    const targets = [];
    if (
      section?.id &&
      !section.recovery &&
      this.snapshot.reorderMode === "none" &&
      sectionControl &&
      !sectionControl.disabled
    ) {
      const sectionId = `${section.id}`;
      const label = section.label ?? activeTaskSectionLabel(section.name);
      targets.push(buttonActionHintTarget({
        invalidationOwner: this,
        id: `section:${sectionId}`,
        actionId: ACTION_HINT_ACTION.SECTION_OPEN,
        label: `Open section: ${label}`,
        control: sectionControl,
        clipRoots: [...(options.clipRoots ?? [])],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.section?.id === sectionId &&
          !this.snapshot.section?.recovery &&
          this.snapshot.reorderMode === "none" &&
          this.querySelector(
            ':scope > .task-repository-header > button[data-active-task-section-action="open-section"]',
          ) === sectionControl &&
          !sectionControl.disabled,
      }));
    }
    targets.push(...rows.flatMap((row) => {
      const target = row.actionHintTarget(options);
      return target ? [target] : [];
    }));
    return targets;
  }

  hasTaskRow(threadId) {
    return Boolean(this.rowFor(threadId));
  }

  containsTaskHandleFocus(threadId, element) {
    return Boolean(
      this.rowComponentFor(threadId)?.containsReorderFocus(element),
    );
  }

  focusTaskHandle(threadId) {
    this.rowComponentFor(threadId)?.focusHandle();
  }

  updateTaskDropTarget(threadId, clientY) {
    const list = this.querySelector(":scope > .task-list");
    const source = this.rowFor(threadId);
    if (
      !Number.isFinite(clientY) ||
      !list ||
      source?.parentElement !== list
    ) {
      return undefined;
    }
    const candidates = [...list.children].filter((row) => row !== source);
    const before = candidates.find((row) => {
      const bounds = row.getBoundingClientRect();
      return clientY < bounds.top + bounds.height / 2;
    }) ?? null;
    this.clearTaskDropTarget();
    const target = before ?? candidates.at(-1) ?? source;
    this.rowComponentFor(target.dataset.threadId)?.setDropPosition(
      before ? "before" : "after",
    );
    return before?.dataset.threadId ?? null;
  }

  clearTaskDropTarget() {
    for (const component of this.querySelectorAll(
      ":scope > .task-list > li > caffold-active-task-row",
    )) {
      component.setDropPosition();
    }
  }

  updateTask(task) {
    const threadId = taskThreadId(task);
    const row = this.rowFor(threadId);
    if (!threadId || !row || !this.snapshot.section) {
      return false;
    }
    this.snapshot.section = {
      ...this.snapshot.section,
      tasks: this.snapshot.section.tasks.map((candidate) =>
        taskThreadId(candidate) === threadId ? task : candidate
      ),
    };
    this.syncRow(row, task);
    return true;
  }

  transferableRows(localThreadIds, projectedThreadIds) {
    const rows = new Map();
    for (const row of this.querySelectorAll(":scope > .task-list > li")) {
      const threadId = row.dataset.threadId;
      if (localThreadIds.has(threadId)) {
        continue;
      }
      if (projectedThreadIds.has(threadId)) {
        rows.set(threadId, row);
      } else {
        row.remove();
      }
    }
    return rows;
  }

  moveTaskRow(threadId, beforeThreadId) {
    const list = this.querySelector(":scope > .task-list");
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

  handleTaskIntent(event) {
    const threadId = `${event.detail?.threadId ?? ""}`;
    if (
      !(event.target instanceof Element) ||
      event.target !== this.rowComponentFor(threadId)
    ) {
      return;
    }
    event.stopPropagation();
    this.dispatchEvent(
      new CustomEvent(ACTIVE_TASK_SECTION_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { subject: "task", ...event.detail },
      }),
    );
  }

  handleClick(event) {
    const action = event.target instanceof Element
      ? event.target.closest("[data-active-task-section-action]")
      : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const sectionId = `${this.snapshot.section?.id ?? ""}`;
    if (action.dataset.activeTaskSectionAction === "open-section" && sectionId) {
      this.emitIntent("select-section", { sectionId });
    }
  }

  handleKeydown(event) {
    const handle = event.target instanceof Element
      ? event.target.closest(".section-reorder-handle")
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
      sectionId: `${this.snapshot.section?.id ?? ""}`,
      direction,
    });
  }

  handlePointerDown(event) {
    const handle = event.target instanceof Element
      ? event.target.closest(".section-reorder-handle")
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
        sectionId: `${this.snapshot.section?.id ?? ""}`,
        clientY: event.clientY,
      });
    }
    event.preventDefault();
    this.emitIntent("drag-move", {
      sectionId: `${this.snapshot.section?.id ?? ""}`,
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
        sectionId: `${this.snapshot.section?.id ?? ""}`,
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
        sectionId: `${this.snapshot.section?.id ?? ""}`,
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
      new CustomEvent(ACTIVE_TASK_SECTION_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { subject: "section", type, ...detail },
      }),
    );
  }

  render({ availableRows = new Map(), prune = true } = {}) {
    this.ensureState();
    this.ensureDom();
    const section = this.snapshot.section;
    if (!section) {
      this.querySelector(":scope > .task-repository-header")?.replaceChildren();
      this.querySelector(":scope > .task-list")?.replaceChildren();
      return;
    }
    this.dataset.reorderMode = this.snapshot.reorderMode;
    if (section.recovery) {
      delete this.dataset.sectionId;
    } else {
      this.dataset.sectionId = section.id;
    }
    this.renderHeader();
    this.reconcileRows({ availableRows, prune });
  }

  renderHeader() {
    const section = this.snapshot.section;
    const header = this.querySelector(":scope > .task-repository-header");
    if (!section || !header) {
      return;
    }
    const icon = section.recovery
      ? "CircleAlert"
      : section.repository
        ? "FolderGit2"
        : "Folder";
    const iconLabel = section.recovery
      ? "Section recovery"
      : section.repository
        ? "Git repository"
        : "Directory";
    const label = section.label ?? activeTaskSectionLabel(section.name);

    let select = header.querySelector(":scope > .task-repository-select");
    const selectable = !section.recovery && this.snapshot.reorderMode === "none";
    const expectedSelectTag = selectable ? "BUTTON" : "DIV";
    if (select?.tagName !== expectedSelectTag) {
      select?.remove();
      select = document.createElement(expectedSelectTag.toLowerCase());
      select.className = "task-repository-select";
      header.prepend(select);
    }
    select.title = section.name;
    if (!section.recovery) {
      select.dataset.sectionId = section.id;
      select.setAttribute(
        "aria-current",
        this.snapshot.selectedSectionId === section.id ? "page" : "false",
      );
      if (selectable) {
        select.type = "button";
        select.dataset.activeTaskSectionAction = "open-section";
      } else {
        delete select.dataset.activeTaskSectionAction;
      }
    } else {
      delete select.dataset.activeTaskSectionAction;
      delete select.dataset.sectionId;
      select.removeAttribute("aria-current");
    }

    let labelElement = select.querySelector(":scope > .task-repository-label");
    if (!labelElement) {
      select.replaceChildren();
      labelElement = document.createElement("span");
      labelElement.className = "task-repository-label";
      select.append(labelElement);
    }
    if (labelElement.textContent !== label) {
      labelElement.textContent = label;
    }

    let count = header.querySelector(":scope > .task-repository-count");
    if (!count) {
      count = document.createElement("span");
      count.className = "task-repository-count";
      header.append(count);
    }
    const countText = `${section.tasks.length}`;
    if (count.textContent !== countText) {
      count.textContent = countText;
    }

    let handle = header.querySelector(":scope > .section-reorder-handle");
    if (!section.recovery && !handle) {
      handle = document.createElement("button");
      handle.type = "button";
      handle.className = "section-reorder-handle";
      header.append(handle);
    } else if (section.recovery && handle) {
      handle.remove();
      handle = null;
    }
    if (handle) {
      handle.dataset.sectionId = section.id;
      handle.disabled = this.snapshot.pending;
      handle.setAttribute("aria-label", `Reorder ${label}`);
      handle.title = `Reorder ${label}`;
      const gripMarkup = renderInlineIcon(
        "Grip",
        "Reorder Section",
        "section-reorder-handle-icon",
      );
      if (handle.innerHTML !== gripMarkup) {
        handle.innerHTML = gripMarkup;
      }
    }
    if (header.children[1] !== count) {
      header.insertBefore(count, handle);
    }

    const iconMarkup = renderInlineIcon(
      icon,
      iconLabel,
      "task-repository-icon",
    );
    const iconChanged = this.dataset.taskRepositoryIcon !== icon;
    const iconBecameAvailable =
      iconMarkup.includes("task-repository-icon") &&
      !select.querySelector(":scope > .task-repository-icon");
    if (iconChanged || iconBecameAvailable) {
      while (select.firstChild && select.firstChild !== labelElement) {
        select.firstChild.remove();
      }
      const template = document.createElement("template");
      template.innerHTML = iconMarkup;
      select.insertBefore(template.content, labelElement);
      this.dataset.taskRepositoryIcon = icon;
    }
  }

  reconcileRows({ availableRows = new Map(), prune = true } = {}) {
    const section = this.snapshot.section;
    const list = this.querySelector(":scope > .task-list");
    if (!section || !list) {
      return;
    }
    const desiredThreadIds = new Set(section.tasks.map(taskThreadId));
    const nextDesiredRow = (start) => {
      let row = start;
      while (row && !desiredThreadIds.has(row.dataset.threadId)) {
        row = row.nextElementSibling;
      }
      return row;
    };
    let nextRow = nextDesiredRow(list.firstElementChild);
    for (const task of section.tasks) {
      const threadId = taskThreadId(task);
      let row = this.rowFor(threadId) ?? availableRows.get(threadId);
      if (!row) {
        row = document.createElement("li");
      }
      availableRows.delete(threadId);
      row.dataset.threadId = threadId;
      row.dataset.taskListKey = section.id;
      this.syncRow(row, task);
      if (row === nextRow) {
        nextRow = nextDesiredRow(nextRow.nextElementSibling);
      } else {
        moveListItemBefore(list, row, nextRow);
      }
    }
    if (prune) {
      this.pruneRows();
    }
  }

  pruneRows() {
    const desiredThreadIds = new Set(
      (this.snapshot.section?.tasks ?? []).map(taskThreadId),
    );
    for (const row of this.querySelectorAll(":scope > .task-list > li")) {
      if (!desiredThreadIds.has(row.dataset.threadId)) {
        row.remove();
      }
    }
  }

  syncRow(row, task) {
    let component = row.querySelector(":scope > caffold-active-task-row");
    if (!component) {
      component = document.createElement("caffold-active-task-row");
      row.replaceChildren(component);
    }
    component.setSnapshot({
      task,
      selectedThreadId: this.snapshot.selectedThreadId,
      transportState: this.snapshot.transportState,
      taskOperations: this.snapshot.taskOperations,
      reorderMode: this.snapshot.reorderMode === "tasks",
      reorderable: !this.snapshot.section?.recovery,
      pending: this.snapshot.pending,
    });
  }
}

export function activeTaskSectionLabel(name) {
  return `${name ?? ""}`.split("/").filter(Boolean).at(-1) ?? "Directory";
}

function sectionReorderActionHintTarget(owner, { clipRoots = [] } = {}) {
  const section = owner.snapshot.section;
  const sectionId = `${section?.id ?? ""}`;
  const control = owner.querySelector(
    ":scope > .task-repository-header > .section-reorder-handle",
  );
  if (
    !sectionId ||
    section?.recovery ||
    owner.snapshot.reorderMode !== "sections" ||
    owner.snapshot.pending ||
    !control ||
    control.disabled
  ) {
    return null;
  }
  const label = section.label ?? activeTaskSectionLabel(section.name);
  return reorderHandleActionHintTarget({
    invalidationOwner: owner,
    id: `section:${sectionId}:reorder`,
    actionId: ACTION_HINT_ACTION.REORDER_HANDLE_FOCUS,
    label: control.getAttribute("aria-label") || `Reorder ${label}`,
    control,
    clipRoots: [...clipRoots],
    isActionable: () =>
      owner.isConnected &&
      `${owner.snapshot.section?.id ?? ""}` === sectionId &&
      !owner.snapshot.section?.recovery &&
      owner.snapshot.reorderMode === "sections" &&
      !owner.snapshot.pending &&
      owner.querySelector(
        ":scope > .task-repository-header > .section-reorder-handle",
      ) === control &&
      !control.disabled,
  });
}

function normalizeReorderMode(mode) {
  return ["tasks", "sections"].includes(mode) ? mode : "none";
}

function moveListItemBefore(parent, item, before) {
  if (
    typeof parent.moveBefore === "function" &&
    parent.isConnected &&
    item.isConnected
  ) {
    parent.moveBefore(item, before);
  } else {
    parent.insertBefore(item, before);
  }
}

if (!customElements.get("caffold-active-task-section")) {
  customElements.define(
    "caffold-active-task-section",
    CaffoldActiveTaskSection,
  );
}
