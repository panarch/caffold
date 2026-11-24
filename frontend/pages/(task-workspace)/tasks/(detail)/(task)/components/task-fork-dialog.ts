import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import {
  type CreatedTask,
  forkTask,
  type TaskResponseError,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  type ScrollSurfacePull,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type {
  CaffoldTaskDirectoryField,
  DirectoryChosenDetail,
} from "#tasks/components/directory-field.js";
import "#tasks/components/directory-field.js";
import type { ServerPaths } from "#tasks/components/directory-path.js";
import type { TaskCreatedHandoff } from "#tasks/layout.js";
import { taskDetailThreadId } from "#tasks/task-list-model.js";

import styles from "./task-fork-dialog.css.js";

// The Task to fork: the folder its new Task starts in unless another is
// chosen, whether it works in a worktree, and how the server names paths.
export interface TaskForkSource {
  taskId: string;
  folder: string;
  worktree: boolean;
  server: ServerPaths;
}

// A fork that failed, for the Task screen to tell whether the Task is gone.
export interface TaskForkFailedDetail {
  taskId: string;
  error: Error;
}

type State =
  | { phase: "closed" }
  | {
      phase: "choosing" | "forking";
      source: TaskForkSource;
      folder: string;
      error: Error | null;
    };

type Phase = State["phase"];

// Every allowed phase change. Choosing replaces itself when it is opened
// again or a folder is chosen; forking returns to choosing with its failure.
const EDGES: Readonly<Record<Phase, readonly Phase[]>> = Object.freeze({
  closed: ["choosing"],
  choosing: ["choosing", "forking", "closed"],
  forking: ["choosing", "closed"],
});

/**
 * Forks a Task into a folder the person chooses. The folder list stays open
 * so the dialog keeps one size while the person browses or types a path.
 *
 * Closed accepts open; choosing accepts a chosen folder, the fork, and
 * dismissal; forking accepts its completion or failure and holds dismissal.
 * Deactivation closes from any phase, and a request generation drops a
 * completion that arrives after it. A created child is kept, so a retry opens
 * that child instead of forking again.
 */
@customElement("caffold-task-fork-dialog")
export class CaffoldTaskForkDialog extends CaffoldElement {
  static override styles = styles;

  private state: State = { phase: "closed" };
  private generation = 0;
  private opener: HTMLElement | null = null;
  private created: CreatedTask | null = null;
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly field = new DrawnRef<CaffoldTaskDirectoryField>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);

  open(source: TaskForkSource, opener?: Element | null) {
    if (this.state.phase === "forking") {
      return;
    }
    this.generation += 1;
    this.created = null;
    this.opener = opener instanceof HTMLElement ? opener : null;
    this.transition({
      phase: "choosing",
      source,
      folder: source.folder,
      error: null,
    });
    this.performUpdate();
    this.syncField();
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
  }

  deactivate() {
    this.generation += 1;
    this.created = null;
    this.field.value?.deactivate();
    if (this.state.phase !== "closed") {
      this.transition({ phase: "closed" });
    }
    this.opener = null;
    this.dialog.value?.close();
  }

  override disconnectedCallback() {
    this.deactivate();
    super.disconnectedCallback();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    const body = this.body.value;
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.field.value?.actionHintScope({
        ...pull,
        scopeId: `${pull.scopeId ?? ""}:folder`,
        clipRoots: [...(pull.clipRoots ?? []), ...(body ? [body] : [])],
      }),
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return (
      this.field.value?.scrollSurfaceScope({
        ...pull,
        scopeId: `${pull.scopeId ?? ""}:folder`,
      }) ?? emptyScrollSurfaceScope()
    );
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.actionHintScope(pull),
      scroll: (pull) => this.scrollSurfaceScope(pull),
    });
  }

  override render() {
    const state = this.state;
    const open = state.phase !== "closed";
    const forking = state.phase === "forking";
    const source = open ? state.source : null;
    const error = open ? state.error : null;
    const createdTaskId = (error as TaskResponseError | null)?.createdTaskId;
    let forkLabel = "Fork task";
    if (forking) {
      forkLabel = "Forking…";
    } else if (this.created) {
      forkLabel = "Open forked task";
    }
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: `task-fork:${source?.taskId ?? ""}`,
        when: open,
      })}
      closedby=${forking ? "none" : "any"}
      aria-labelledby="task-fork-title"
      aria-describedby="task-fork-description"
      aria-busy=${forking ? "true" : "false"}
      @cancel=${this.handleCancel}
      @close=${this.handleClose}
    >
      <form @submit=${this.submit}>
        <header><h2 id="task-fork-title">Fork task</h2></header>
        <div class="body" ${drawn(this.body)}>
          <div id="task-fork-description" class="description">
            <p>Copies this Task's conversation into a new Task in the folder you choose.</p>
            <p>${
              source?.worktree
                ? "The new Task won't have the changes in this Task's worktree."
                : "Files are not copied."
            }</p>
          </div>
          <div class="folder">
            <span id="task-fork-folder-label">Folder</span>
            <caffold-task-directory-field
              ${drawn(this.field)}
              aria-labelledby="task-fork-folder-label"
              ?inert=${forking}
              @caffold:task-directory-chosen=${this.folderChosen}
            ></caffold-task-directory-field>
          </div>
          ${error ? html`<p class="error" role="alert">${error.message}</p>` : nothing}
          ${
            createdTaskId
              ? html`<a
                  ${this.hints.link({
                    id: "open-created",
                    label: "Open forked task",
                    action: ACTION_HINT_ACTION.LINK_OPEN,
                  })}
                  href=${`/tasks/${encodeURIComponent(createdTaskId)}`}
                >Open forked task</a>`
              : nothing
          }
        </div>
        <footer>
          <button
            ${this.hints.button({
              id: "cancel",
              label: "Cancel",
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="button"
            ?disabled=${forking}
            @click=${this.cancel}
          >Cancel</button>
          <button
            ${this.hints.button({
              id: "fork",
              label: forkLabel,
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="submit"
            class="primary"
            data-task-fork-action="fork"
            ?disabled=${forking || Boolean(createdTaskId)}
          >${forkLabel}</button>
        </footer>
      </form>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private transition(next: State) {
    const from = this.state.phase;
    if (!EDGES[from].includes(next.phase)) {
      throw new Error(
        `Invalid fork dialog transition: ${from} -> ${next.phase}`,
      );
    }
    this.state = next;
    this.requestUpdate();
  }

  // The field shows the chosen folder; its list stays open while the dialog
  // is.
  private syncField() {
    const state = this.state;
    if (state.phase === "closed") {
      return;
    }
    this.field.value?.setContext({
      path: state.folder,
      server: state.source.server,
      keepListOpen: true,
    });
  }

  private folderChosen(event: CustomEvent<DirectoryChosenDetail>) {
    event.stopPropagation();
    const state = this.state;
    if (state.phase !== "choosing" || this.created) {
      return;
    }
    this.transition({ ...state, folder: event.detail.path, error: null });
    this.syncField();
  }

  private submit(event: Event) {
    event.preventDefault();
    void this.fork();
  }

  private async fork() {
    const state = this.state;
    if (
      state.phase !== "choosing" ||
      (state.error as TaskResponseError | null)?.createdTaskId
    ) {
      return;
    }
    const { source, folder } = state;
    const generation = this.generation;
    this.transition({ phase: "forking", source, folder, error: null });
    try {
      const created =
        this.created ?? (await forkTask(source.taskId, { cwd: folder }));
      if (generation !== this.generation || !this.isConnected) {
        return;
      }
      const childId = taskDetailThreadId(created?.detail);
      if (!childId || childId === source.taskId || !created.detail.task) {
        throw new Error("The agent did not return a distinct forked Task.");
      }
      this.created = created;
      const handoff: TaskCreatedHandoff = {
        created,
        submission: null,
        adopted: false,
      };
      this.dispatchEvent(
        new CustomEvent<TaskCreatedHandoff>("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted) {
        throw new Error(
          "The forked Task was created but could not be opened. Retry to open the same Task.",
        );
      }
      if (generation !== this.generation) {
        return;
      }
      this.transition({ phase: "closed" });
      this.dialog.value?.close("forked");
    } catch (failure) {
      if (generation !== this.generation || !this.isConnected) {
        return;
      }
      const error =
        failure instanceof Error ? failure : new Error(String(failure));
      if (!this.created && !(error as TaskResponseError).status) {
        error.message +=
          " The fork result is unknown. Check the Task list before retrying.";
      }
      this.transition({ phase: "choosing", source, folder, error });
      this.dispatchEvent(
        new CustomEvent<TaskForkFailedDetail>("caffold:task-fork-failed", {
          bubbles: true,
          detail: { taskId: source.taskId, error },
        }),
      );
    }
  }

  private cancel() {
    if (this.state.phase !== "forking") {
      this.dialog.value?.close("cancel");
    }
  }

  // A fork under way cannot be dismissed.
  private handleCancel(event: Event) {
    if (this.state.phase === "forking") {
      event.preventDefault();
    }
  }

  private handleClose() {
    if (this.state.phase === "forking") {
      return;
    }
    this.generation += 1;
    this.created = null;
    this.field.value?.deactivate();
    if (this.state.phase !== "closed") {
      this.transition({ phase: "closed" });
    }
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) {
      opener.focus();
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-fork-dialog": CaffoldTaskForkDialog;
  }

  interface HTMLElementEventMap {
    "caffold:task-fork-failed": CustomEvent<TaskForkFailedDetail>;
  }
}
