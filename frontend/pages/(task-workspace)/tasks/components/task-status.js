import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon } from "../../../../components/icons.js";
import {
  TASK_TRANSPORT_STATE,
  taskStatusView,
} from "../runtime-state.js";

export function renderTaskStatusChip(task, className = "", options = {}) {
  const view = taskStatusView(
    task,
    options.transportState ?? TASK_TRANSPORT_STATE.READY,
  );
  if (!view) {
    return "";
  }

  const classes = ["task-status-chip", className].filter(Boolean).join(" ");
  const icon = ["running", "syncing", "reconnecting"].includes(view.status)
    ? `<span class="task-status-spinner" aria-hidden="true"></span><span class="sr-only">${escapeHtml(view.label)}</span>`
    : renderInlineIcon(view.icon, view.label, "task-status-icon");
  return `
    <span
      class="${escapeHtml(classes)}"
      data-status="${escapeHtml(view.status)}"
      title="${escapeHtml(view.label)}"
      aria-label="${escapeHtml(view.label)}"
    >
      ${icon}
      ${options.label === false ? "" : `<span class="task-status-label">${escapeHtml(view.label)}</span>`}
    </span>
  `;
}
