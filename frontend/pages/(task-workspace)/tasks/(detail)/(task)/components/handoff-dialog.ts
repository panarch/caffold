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
  handoffTask,
  type TaskResponseError,
} from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  KeyboardContexts,
  mergeKeyboardNavigationContexts,
} from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import type { TaskCreatedHandoff } from "#tasks/layout.js";
import "#tasks/components/task-turn-options.js";
import type { CaffoldTaskTurnOptions } from "#tasks/components/task-turn-options.js";

import styles from "./handoff-dialog.css.js";

interface Source {
  taskId: string;
  cwd: string;
  managed: boolean;
  targetProvider: string;
}
type State =
  | { phase: "closed" }
  | { phase: "choosing" | "creating"; source: Source; error: Error | null };

/** Closed accepts open, choosing accepts replacement/open or submit, and
 * creating accepts completion/failure. Success and deactivation may close from
 * any phase; user dismissal is held while creating. Request generations reject
 * completion after deactivation, replacement or disconnect. Provider work and
 * the created Task's first submission remain with their existing owners.
 */
@customElement("caffold-task-handoff-dialog")
export class CaffoldTaskHandoffDialog extends CaffoldElement {
  static override styles = styles;
  private state: State = { phase: "closed" };
  private generation = 0;
  private ready = false;
  private opener: HTMLElement | null = null;
  private created: (CreatedTask & { prompt: string }) | null = null;
  private createdOptions: ReturnType<
    CaffoldTaskTurnOptions["submissionOptions"]
  > | null = null;
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly options = new DrawnRef<CaffoldTaskTurnOptions>(this);
  private readonly hints = new ActionHints(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);

