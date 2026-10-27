import { html, LitElement, nothing } from "lit";
import { ACTION_HINT_ACTION, ActionHints } from "#app/action-hints.ts";
import type { TaskEvent } from "#app/api.ts";
import { KeyboardContexts } from "#app/keyboard-navigation.ts";
import "#app/keyboard-navigation/components/presentation.ts";
import { ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";
import {
  formatDate,
  formatDuration,
  taskEventObservedMs,
} from "#tasks/task-format.ts";

// One finished command as the dialog shows it.
interface CommandView {
  command: string;
  cwd: string;
  failed: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
  createdMs: number | null;
}

/**
 * A command a Task's agent ran, with its whole output, over the Task screen.
 * The dialog belongs to one Task and closes when another Task opens.
 */
export class CaffoldTaskCommandDialog extends LitElement {
  static properties = {
    threadId: { state: true },
  };

  declare private threadId: string;
  private command: CommandView | null = null;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly keyboard = new KeyboardContexts(this);
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly body = new DrawnRef<HTMLDivElement>(this);
  private readonly output = new DrawnRef<HTMLPreElement>(this);

  constructor() {
    super();
    this.threadId = "";
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
  }

  setThreadId(threadId: string) {
    if (this.threadId && this.threadId !== threadId) {
      this.dismiss();
    }
    this.threadId = threadId;
  }

  openCommand(event: TaskEvent) {
    const payload = event.payload ?? {};
    const status = `${payload.status ?? ""}`.trim();
    const exitCode = finiteNumber(payload.exitCode);
    this.command = {
      command: `${payload.command ?? ""}`.trim(),
      cwd: `${payload.cwd ?? ""}`.trim(),
      failed: status === "failed" || (exitCode !== null && exitCode !== 0),
      output: `${payload.output ?? ""}`,
      exitCode,
      durationMs: finiteNumber(payload.durationMs),
      createdMs: taskEventObservedMs(event),
    };
    this.requestUpdate();
    this.performUpdate();
    const dialog = this.dialog.value;
    if (dialog && !dialog.open) {
      dialog.showModal();
    }
    // A new command starts at its top and its first column.
    for (const scrollport of [this.body.value, this.output.value]) {
      if (scrollport) {
        scrollport.scrollTop = 0;
        scrollport.scrollLeft = 0;
      }
    }
  }

  dismiss() {
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  keyboardNavigationContexts() {
    return this.keyboard.contexts({
      actionHints: (pull) => this.hints.scope(pull),
      scroll: (pull) => this.surfaces.scope(pull),
    });
  }

  render() {
    const command = this.command;
    const statusLabel = command?.failed ? "Failed" : "Completed";
    const closeLabel = "Close command output";
    const closeIcon = inlineIcon(
      "X",
      closeLabel,
      "task-command-dialog-close-icon",
    );
    const threadId = this.threadId;
    return html`<dialog
      ${drawn(this.dialog)}
      ${this.keyboard.modal({
        id: threadId
          ? `task-command:${encodeURIComponent(threadId)}`
          : "task-command",
      })}
      aria-labelledby="task-command-dialog-title"
      data-command-status=${
        command ? (command.failed ? "failed" : "completed") : nothing
      }
      @click=${this.closeFromBackdrop}
    >
      <article class="task-command-dialog-card">
        <header class="task-command-dialog-header">
          <div>
            <h2 id="task-command-dialog-title">Command output</h2>
            <p data-command-dialog-status>${command ? statusLabel : ""}</p>
          </div>
          <button
            ${this.hints.button({
              id: "close",
              label: closeLabel,
              action: ACTION_HINT_ACTION.DIALOG_BUTTON,
            })}
            type="button"
            class="task-command-dialog-close"
            data-command-dialog-action="close"
            title=${closeLabel}
            aria-label=${closeLabel}
            @click=${this.dismiss}
          >${closeIcon}</button>
        </header>
        <div
          ${drawn(this.body)}
          ${this.surfaces.surface({
            id: "body",
            label: () => "Command dialog",
            clipRoots: () => [this.body.value],
          })}
          class="task-command-dialog-body"
          data-command-dialog-body
        >${
          command
            ? commandTemplate(command, statusLabel, {
                surfaces: this.surfaces,
                output: this.output,
                clipRoots: () => [this.body.value, this.output.value],
              })
            : nothing
        }</div>
      </article>
      <caffold-keyboard-navigation-presentation
        ${this.keyboard.presentation()}
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private closeFromBackdrop(event: Event) {
    if (event.target === this.dialog.value) {
      this.dismiss();
    }
  }
}

// What the command's output is drawn with: its Scroll surface, and the ref
// the dialog scrolls back to the start.
interface CommandOutputParts {
  surfaces: ScrollSurfaces;
  output: DrawnRef<HTMLPreElement>;
  clipRoots: () => Array<Element | undefined>;
}

function commandTemplate(
  command: CommandView,
  statusLabel: string,
  { surfaces, output, clipRoots }: CommandOutputParts,
) {
  return html`<dl class="task-command-dialog-details">
      <div>
        <dt>Command</dt>
        <dd><code>${command.command || "(command unavailable)"}</code></dd>
      </div>
      ${
        command.cwd
          ? html`<div>
            <dt>Working directory</dt>
            <dd><code>${command.cwd}</code></dd>
          </div>`
          : nothing
      }
      <div><dt>Status</dt><dd>${statusLabel}</dd></div>
      ${
        command.durationMs !== null
          ? html`<div>
            <dt>Duration</dt>
            <dd>${formatDuration(command.durationMs)}</dd>
          </div>`
          : nothing
      }
      ${
        command.exitCode !== null
          ? html`<div>
            <dt>Exit code</dt>
            <dd><code>${command.exitCode}</code></dd>
          </div>`
          : nothing
      }
      ${
        command.createdMs !== null
          ? html`<div>
            <dt>Timeline time</dt>
            <dd><time>${formatDate(command.createdMs)}</time></dd>
          </div>`
          : nothing
      }
    </dl>
    <section
      class="task-command-dialog-output"
      aria-labelledby="task-command-output-title"
    >
      <h3 id="task-command-output-title">Output</h3>
      <pre
        ${drawn(output)}
        ${surfaces.surface({
          id: "output",
          label: () => "Command output",
          axes: ["horizontal"],
          clipRoots,
        })}
      >${command.output || "(No output)"}</pre>
    </section>`;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

customElements.define("caffold-task-command-dialog", CaffoldTaskCommandDialog);
