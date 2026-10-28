import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { taskStatusKey, taskStatusView } from "../runtime-state.js";
import { formatRelativeAgePresentation } from "../task-format.js";
import { type ListedTask, taskThreadId } from "../task-list-model.js";
import type { TaskWithSection } from "./active-task-list.js";
import "./task-status-chip.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./task-switcher-dialog.css.js";

export const TASK_SWITCHER_SELECT_EVENT = "caffold:task-switcher-select";

// The Task a person picked, and whether it opens as a recovery.
export interface TaskSwitcherSelectDetail {
  threadId: string;
  recovery: boolean;
}

// The Active Tasks the navigator holds, and whether it has loaded them.
export interface TaskSwitcherSnapshot {
  rows?: TaskWithSection[];
  loaded?: boolean;
}

/**
 * A modal list of the active Tasks in most-recent-activity order.
 *
 * The Task navigator's order is the one a person arranged by hand, so it
 * cannot also answer "which Task moved last". This dialog is that second
 * order over the same Tasks the navigator already holds.
 *
 * The order is taken when the dialog opens and does not move while it is
 * open. Rows keep receiving status changes, because the reason to come here
 * is usually that something finished.
 */
@customElement("caffold-task-switcher-dialog")
export class CaffoldTaskSwitcherDialog extends CaffoldElement {
  static override styles = styles;

