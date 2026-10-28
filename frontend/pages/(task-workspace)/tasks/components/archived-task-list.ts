import { html, nothing, type TemplateResult } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import {
  type ActiveTask,
  type ActiveTaskTopPlacement,
  deleteTask,
  getArchivedTasks,
  restoreTask,
  type Task,
} from "#app/api.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import "#components/loading-text.js";
import {
  type TaskOperationsPresentation,
  taskStoreOperationsPresentation,
} from "../../task-store-status.js";
import {
  isTaskTransportStale,
  TASK_TRANSPORT_STATE,
  type TaskTransportState,
  taskStatusView,
} from "../runtime-state.js";
import { formatRelativeAgePresentation } from "../task-format.js";
import {
  groupTasksByRepository,
  mergeTaskListPage,
  sortTasksByRecency,
  type TaskRepositoryGroup,
  taskThreadId,
  taskWorktreeLabel,
  upsertTask,
} from "../task-list-model.js";
import "./task-status-chip.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import type { ArchivedTaskListIntent } from "../task-navigator-intent-event.js";
import { TASK_NAVIGATOR_INTENT_EVENT } from "../task-navigator-intent-event.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./archived-task-list.css.js";

export const ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT =
  "caffold:archived-task-list-initial-settled";
export const ARCHIVED_TASK_RESTORED_EVENT = "caffold:archived-task-restored";
export const ARCHIVED_TASK_LIST_STATE_EVENT =
  "caffold:archived-task-list-state";

// What the list says about itself with `ARCHIVED_TASK_LIST_STATE_EVENT`.
export interface ArchivedTaskListState {
  count: number;
  loaded: boolean;
  loading: boolean;
  error: string;
}

// A restored Task and where it goes at the top of the Active list.
export interface ArchivedTaskRestoredDetail {
  task: ActiveTask;
  activeTopPlacement: ActiveTaskTopPlacement;
}

/**
 * The Archived list: archived Tasks by repository, most recently active
 * first, a page at a time, each with Restore and Delete.
 *
 * It stays hidden until its navigator reveals it, once both lists have first
 * answered, so the two do not arrive one after the other.
 */
@customElement("caffold-archived-task-list")
export class CaffoldArchivedTaskList extends CaffoldElement {
  static override styles = [
    scopedStyle(
      busySpin,
      ".task-archived-action-button.is-loading > .task-archived-action-icon",
    ),
    scopedStyle(secondaryButton, ".task-secondary-button"),
    styles,
  ];

