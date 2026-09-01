import { escapeHtml } from "../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import {
  formatDate,
  formatDuration,
  taskEventObservedMs,
} from "../../../task-format.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../action-hints.js";
import { keyboardNavigationContext } from "../../../../keyboard-navigation-context.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";
import "../../../../components/keyboard-navigation-presentation.js";

class CaffoldTaskCommandDialog extends HTMLElement {
  connectedCallback() {
    this.attachIconListener();
    if (this.initialized) {
      this.refreshCloseIcon();
      return;
    }

    this.initialized = true;
    this.threadId = "";
    this.addEventListener("click", (event) => this.handleClick(event));
    this.render();
    warmIcons();
  }

  disconnectedCallback() {
    if (!this.iconsReadyListening) {
      return;
    }
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = false;
  }

  attachIconListener() {
    this.boundIconsReady ??= () => this.refreshCloseIcon();
    if (this.iconsReadyListening) {
      return;
    }
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.iconsReadyListening = true;
  }

  dialog() {
    return this.querySelector(":scope > dialog");
  }

  keyboardNavigationContexts() {
    const dialog = this.dialog();
    const presentation = dialog?.querySelector(
      ":scope > caffold-keyboard-navigation-presentation",
    );
    const hintDialog = presentation?.actionHintDialog?.();
    const hud = presentation?.scrollModeHud?.();
    if (!dialog || !hintDialog || !hud) {
      return [];
    }
    const threadId = `${this.threadId ?? ""}`;
    return [keyboardNavigationContext({
      id: threadId
        ? `task-command:${encodeURIComponent(threadId)}`
        : "task-command",
      kind: "modal",
      root: dialog,
      actionHints: {
        dialog: hintDialog,
        scope: this.actionHintScope(),
      },
      scroll: {
        hud,
        scope: this.scrollSurfaceScope(),
      },
    })];
  }

