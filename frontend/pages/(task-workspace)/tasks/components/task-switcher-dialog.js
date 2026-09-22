import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
} from "../../../../action-hints.js";
import { escapeHtml } from "../../../../components/dom.js";
import {
  KEYBOARD_SESSION_DISMISS_EVENT,
  keyboardNavigationContext,
} from "../../../../keyboard-navigation.js";
import "../../../../keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";
import { formatRelativeAgePresentation } from "../task-format.js";
import { taskThreadId } from "../task-list-model.js";
import { taskStatusKey } from "../runtime-state.js";
import { patchTaskStatusChip, renderTaskStatusChip } from "./task-status.js";

export const TASK_SWITCHER_SELECT_EVENT = "caffold:task-switcher-select";

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
class CaffoldTaskSwitcherDialog extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    this.addEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
  }

  disconnectedCallback() {
    this.removeEventListener(KEYBOARD_SESSION_DISMISS_EVENT, this.boundDismiss);
  }

  /** Show the given Tasks, most recently finished first. */
  open({ rows = [], loaded = true } = {}) {
    this.ensureRendered();
    const dialog = this.dialogElement();
    if (dialog.open) {
      return false;
    }
    this.tasksLoaded = Boolean(loaded);
    this.renderRows(byCompletion(rows));
    dialog.showModal();
    // A closed dialog keeps its scroll offset, and the Task that just finished
    // is the reason to open this one.
    this.scrollport().scrollTop = 0;
    return true;
  }

  close() {
    const dialog = this.dialogElement();
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
  updateTasks({ rows = [], loaded = true } = {}) {
    const dialog = this.dialogElement();
    if (!dialog?.open) {
      return false;
    }
    const wasLoaded = this.tasksLoaded;
    this.tasksLoaded = Boolean(loaded);
    if (!wasLoaded && this.tasksLoaded) {
      this.renderRows(byCompletion(rows));
      return true;
    }
    const rowsByThreadId = new Map(
      rows
        .filter(({ task }) => taskThreadId(task))
        .map((entry) => [taskThreadId(entry.task), entry]),
    );
    for (const element of [...this.list().children]) {
      const entry = rowsByThreadId.get(`${element.dataset.threadId ?? ""}`);
      if (entry) {
        this.patchRow(element, entry);
      } else {
        element.remove();
      }
    }
    this.syncEmptyState();
    return true;
  }

  keyboardNavigationContexts() {
    this.ensureRendered();
    const dialog = this.dialogElement();
    const presentation = dialog.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    const selector = presentation?.scrollSurfaceSelector?.();
    if (!hintDialog || !hud || !selector) {
      return [];
    }
    return [keyboardNavigationContext({
      id: "task-switcher",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
        sessionBound: true,
      },
      scroll: {
        hud,
        selector,
        scope: this.scrollSurfaceScope(),
      },
    })];
  }

  actionHintScope() {
    this.ensureRendered();
    const dialog = this.dialogElement();
    const scrollport = this.scrollport();
    return {
      blocked: false,
      targets: [...this.list().children].flatMap((row) => {
        const threadId = `${row.dataset.threadId ?? ""}`;
        const control = rowControl(row);
        if (!threadId || !control) {
          return [];
        }
        return [buttonActionHintTarget({
          invalidationOwner: row,
          id: `task-switcher:${encodeURIComponent(threadId)}`,
          actionId: ACTION_HINT_ACTION.TASK_SWITCH,
          label: control.getAttribute("aria-label") || `Open task: ${threadId}`,
          control,
          clipRoots: [dialog, scrollport].filter(Boolean),
          isActionable: () =>
            this.isConnected &&
            dialog.open &&
            row.isConnected &&
            rowControl(row) === control &&
            !control.disabled,
        })];
      }),
      mutationRoots: [this],
      scrollRoots: [scrollport].filter(Boolean),
    };
  }

  scrollSurfaceScope() {
    this.ensureRendered();
    const dialog = this.dialogElement();
    const scrollport = this.scrollport();
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: "task-switcher:tasks",
        label: "Recent tasks",
        scrollport,
        clipRoots: [dialog, scrollport],
        isEligible: () =>
          this.isConnected &&
          dialog.open &&
          this.scrollport() === scrollport &&
          hasScrollLayoutBox(dialog) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.boundDismiss = (event) => this.handleDismiss(event);
    this.innerHTML = `
      <dialog closedby="any" aria-labelledby="task-switcher-dialog-title">
        <div class="task-switcher-card">
          <h2 id="task-switcher-dialog-title">Switch task</h2>
          <div class="task-switcher-scroll">
            <ul class="task-switcher-list"></ul>
            <p class="task-switcher-empty" hidden></p>
          </div>
        </div>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
    this.dialogElement().addEventListener("click", (event) =>
      this.handleClick(event));
  }

  handleClick(event) {
    const control = event.target instanceof Element
      ? event.target.closest(".task-switcher-row")
      : null;
    const row = control?.closest(".task-switcher-item");
    if (!control || !row || !this.contains(control)) {
      return;
    }
    const threadId = `${row.dataset.threadId ?? ""}`;
    if (!threadId) {
      return;
    }
    this.close();
    this.dispatchEvent(
      new CustomEvent(TASK_SWITCHER_SELECT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { threadId, recovery: row.dataset.taskRecovery === "true" },
      }),
    );
  }

  handleDismiss(event) {
    if (event.target === this.dialogElement()) {
      this.close();
    }
  }

  renderRows(tasks) {
    this.list().innerHTML = tasks.map(renderRow).join("");
    this.syncEmptyState();
  }

  patchRow(row, { task, sectionName = "" }) {
    const control = rowControl(row);
    if (!control) {
      return;
    }
    const title = `${task?.title ?? ""}`;
    const context = `${sectionName}`;
    syncAttribute(row, "data-task-recovery", `${Boolean(task?.recovery)}`);
    syncAttribute(control, "data-task-status", taskStatusKey(task));
    syncAttribute(control, "title", title);
    syncAttribute(control, "aria-label", rowLabel(title, context));
    syncText(row.querySelector(".task-switcher-row-title"), title);
    const contextElement = row.querySelector(".task-switcher-row-context");
    syncText(contextElement, context);
    syncAttribute(contextElement, "title", context);
    this.patchIndicators(
      row.querySelector(".task-switcher-row-indicators"),
      task,
    );
  }

  patchIndicators(indicators, task) {
    if (!indicators) {
      return;
    }
    const staging = document.createElement("span");
    staging.innerHTML = renderRowIndicators(task);
    const currentChip = indicators.querySelector(":scope > .task-status-chip");
    const nextChip = staging.querySelector(":scope > .task-status-chip");
    if (currentChip && nextChip) {
      patchTaskStatusChip(currentChip, nextChip);
    }
    if (indicators.innerHTML === staging.innerHTML) {
      return;
    }
    indicators.replaceChildren(...staging.childNodes);
  }

  syncEmptyState() {
    const empty = this.querySelector(":scope .task-switcher-empty");
    const hidden = this.list().childElementCount > 0;
    if (empty.hidden !== hidden) {
      empty.hidden = hidden;
    }
    syncText(
      empty,
      this.tasksLoaded ? "No active tasks." : "Active tasks have not loaded.",
    );
  }

  dialogElement() {
    this.ensureRendered();
    return this.querySelector(":scope > dialog");
  }

  list() {
    return this.querySelector(":scope .task-switcher-list");
  }

  scrollport() {
    return this.querySelector(":scope .task-switcher-scroll");
  }
}

function renderRow({ task, sectionName = "" }) {
  const threadId = taskThreadId(task);
  const title = `${task?.title ?? ""}`;
  const context = `${sectionName}`;
  const recovery = Boolean(task?.recovery);
  return `
    <li class="task-switcher-item" data-thread-id="${escapeHtml(threadId)}" data-task-recovery="${recovery}">
      <button
        type="button"
        class="task-switcher-row"
        data-task-status="${escapeHtml(taskStatusKey(task))}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(rowLabel(title, context))}"
      >
        <span class="task-switcher-row-title">${escapeHtml(title)}</span>
        <span class="task-switcher-row-context" title="${escapeHtml(context)}">${escapeHtml(context)}</span>
        <span class="task-switcher-row-indicators">${renderRowIndicators(task)}</span>
      </button>
    </li>
  `;
}

/**
 * When a Task last finished a turn.
 *
 * This is the one value the list is both ordered and labelled by, so the
 * column reads in order. A Task's recency is not it: a Claude session sets
 * its moved time to the moment it opens, so merely looking at a Task would
 * carry it to the top saying `now`.
 */
function taskCompletedMs(task) {
  const ms = Number(
    task?.lastCompletedMs ?? task?.recencyMs ?? task?.updatedMs ?? 0,
  );
  return Number.isFinite(ms) ? ms : 0;
}

function byCompletion(rows) {
  return [...rows].sort(
    (left, right) => taskCompletedMs(right.task) - taskCompletedMs(left.task),
  );
}

/** The Section is what tells two similarly named Tasks apart, so it is said. */
function rowLabel(title, sectionName) {
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
function renderRowIndicators(task) {
  if (task?.unseen) {
    return `<span class="task-switcher-row-meta task-switcher-row-unseen" title="Completed - not viewed" aria-label="Completed - not viewed"></span>`;
  }
  const status = renderTaskStatusChip(
    task,
    "task-switcher-row-meta task-switcher-row-status",
    { label: false },
  );
  if (status) {
    return status;
  }
  const ms = taskCompletedMs(task);
  const date = new Date(Number(ms));
  const dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
  const age = formatRelativeAgePresentation(ms);
  return `<time class="task-switcher-row-meta task-switcher-row-time" datetime="${escapeHtml(dateTime)}" aria-label="${escapeHtml(age.label)}">${escapeHtml(age.text)}</time>`;
}

function rowControl(row) {
  return row?.querySelector(":scope > .task-switcher-row") ?? null;
}

function syncText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

function syncAttribute(element, name, value) {
  if (element && element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

if (!customElements.get("caffold-task-switcher-dialog")) {
  customElements.define(
    "caffold-task-switcher-dialog",
    CaffoldTaskSwitcherDialog,
  );
}
