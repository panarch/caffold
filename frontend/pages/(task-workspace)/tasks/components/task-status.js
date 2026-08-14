import { escapeHtml } from "../../../../components/dom.js";
import { renderInlineIcon } from "../../../../components/icons.js";
import { taskStatusView } from "../runtime-state.js";

export function renderTaskStatusChip(task, className = "", options = {}) {
  const view = taskStatusView(task);
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

export function patchTaskStatusChip(current, next) {
  syncElementAttributes(current, next, [
    "class",
    "data-status",
    "title",
    "aria-label",
  ]);

  const currentSpinner = current.querySelector(":scope > .task-status-spinner");
  const nextSpinner = next.querySelector(":scope > .task-status-spinner");
  if (currentSpinner && nextSpinner) {
    syncElementAttributes(currentSpinner, nextSpinner, ["class", "aria-hidden"]);
    patchTextChild(current, next, ".sr-only");
    patchTextChild(current, next, ".task-status-label");
    return;
  }
  if (current.innerHTML.trim() !== next.innerHTML.trim()) {
    current.innerHTML = next.innerHTML;
  }
}

function patchTextChild(current, next, selector) {
  const currentChild = current.querySelector(`:scope > ${selector}`);
  const nextChild = next.querySelector(`:scope > ${selector}`);
  if (currentChild && nextChild) {
    syncElementAttributes(currentChild, nextChild, ["class"]);
    if (currentChild.textContent !== nextChild.textContent) {
      currentChild.textContent = nextChild.textContent;
    }
  } else if (currentChild) {
    currentChild.remove();
  } else if (nextChild) {
    current.append(nextChild);
  }
}

function syncElementAttributes(element, nextElement, names) {
  for (const name of names) {
    if (nextElement.hasAttribute(name)) {
      const value = nextElement.getAttribute(name);
      if (element.getAttribute(name) !== value) {
        element.setAttribute(name, value);
      }
    } else if (element.hasAttribute(name)) {
      element.removeAttribute(name);
    }
  }
}