  private archivedTasks: Task[] = [];
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });
  private loading = false;
  private loadingMore = false;
  private loaded = false;
  private error: Error | null = null;
  private loadMoreError: Error | null = null;
  private nextCursor: string | null = null;
  private requestId = 0;
  private loadPromise: Promise<{
    tasks: Task[];
    nextCursor: string | null;
  } | null> | null = null;
  private settled = false;
  private revealed = false;
  private transportState: TaskTransportState = TASK_TRANSPORT_STATE.IDLE;
  private taskOperations = taskStoreOperationsPresentation(null);
  private readonly restoring = new Set<string>();
  private readonly restoreErrors = new Map<string, Error>();
  private readonly deleting = new Set<string>();
  private readonly deleteErrors = new Map<string, Error>();
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.draw();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.requestId += 1;
    this.loadPromise = null;
    this.loading = false;
    this.loadingMore = false;
  }

  // Whether the first load has answered, one way or the other.
  get initialRequestSettled() {
    return this.settled;
  }

  async activate({ force = false } = {}) {
    if (this.taskOperations.blocked) {
      return null;
    }
    return await this.loadArchived({ force });
  }

  setTaskOperations(presentation: TaskOperationsPresentation) {
    if (this.taskOperations.key === presentation.key) {
      return;
    }
    if (!this.taskOperations.blocked && presentation.blocked) {
      this.requestId += 1;
      this.loadPromise = null;
      this.loading = false;
      this.loadingMore = false;
    }
    this.taskOperations = presentation;
    this.draw();
  }

  setRevealed(revealed: boolean) {
    if (this.revealed === revealed) {
      return;
    }
    this.revealed = revealed;
    this.draw();
  }

  setTransportState(state: TaskTransportState | null | undefined) {
    const previous = this.transportState;
    this.transportState = state ?? TASK_TRANSPORT_STATE.IDLE;
    if (
      isTaskTransportStale(previous) !==
      isTaskTransportStale(this.transportState)
    ) {
      this.draw();
    }
  }

  acceptTask(task: Task) {
    if (!taskThreadId(task)) {
      return;
    }
    this.archivedTasks = upsertTask(this.archivedTasks, task);
    this.loaded = true;
    this.error = null;
    this.draw();
  }

  removeTask(threadId: string) {
    if (!threadId) {
      return;
    }
    const remaining = this.archivedTasks.filter(
      (candidate) => taskThreadId(candidate) !== threadId,
    );
    if (remaining.length === this.archivedTasks.length) {
      return;
    }
    this.archivedTasks = remaining;
    this.restoreErrors.delete(threadId);
    this.deleteErrors.delete(threadId);
    this.draw();
  }

  async restoreThread(threadId: string) {
    if (!threadId || !this.canChange(threadId)) {
      return null;
    }
    this.restoring.add(threadId);
    this.restoreErrors.delete(threadId);
    this.error = null;
    this.draw();
    try {
      const response = await restoreTask(threadId);
      const task = response?.task;
      if (!task) {
        throw new Error(
          "Restored Task response is missing its canonical Task.",
        );
      }
      this.archivedTasks = this.archivedTasks.filter(
        (candidate) => taskThreadId(candidate) !== threadId,
      );
      this.draw();
      this.dispatchEvent(
        new CustomEvent<ArchivedTaskRestoredDetail>(
          ARCHIVED_TASK_RESTORED_EVENT,
          {
            bubbles: true,
            detail: { task, activeTopPlacement: response.activeTopPlacement },
          },
        ),
      );
      return task;
    } catch (error) {
      const failure = asError(error);
      this.error = failure;
      this.restoreErrors.set(threadId, failure);
      return null;
    } finally {
      this.restoring.delete(threadId);
      this.draw();
    }
  }

  async deleteThread(threadId: string) {
    if (!threadId || !this.canChange(threadId)) {
      return null;
    }
    this.deleting.add(threadId);
    this.deleteErrors.delete(threadId);
    this.draw();
    try {
      const response = await deleteTask(threadId);
      this.removeTask(threadId);
      return response;
    } catch (error) {
      this.deleteErrors.set(threadId, asError(error));
      return null;
    } finally {
      this.deleting.delete(threadId);
      this.draw();
    }
  }

  async loadArchived({ force = false } = {}) {
    if (this.taskOperations.blocked) {
      return null;
    }
    if (this.loaded && !force) {
      return { tasks: this.archivedTasks, nextCursor: this.nextCursor };
    }
    if (this.loadPromise) {
      return await this.loadPromise;
    }
    const request = this.performLoad();
    this.loadPromise = request;
    try {
      return await request;
    } finally {
      if (this.loadPromise === request) {
        this.loadPromise = null;
      }
    }
  }

  listState(): ArchivedTaskListState {
    return {
      count: this.archivedTasks.length,
      loaded: this.loaded,
      loading: !this.taskOperations.blocked && (this.loading || !this.settled),
      error: this.error?.message ?? "",
    };
  }

  actionHintScope({
    scopeId = "task-list:archived",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  override render() {
    if (!this.revealed) {
      return nothing;
    }
    const tasks = sortTasksByRecency(this.archivedTasks);
    const blocked = this.taskOperations.blocked;
    let content: TemplateResult;
    if (blocked && !tasks.length) {
      content = html`<p class="task-section-message"
        >${this.taskOperations.message}</p
      >`;
    } else if (this.loading && !tasks.length) {
      content = html`<p class="task-section-message"
        ><caffold-loading-text>Loading...</caffold-loading-text></p
      >`;
    } else if (this.error && !tasks.length) {
      content = html`<div class="task-section-message" role="alert">
        <p>${this.error.message}</p>
        <button
          ${this.hints.button({
            id: "retry",
            label: "Retry",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          class="task-secondary-button"
          data-task-action="retry-archived-task-list"
          ?disabled=${blocked}
          @click=${this.retry}
        >Retry</button>
      </div>`;
    } else if (!tasks.length) {
      content = html`<p class="task-section-message"
        >No archived Caffold tasks.</p
      >`;
    } else {
      content = html`<ol
        class="task-repository-groups"
        data-task-section="archived"
      >${repeat(
        groupTasksByRepository(tasks),
        (group) => group.key,
        (group) => this.groupTemplate(group),
      )}</ol>`;
    }
    return html`
      <header class="task-list-section-header">
        <h2>Archived</h2>
        <span class="task-list-section-count">${tasks.length}</span>
      </header>
      ${content}
      ${this.paginationTemplate()}
    `;
  }

  // The host is a region only while revealed; `hidden` says which it is now.
  override updated() {
    const revealed = this.revealed;
    if (this.hidden !== revealed) {
      return;
    }
    this.hidden = !revealed;
    this.classList.toggle("task-list-section", revealed);
    if (revealed) {
      this.dataset.taskSection = "archived";
      this.setAttribute("role", "region");
      this.setAttribute("aria-label", "Archived Caffold Tasks");
    } else {
      delete this.dataset.taskSection;
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
    this.dispatchEvent(
      new CustomEvent<ArchivedTaskListState>(ARCHIVED_TASK_LIST_STATE_EVENT, {
        bubbles: true,
        detail: this.listState(),
      }),
    );
  }

  private groupTemplate(group: TaskRepositoryGroup) {
    const [icon, label] = group.repository
      ? ["FolderGit2", "Git repository"]
      : ["Folder", "Directory"];
    return html`<li
      class="task-repository-group"
      data-task-repository-key=${group.key}
    >
      <div class="task-repository-header" title=${group.rootPath}>
        ${inlineIcon(icon, label, "task-repository-icon")}
        <span class="task-repository-label">${group.label}</span>
        <span class="task-repository-count">${group.tasks.length}</span>
      </div>
      <ol class="task-list">${repeat(
        group.tasks,
        (task) => taskThreadId(task),
        (task) => this.rowTemplate(task, group.key),
      )}</ol>
    </li>`;
  }

  private rowTemplate(task: Task, repositoryKey: string) {
    const threadId = taskThreadId(task);
    const restoring = this.restoring.has(threadId);
    const deleting = this.deleting.has(threadId);
    const disabled =
      restoring ||
      deleting ||
      isTaskTransportStale(this.transportState) ||
      this.taskOperations.blocked;
    const restoreError = this.restoreErrors.get(threadId);
    const deleteError = this.deleteErrors.get(threadId);
    const restoreLabel = restoring
      ? `Restoring ${task.title}`
      : restoreError
        ? `Retry restoring ${task.title}`
        : `Restore ${task.title}`;
    const deleteLabel = deleting
      ? `Deleting ${task.title}`
      : deleteError
        ? `Retry deleting ${task.title}`
        : `Delete ${task.title}`;
    const unavailable = "Conversation unavailable; restore is not available";
    const restore =
      task.conversationAvailable !== false
        ? html`<button
            ${this.hints.button({
              id: `restore-archived-task:${threadId}`,
              label: restoreLabel,
              action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            })}
            type="button"
            class="task-archived-action-button${restoring ? " is-loading" : ""}"
            data-task-action="restore-archived-task"
            data-thread-id=${threadId}
            aria-label=${restoreLabel}
            title=${
              restoring
                ? "Restoring task"
                : (restoreError?.message ?? "Restore task")
            }
            ?disabled=${disabled}
            @click=${(event: Event) => this.requestRestore(event, threadId)}
          >${inlineIcon(
            restoring ? "LoaderCircle" : "ArchiveRestore",
            restoreLabel,
            "task-archived-action-icon",
          )}</button>`
        : html`<span
            class="task-archived-unavailable-status"
            role="img"
            aria-label=${unavailable}
            title=${unavailable}
          >${inlineIcon(
            "TriangleAlert",
            unavailable,
            "task-archived-unavailable-icon",
          )}</span>`;
    const failure = deleteError ?? restoreError;
    return html`<li
      class="task-archived-row"
      data-thread-id=${threadId}
      data-task-list-key=${repositoryKey}
    >
      <div class="task-archived-copy" title=${task.title}>
        <span class="task-row-title">${task.title}</span>
        <span class="task-row-indicators">${
          task.worktree?.linked
            ? html`<span
                class="task-row-worktree"
                title=${taskWorktreeLabel(task)}
              >${inlineIcon(
                "GitBranch",
                "Linked worktree retained",
                "task-row-worktree-icon",
              )}</span>`
            : nothing
        }${rowMeta(task)}</span>
      </div>
      <div class="task-archived-actions">
        ${restore}
        <button
          ${this.hints.button({
            id: `delete-archived-task:${threadId}`,
            label: deleteLabel,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          class="task-archived-action-button task-delete-button${
            deleting ? " is-loading" : ""
          }"
          data-task-action="delete-archived-task"
          data-thread-id=${threadId}
          aria-label=${deleteLabel}
          title=${
            deleting
              ? "Deleting task"
              : (deleteError?.message ?? "Permanently delete task")
          }
          ?disabled=${disabled}
          @click=${(event: Event) => this.requestDelete(event, task)}
        >${inlineIcon(
          deleting ? "LoaderCircle" : "Trash2",
          deleteLabel,
          "task-archived-action-icon",
        )}</button>
      </div>
      ${
        failure
          ? html`<p class="task-archived-action-error" role="alert"
            >${failure.message}</p
          >`
          : nothing
      }
    </li>`;
  }

  private paginationTemplate() {
    if (!this.nextCursor && !this.loadingMore && !this.loadMoreError) {
      return nothing;
    }
    const label = this.loadingMore
      ? "Loading more archived tasks..."
      : this.loadMoreError
        ? "Retry loading more archived tasks"
        : "Load more archived tasks";
    return html`<div class="task-list-pagination">
      ${
        this.loadMoreError
          ? html`<p class="task-list-pagination-error"
            >${this.loadMoreError.message}</p
          >`
          : nothing
      }
      <button
        ${this.hints.button({
          id: "load-more",
          label,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-secondary-button"
        data-task-action="load-more-archived-tasks"
        ?disabled=${this.loadingMore || this.taskOperations.blocked}
        @click=${this.loadMore}
      >${label}</button>
    </div>`;
  }

  // A Task can change only while the list can reach the server and nothing
  // else is changing it.
  private canChange(threadId: string) {
    return (
      !this.restoring.has(threadId) &&
      !this.deleting.has(threadId) &&
      !isTaskTransportStale(this.transportState) &&
      !this.taskOperations.blocked
    );
  }

  private requestRestore(event: Event, threadId: string) {
    event.stopPropagation();
    if (!this.taskOperations.blocked) {
      void this.restoreThread(threadId);
    }
  }

  private requestDelete(event: Event, task: Task) {
    event.stopPropagation();
    if (this.taskOperations.blocked) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ArchivedTaskListIntent>(TASK_NAVIGATOR_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { type: "delete-archived-task", task },
      }),
    );
  }

  private retry(event: Event) {
    event.stopPropagation();
    if (!this.taskOperations.blocked) {
      void this.loadArchived({ force: true });
    }
  }

  private loadMore(event: Event) {
    event.stopPropagation();
    if (!this.taskOperations.blocked) {
      void this.loadMoreArchived();
    }
  }

  private async performLoad() {
    const requestId = ++this.requestId;
    this.loading = true;
    this.loadingMore = false;
    this.error = null;
    this.loadMoreError = null;
    this.draw();
    try {
      const response = await getArchivedTasks();
      if (requestId !== this.requestId) {
        return null;
      }
      this.archivedTasks = response.tasks ?? [];
      this.nextCursor = response.nextCursor ?? null;
      this.loading = false;
      this.loaded = true;
      this.settle();
      return response;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loading = false;
      this.error = asError(error);
      this.archivedTasks = [];
      this.loaded = false;
      this.settle();
      return null;
    }
  }

  private async loadMoreArchived() {
    const cursor = this.nextCursor;
    if (
      this.taskOperations.blocked ||
      !cursor ||
      this.loading ||
      this.loadingMore
    ) {
      return null;
    }
    const requestId = ++this.requestId;
    this.loadingMore = true;
    this.loadMoreError = null;
    this.draw();
    try {
      const response = await getArchivedTasks(cursor);
      if (requestId !== this.requestId) {
        return null;
      }
      this.archivedTasks = mergeTaskListPage(
        this.archivedTasks,
        response.tasks ?? [],
      );
      this.nextCursor = response.nextCursor ?? null;
      this.loadingMore = false;
      this.draw();
      return response;
    } catch (error) {
      if (requestId !== this.requestId) {
        return null;
      }
      this.loadingMore = false;
      this.loadMoreError = asError(error);
      this.draw();
      return null;
    }
  }

  // The first answer, either way, is announced once after drawing it.
  private settle() {
    const first = !this.settled;
    this.settled = true;
    this.draw();
    if (first) {
      this.dispatchEvent(
        new CustomEvent(ARCHIVED_TASK_LIST_INITIAL_SETTLED_EVENT, {
          bubbles: true,
        }),
      );
    }
  }
}

// The one thing a row says beside its title: what the agent is doing, or
// when it last finished.
function rowMeta(task: Task) {
  if (taskStatusView(task)) {
    return html`<caffold-task-status-chip
      class="task-row-meta"
      .task=${task}
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

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-archived-task-list": CaffoldArchivedTaskList;
  }

  interface HTMLElementEventMap {
    [ARCHIVED_TASK_LIST_STATE_EVENT]: CustomEvent<ArchivedTaskListState>;
    [ARCHIVED_TASK_RESTORED_EVENT]: CustomEvent<ArchivedTaskRestoredDetail>;
  }
}
