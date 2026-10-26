import { html, LitElement, nothing } from "lit";
import type { ActionHintScope } from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.ts";
import { keyboardNavigationContext } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import type { CaffoldKeyboardNavigationPresentation } from "#app/keyboard-navigation/components/presentation.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfaceScope,
} from "#app/scroll-scope.js";
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
  private threadId = "";
  private command: CommandView | null = null;
  private readonly iconsReady = () => this.requestUpdate();

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
    this.performUpdate();
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
    const dialog = this.dialog;
    if (!dialog.open) {
      dialog.showModal();
    }
    // A new command starts at its top and its first column.
    for (const scrollport of [this.body, this.outputScrollport]) {
      if (scrollport) {
        scrollport.scrollTop = 0;
        scrollport.scrollLeft = 0;
      }
    }
  }

  dismiss() {
    const dialog = this.dialog;
    if (dialog?.open) {
      dialog.close();
    }
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog;
    const presentation =
      dialog?.querySelector<CaffoldKeyboardNavigationPresentation>(
        ":scope > caffold-keyboard-navigation-presentation",
      );
    const hintDialog = presentation?.actionHintDialog();
    const hud = presentation?.scrollModeHud();
    const selector = presentation?.scrollSurfaceSelector();
    if (!dialog || !hintDialog || !hud || !selector) {
      return [];
    }
    const threadId = this.threadId;
    return [
      keyboardNavigationContext({
        id: threadId
          ? `task-command:${encodeURIComponent(threadId)}`
          : "task-command",
        kind: "modal",
        root: dialog,
        actionHints: { dialog: hintDialog, scope: this.actionHintScope() },
        scroll: { hud, selector, scope: this.scrollSurfaceScope() },
      }),
    ];
  }

  actionHintScope(): ActionHintScope {
    const dialog = this.dialog;
    const control = this.closeButton;
    const threadId = this.threadId;
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `task-command:${encodeURIComponent(threadId)}:close`,
          actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
          label: control.getAttribute("aria-label") || "Close command output",
          control,
          clipRoots: [dialog],
          isActionable: () =>
            this.isConnected &&
            this.dialog === dialog &&
            dialog.open &&
            this.threadId === threadId &&
            Boolean(threadId) &&
            this.closeButton === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope(): ScrollSurfaceScope {
    const dialog = this.dialog;
    const scrollport = this.body;
    const threadId = this.threadId;
    if (!dialog || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    const current = () =>
      this.isConnected &&
      this.dialog === dialog &&
      dialog.open &&
      this.threadId === threadId &&
      Boolean(threadId) &&
      this.body === scrollport;
    const bodyScope: ScrollSurfaceScope = {
      blocked: false,
      surfaces: [
        {
          id: `task-command:${encodeURIComponent(threadId)}:body`,
          label: "Command dialog",
          scrollport,
          clipRoots: [dialog, scrollport],
          isEligible: () =>
            current() &&
            hasScrollLayoutBox(dialog) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
    const output = this.outputScrollport;
    const outputScope: ScrollSurfaceScope | null = output
      ? {
          blocked: false,
          surfaces: [
            {
              id: `task-command:${encodeURIComponent(threadId)}:output`,
              label: "Command output",
              scrollport: output,
              axes: ["horizontal"],
              clipRoots: [dialog, scrollport, output],
              isEligible: () =>
                current() &&
                this.outputScrollport === output &&
                hasScrollLayoutBox(dialog) &&
                hasScrollLayoutBox(output),
            },
          ],
          mutationRoots: [this, scrollport],
          resizeElements: [dialog, scrollport, output],
          scrollRoots: [scrollport, output],
        }
      : null;
    return mergeScrollSurfaceScopes(bodyScope, outputScope);
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
    return html`<dialog
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
            type="button"
            class="task-command-dialog-close"
            data-command-dialog-action="close"
            title=${closeLabel}
            aria-label=${closeLabel}
            @click=${this.dismiss}
          >${closeIcon}</button>
        </header>
        <div class="task-command-dialog-body" data-command-dialog-body>${
          command ? commandTemplate(command, statusLabel) : nothing
        }</div>
      </article>
      <caffold-keyboard-navigation-presentation
      ></caffold-keyboard-navigation-presentation>
    </dialog>`;
  }

  private closeFromBackdrop(event: Event) {
    if (event.target === this.dialog) {
      this.dismiss();
    }
  }

  private get dialog() {
    return this.querySelector(":scope > dialog") as HTMLDialogElement;
  }

  private get closeButton() {
    return this.dialog?.querySelector<HTMLButtonElement>(
      '[data-command-dialog-action="close"]',
    );
  }

  private get body() {
    return this.dialog?.querySelector<HTMLElement>(".task-command-dialog-body");
  }

  private get outputScrollport() {
    return this.body?.querySelector<HTMLElement>(
      ":scope > .task-command-dialog-output > pre",
    );
  }
}

function commandTemplate(command: CommandView, statusLabel: string) {
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
      <pre>${command.output || "(No output)"}</pre>
    </section>`;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

customElements.define("caffold-task-command-dialog", CaffoldTaskCommandDialog);