  async open(source: Source, opener?: HTMLElement | null) {
    if (this.state.phase === "creating") return;
    this.generation += 1;
    this.created = null;
    this.createdOptions = null;
    this.ready = false;
    this.opener = opener ?? null;
    this.transition({ phase: "choosing", source, error: null });
    await this.updateComplete;
    if (this.state.phase !== "choosing" || this.state.source !== source) return;
    this.options.value?.reset({
      cwd: source.cwd,
      initialSelection: { provider: source.targetProvider },
      placement: "below",
    });
    this.dialog.value?.showModal();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.options.value?.actionHintScope(pull),
    );
  }

  keyboardNavigationContexts() {
    const own = this.keyboard.contexts({
      actionHints: (pull) => this.actionHintScope(pull),
      scroll: (pull) => this.scrollSurfaceScope(pull),
    });
    return mergeKeyboardNavigationContexts(
      own,
      ...own.map(
        ({ id }) =>
          this.options.value?.keyboardNavigationContexts({ scopeId: id }) ?? [],
      ),
    );
  }

  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.surfaces.scope(pull);
  }

  deactivate() {
    this.generation += 1;
    this.options.value?.hidePopovers();
    this.transition({ phase: "closed" });
    this.dialog.value?.close();
    this.opener = null;
  }

  override disconnectedCallback() {
    this.deactivate();
    super.disconnectedCallback();
  }

  override render() {
    const state = this.state;
    const pending = state.phase === "creating";
    const source = state.phase !== "closed" ? state.source : null;
    const error = state.phase !== "closed" ? state.error : null;
    const createdTaskId = (error as TaskResponseError | null)?.createdTaskId;
    return html`<dialog ${drawn(this.dialog)} ${this.keyboard.modal({ id: "task-handoff", when: Boolean(source) })}
      aria-labelledby="handoff-title" aria-describedby="handoff-description" aria-busy=${pending ? "true" : "false"}
      @cancel=${(event: Event) => {
        if (pending) event.preventDefault();
      }} @close=${this.closed}>
      <form @submit=${this.submit}>
        <header><h2 id="handoff-title">Continue with another agent</h2></header>
        <div class="body" ${drawn(this.body)} ${this.surfaces.surface({ id: "setup", label: () => "Agent handoff setup", clipRoots: () => [this.body.value] })}>
          <p id="handoff-description">The selected model reads the previous Task's history and current files, summarizes the situation, and waits for your next request. Only the selected model runs the preparation turn.</p>
          <p class="path">Working directory: ${source?.cwd}</p>
          <p>${source?.managed ? "This worktree moves to the new Task. The previous Task remains available for reading its history." : "The new Task uses this directory. The previous Task remains usable."}</p>
          <caffold-task-turn-options ${drawn(this.options)} ?hidden=${!source} @caffold:task-turn-options-change=${this.optionsChanged}></caffold-task-turn-options>
          ${error ? html`<p class="error" role="alert">${error.message}</p>` : nothing}
          ${createdTaskId ? html`<a ${this.hints.link({ id: "open-created", label: "Open created Task", action: ACTION_HINT_ACTION.LINK_OPEN })} href=${`/tasks/${encodeURIComponent(createdTaskId)}`}>Open created Task</a>` : nothing}
        </div>
        <footer>
          <button type="button" ?disabled=${pending} @click=${() => this.dialog.value?.close()}
            ${this.hints.button({ id: "cancel", label: "Cancel", action: ACTION_HINT_ACTION.DIALOG_BUTTON })}>Cancel</button>
          <button type="submit" class="primary" ?disabled=${pending || (!this.created && !this.ready) || Boolean(createdTaskId)}
            ${this.hints.button({ id: "continue", label: "Continue with selected agent", action: ACTION_HINT_ACTION.DIALOG_BUTTON })}
          >${pending ? "Preparing..." : this.created ? "Open continued Task" : "Continue with selected agent"}</button>
        </footer>
      </form>
      <caffold-keyboard-navigation-presentation ${this.keyboard.presentation()}></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private transition(next: State) {
    const from = this.state.phase;
    const to = next.phase;
    const edges = {
      closed: ["closed", "choosing"],
      choosing: ["choosing", "creating", "closed"],
      creating: ["choosing", "closed"],
    };
    const allowed = edges[from].includes(to);
    if (!allowed)
      throw new Error(`Invalid handoff dialog transition: ${from} -> ${to}`);
    this.state = next;
    this.requestUpdate();
  }

  private optionsChanged() {
    this.ready = this.options.value?.readyForSubmission() ?? false;
    this.requestUpdate();
  }

  private submit(event: Event) {
    event.preventDefault();
    void this.start();
  }

  private async start() {
    if (
      this.state.phase !== "choosing" ||
      (!this.created && !this.ready) ||
      !this.options.value
    )
      return;
    const source = this.state.source;
    const generation = this.generation;
    const options =
      this.createdOptions ?? this.options.value.submissionOptions();
    this.transition({ phase: "creating", source, error: null });
    this.options.value.setContext({
      cwd: source.cwd,
      locked: true,
      placement: "below",
    });
    try {
      const created =
        this.created ?? (await handoffTask(source.taskId, options));
      if (generation !== this.generation || !this.isConnected) return;
      this.created = created;
      this.createdOptions = options;
      const handoff: TaskCreatedHandoff = {
        created,
        submission: {
          submissionId: `handoff:${created.activeTask.threadId}`,
          prompt: created.prompt,
          attachments: [],
          options,
        },
        adopted: false,
      };
      this.dispatchEvent(
        new CustomEvent<TaskCreatedHandoff>("caffold:task-created", {
          bubbles: true,
          composed: true,
          detail: handoff,
        }),
      );
      if (!handoff.adopted)
        throw new Error(
          "The Task was created but could not be opened. Retry to open the same Task.",
        );
      this.options.value?.hidePopovers();
      this.transition({ phase: "closed" });
      this.dialog.value?.close("continued");
    } catch (failure) {
      if (generation !== this.generation || !this.isConnected) return;
      const error =
        failure instanceof Error ? failure : new Error(String(failure));
      if (!this.created && !("status" in error)) {
        error.message +=
          " The creation result is unknown. Check the Task list before retrying.";
      }
      this.transition({ phase: "choosing", source, error });
      this.options.value?.setContext({
        cwd: source.cwd,
        locked: Boolean(this.created),
        placement: "below",
      });
    }
  }

  private closed() {
    if (this.state.phase === "creating") return;
    this.options.value?.hidePopovers();
    this.transition({ phase: "closed" });
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-handoff-dialog": CaffoldTaskHandoffDialog;
  }
}