  actionHintScope() {
    const dialog = this.dialog();
    const control = dialog?.querySelector(
      '[data-command-dialog-action="close"]',
    );
    const threadId = `${this.threadId ?? ""}`;
    if (!dialog || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        id: `task-command:${encodeURIComponent(threadId)}:close`,
        actionId: ACTION_HINT_ACTION.DIALOG_BUTTON,
        label: control.getAttribute("aria-label") || "Close command output",
        control,
        clipRoots: [dialog],
        isActionable: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          `${this.threadId ?? ""}` === threadId &&
          Boolean(threadId) &&
          dialog.querySelector(
            '[data-command-dialog-action="close"]',
          ) === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  scrollSurfaceScope() {
    const dialog = this.dialog();
    const scrollport = dialog?.querySelector(".task-command-dialog-body");
    const threadId = `${this.threadId ?? ""}`;
    if (!dialog || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `task-command:${encodeURIComponent(threadId)}:output`,
        label: "Command output",
        scrollport,
        clipRoots: [dialog, scrollport],
        isEligible: () =>
          this.isConnected &&
          this.dialog() === dialog &&
          dialog.open &&
          `${this.threadId ?? ""}` === threadId &&
          Boolean(threadId) &&
          dialog.querySelector(".task-command-dialog-body") === scrollport &&
          hasScrollLayoutBox(dialog) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this, scrollport],
      resizeElements: [dialog, scrollport],
      scrollRoots: [scrollport],
    };
  }

  setThreadId(threadId) {
    const nextThreadId = `${threadId ?? ""}`;
    if (this.threadId && this.threadId !== nextThreadId) {
      this.dismiss();
    }
    this.threadId = nextThreadId;
  }

  openCommand(event) {
    const payload = event?.payload ?? {};
    this.renderCommand({
      command: `${payload.command ?? ""}`.trim(),
      cwd: `${payload.cwd ?? ""}`.trim(),
      status: `${payload.status ?? ""}`.trim(),
      output: `${payload.output ?? ""}`,
      exitCode: finiteNumber(payload.exitCode),
      durationMs: finiteNumber(payload.durationMs),
      createdMs: taskEventObservedMs(event),
    });
    const dialog = this.dialog();
    if (!dialog.open) {
      dialog.showModal();
    }
    this.resetScroll();
  }

  dismiss() {
    const dialog = this.dialog();
    if (dialog?.open) {
      dialog.close();
    }
  }

  handleClick(event) {
    const dialog = this.dialog();
    if (event.target === dialog) {
      dialog.close();
      return;
    }
    const closeButton = event.target.closest(
      '[data-command-dialog-action="close"]',
    );
    if (closeButton) {
      dialog.close();
    }
  }

  resetScroll() {
    const body = this.querySelector("[data-command-dialog-body]");
    if (body) {
      body.scrollTop = 0;
      body.scrollLeft = 0;
    }
  }

  render() {
    this.innerHTML = `
      <dialog aria-labelledby="task-command-dialog-title">
        <article class="task-command-dialog-card">
          <header class="task-command-dialog-header">
            <div>
              <h2 id="task-command-dialog-title">Command output</h2>
              <p data-command-dialog-status></p>
            </div>
            <button
              type="button"
              class="task-command-dialog-close"
              data-command-dialog-action="close"
              title="Close command output"
              aria-label="Close command output"
            >${renderInlineIcon(
              "X",
              "Close command output",
              "task-command-dialog-close-icon",
            )}</button>
          </header>
          <div class="task-command-dialog-body" data-command-dialog-body></div>
        </article>
        <caffold-keyboard-navigation-presentation></caffold-keyboard-navigation-presentation>
      </dialog>
    `;
  }

  refreshCloseIcon() {
    const closeButton = this.querySelector(
      '[data-command-dialog-action="close"]',
    );
    if (closeButton) {
      closeButton.innerHTML = renderInlineIcon(
        "X",
        "Close command output",
        "task-command-dialog-close-icon",
      );
    }
  }

  renderCommand(command) {
    const failed = commandFailed(command.status, command.exitCode);
    const statusLabel = failed ? "Failed" : "Completed";
    const status = this.querySelector("[data-command-dialog-status]");
    const body = this.querySelector("[data-command-dialog-body]");
    this.dialog().dataset.commandStatus = failed ? "failed" : "completed";
    status.textContent = statusLabel;
    body.innerHTML = `
      <dl class="task-command-dialog-details">
        <div>
          <dt>Command</dt>
          <dd><code>${escapeHtml(command.command || "(command unavailable)")}</code></dd>
        </div>
        ${command.cwd ? `<div><dt>Working directory</dt><dd><code>${escapeHtml(command.cwd)}</code></dd></div>` : ""}
        <div><dt>Status</dt><dd>${escapeHtml(statusLabel)}</dd></div>
        ${command.durationMs !== null ? `<div><dt>Duration</dt><dd>${escapeHtml(formatDuration(command.durationMs))}</dd></div>` : ""}
        ${command.exitCode !== null ? `<div><dt>Exit code</dt><dd><code>${escapeHtml(command.exitCode)}</code></dd></div>` : ""}
        ${command.createdMs !== null ? `<div><dt>Timeline time</dt><dd><time>${escapeHtml(formatDate(command.createdMs))}</time></dd></div>` : ""}
      </dl>
      <section class="task-command-dialog-output" aria-labelledby="task-command-output-title">
        <h3 id="task-command-output-title">Output</h3>
        <pre>${escapeHtml(command.output || "(No output)")}</pre>
      </section>
    `;
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function commandFailed(status, exitCode) {
  return status === "failed" || (exitCode !== null && exitCode !== 0);
}

if (!customElements.get("caffold-task-command-dialog")) {
  customElements.define(
    "caffold-task-command-dialog",
    CaffoldTaskCommandDialog,
  );
}