  private tasksLoaded = true;
  // Thread IDs in the order taken when the dialog opened.
  private order: string[] = [];
  private entries = new Map<string, TaskWithSection>();
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly modal = new DrawnRef<HTMLDialogElement>(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly items = new DrawnRefs<HTMLLIElement>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  /** Show the given Tasks, most recently finished first. */
  open({ rows = [], loaded = true }: TaskSwitcherSnapshot = {}) {
    const dialog = this.dialog;
    if (!dialog || dialog.open) {
      return false;
    }
    this.tasksLoaded = loaded;
    this.takeOrder(rows);
    this.draw();
    dialog.showModal();
    // A closed dialog keeps its scroll offset, and the Task that just finished
    // is the reason to open this one.
    (this.scrollport.value as HTMLDivElement).scrollTop = 0;
    return true;
  }

  close() {
    const dialog = this.dialog;
    if (!dialog?.open) {
      return false;
    }
    dialog.close();
    return true;
  }

  /**
   * Take a newer snapshot without disturbing the order this dialog is showing.
   *
   * A Task that left the snapshot leaves the list; the rest keep their row,
   * their place, and their Action Hint code. The one snapshot that may still
   * set the order is the first loaded one, because a dialog opened before the
   * Task list arrived has no order to protect yet.
   */
  updateTasks({ rows = [], loaded = true }: TaskSwitcherSnapshot = {}) {
    if (!this.dialog?.open) {
      return false;
    }
    const wasLoaded = this.tasksLoaded;
    this.tasksLoaded = loaded;
    if (!wasLoaded && loaded) {
      this.takeOrder(rows);
    } else {
      this.entries = byThread(rows);
      this.order = this.order.filter((threadId) => this.entries.has(threadId));
    }
    this.draw();
    return true;
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
      scroll: (pull) => this.surfaces.scope(pull),
    });
  }

  override render() {
    const rows = this.order.flatMap((threadId) => {
      const entry = this.entries.get(threadId);
      return entry ? [entry] : [];
    });
    const closeLabel = "Close task switcher";
    const closeIcon = inlineIcon("X", closeLabel, "task-switcher-close-icon");
    return html`
      <dialog
        ${drawn(this.modal)}
        ${this.keyboard.modal({ id: "task-switcher", sessionBound: true })}
        closedby="any"
        aria-labelledby="task-switcher-dialog-title"
        @caffold:keyboard-session-dismiss=${this.close}
      >
        <article class="task-switcher-card">
          <header class="task-switcher-header">
            <h2 id="task-switcher-dialog-title" class="task-switcher-title"
              >Switch task</h2
            >
            <form method="dialog" class="task-switcher-close-form">
              <button
                ${this.hints.button({
                  id: "close",
                  label: closeLabel,
                  action: ACTION_HINT_ACTION.DIALOG_BUTTON,
                })}
                type="submit"
                class="task-switcher-close"
                aria-label=${closeLabel}
                title=${closeLabel}
              >${closeIcon}</button>
            </form>
          </header>
          <div
            ${drawn(this.scrollport)}
            ${this.surfaces.surface({
              id: "tasks",
              label: () => "Recent tasks",
              clipRoots: () => [this.scrollport.value],
            })}
            class="task-switcher-scroll"
          >
            <ul class="task-switcher-list">${repeat(
              rows,
              ({ task }) => taskThreadId(task),
              (entry, index) => this.rowTemplate(entry, index === 0),
            )}</ul>
            <p class="task-switcher-empty" ?hidden=${rows.length > 0}>${
              this.tasksLoaded
                ? "No active tasks."
                : "Active tasks have not loaded."
            }</p>
          </div>
        </article>
        <caffold-keyboard-navigation-presentation
          ${this.keyboard.presentation()}
        ></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }

  // Close comes first in the dialog, so the newest Task has to claim the
  // focus the dialog hands out when it opens.
  private rowTemplate({ task, sectionName }: TaskWithSection, first: boolean) {
    const threadId = taskThreadId(task);
    const recovery = "recovery" in task;
    return html`<li
      ${drawn(this.items.of(threadId))}
      class="task-switcher-item"
      data-thread-id=${threadId}
      data-task-recovery=${recovery}
    >
      <button
        ${this.hints.button({
          id: encodeURIComponent(threadId),
          label: rowLabel(task.title, sectionName),
          action: ACTION_HINT_ACTION.TASK_SWITCH,
          owner: () => this.items.get(threadId),
          clipRoots: () => [this.scrollport.value],
        })}
        type="button"
        class="task-switcher-row"
        data-task-status=${taskStatusKey(task)}
        title=${task.title}
        aria-label=${rowLabel(task.title, sectionName)}
        ?autofocus=${first}
        @click=${() => this.select({ threadId, recovery })}
      >
        <span class="task-switcher-row-title">${task.title}</span>
        <span class="task-switcher-row-context" title=${sectionName}
          >${sectionName}</span
        >
        <span class="task-switcher-row-indicators">${rowMeta(task)}</span>
      </button>
    </li>`;
  }

  private select(detail: TaskSwitcherSelectDetail) {
    this.close();
    this.dispatchEvent(
      new CustomEvent<TaskSwitcherSelectDetail>(TASK_SWITCHER_SELECT_EVENT, {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private takeOrder(rows: TaskWithSection[]) {
    this.entries = byThread(rows);
    this.order = [...this.entries.values()]
      .sort(
        (left, right) =>
          taskCompletedMs(right.task) - taskCompletedMs(left.task),
      )
      .map(({ task }) => taskThreadId(task));
  }

  private get dialog() {
    return this.modal.value ?? null;
  }
}

function byThread(rows: TaskWithSection[]) {
  return new Map(
    rows
      .filter(({ task }) => taskThreadId(task))
      .map((entry) => [taskThreadId(entry.task), entry]),
  );
}

/**
 * When a Task last finished a turn.
 *
 * This is the one value the list is both ordered and labelled by, so the
 * column reads in order. A Task's recency is not it: a Claude session sets
 * its moved time to the moment it opens, so merely looking at a Task would
 * carry it to the top saying `now`.
 */
function taskCompletedMs(task: ListedTask) {
  const ms = Number(task.lastCompletedMs ?? task.recencyMs ?? task.updatedMs);
  return Number.isFinite(ms) ? ms : 0;
}

/** The Section is what tells two similarly named Tasks apart, so it is said. */
function rowLabel(title: string, sectionName: string) {
  return sectionName
    ? `Open task: ${title} in ${sectionName}`
    : `Open task: ${title}`;
}

/**
 * The one thing a row says about where its Task stands.
 *
 * This is the Task list's own cell: an unviewed completion outranks what the
 * Task is doing now, and a Task doing nothing says when it last finished.
 */
function rowMeta(task: ListedTask) {
  if (task.unseen) {
    return html`<span
      class="task-switcher-row-meta task-switcher-row-unseen"
      title="Completed - not viewed"
      aria-label="Completed - not viewed"
    ></span>`;
  }
  if (taskStatusView(task)) {
    return html`<caffold-task-status-chip
      class="task-switcher-row-meta task-switcher-row-status"
      .task=${task}
    ></caffold-task-status-chip>`;
  }
  const ms = taskCompletedMs(task);
  const date = new Date(ms);
  const age = formatRelativeAgePresentation(ms);
  return html`<time
    class="task-switcher-row-meta task-switcher-row-time"
    datetime=${Number.isNaN(date.getTime()) ? "" : date.toISOString()}
    aria-label=${age.label}
  >${age.text}</time>`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-switcher-dialog": CaffoldTaskSwitcherDialog;
  }

  interface HTMLElementEventMap {
    [TASK_SWITCHER_SELECT_EVENT]: CustomEvent<TaskSwitcherSelectDetail>;
  }
}
