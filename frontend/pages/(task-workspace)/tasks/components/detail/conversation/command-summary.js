import { escapeHtml } from "../../../../../../components/dom.js";
import { eventIdentityKey } from "../../../task-events.js";
import { formatDuration } from "../../../task-format.js";

class CaffoldTaskCommandSummary extends HTMLElement {
  connectedCallback() {
    if (this.listening) {
      return;
    }
    this.listening = true;
    this.boundClick ??= (event) => this.handleClick(event);
    this.addEventListener("click", this.boundClick);
  }

  disconnectedCallback() {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    this.removeEventListener("click", this.boundClick);
  }

  get commandKey() {
    return `${this.action()?.dataset.commandKey ?? ""}`;
  }

  focusAction() {
    const action = this.action();
    action?.focus();
    return Boolean(action);
  }

  action() {
    return this.querySelector(":scope > .task-command-summary-action");
  }

  handleClick(event) {
    const action =
      event.target instanceof Element
        ? event.target.closest('[data-command-summary-action="command-output"]')
        : null;
    if (!action || !this.contains(action)) {
      return;
    }
    event.stopPropagation();
    const commandKey = `${action.dataset.commandKey ?? ""}`;
    if (!commandKey) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-command-summary-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "command-output", commandKey },
      }),
    );
  }
}

export function renderCommandSummary(event) {
  const payload = event?.payload ?? {};
  const command = `${payload.command ?? ""}`.trim() || "(command unavailable)";
  const status = commandSummaryStatus(event);
  const duration = finiteNumber(payload.durationMs);
  const exitCode = finiteNumber(payload.exitCode);
  const metadata = [
    duration !== null ? formatDuration(duration) : "",
    status === "failed" && exitCode !== null ? `Exit ${exitCode}` : "",
  ].filter(Boolean);
  return `
    <caffold-task-command-summary class="task-command-summary">
      <span class="task-command-summary-status" data-command-result="${escapeHtml(status)}">${status === "failed" ? "Failed" : "Completed"}</span>
      <code class="task-command-summary-label">${escapeHtml(command)}</code>
      ${metadata.length ? `<span class="task-command-summary-meta">${escapeHtml(metadata.join(" · "))}</span>` : ""}
      <button
        type="button"
        class="task-command-summary-action"
        data-command-summary-action="command-output"
        data-command-key="${escapeHtml(eventIdentityKey(event))}"
        aria-haspopup="dialog"
      >View output</button>
    </caffold-task-command-summary>
  `;
}

export function commandSummaryStatus(event) {
  const payload = event?.payload ?? {};
  const exitCode = finiteNumber(payload.exitCode);
  return payload.status === "failed" || (exitCode !== null && exitCode !== 0)
    ? "failed"
    : "completed";
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

if (!customElements.get("caffold-task-command-summary")) {
  customElements.define(
    "caffold-task-command-summary",
    CaffoldTaskCommandSummary,
  );
}
