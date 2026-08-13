import { escapeHtml } from "../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import { eventIdentityKey, fileChangePaths } from "../../../task-events.js";
import {
  formatDate,
  formatStatus,
} from "../../../task-format.js";
import {
  commandSummaryStatus,
  renderCommandSummary,
} from "./command-summary.js";

const disclosureStateByIdentity = new Map();

class CaffoldTaskWorkDetails extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.attachListeners();
    if (!this.initialized) {
      this.initialized = true;
      this.render();
    } else {
      this.restoreDisclosureState();
      this.refreshChevronIcons();
    }
    warmIcons();
  }

  disconnectedCallback() {
    this.rememberDisclosureState();
    this.detachListeners();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.snapshot = {
      identity: "",
      label: "Work details",
      updateText: "",
      events: [],
    };
    this.boundClick = (event) => this.handleClick(event);
    this.boundIconsReady = () => this.refreshChevronIcons();
  }

  attachListeners() {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.addEventListener("click", this.boundClick);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  detachListeners() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.removeEventListener("click", this.boundClick);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setSnapshot(snapshot = {}) {
    this.ensureState();
    const nextSnapshot = {
      identity: `${snapshot.identity ?? ""}`,
      label: `${snapshot.label ?? "Work details"}`,
      updateText: `${snapshot.updateText ?? ""}`,
      events: [...(snapshot.events ?? [])],
    };
    if (sameSnapshot(this.snapshot, nextSnapshot)) {
      return false;
    }
    if (this.initialized && this.snapshot.identity !== nextSnapshot.identity) {
      this.rememberDisclosureState();
    }
    this.snapshot = nextSnapshot;
    this.dataset.workDetailsIdentity = nextSnapshot.identity;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  get identity() {
    this.ensureState();
    return this.snapshot.identity;
  }

  disclosureOpen(key = "root") {
    return Boolean(this.disclosure(key)?.open);
  }

  disclosureAnchorTop(key = "root") {
    const summary = this.disclosure(key)?.querySelector(":scope > summary");
    return summary?.getBoundingClientRect().top ?? null;
  }

  render() {
    this.innerHTML = `
      <details data-work-details-disclosure-key="root">
        <summary>
          <span class="task-work-details-label">
            <span class="task-work-details-label-text"></span>
            <span class="task-work-details-chevron" aria-hidden="true"></span>
          </span>
          <span class="task-work-details-count"></span>
        </summary>
        <div class="task-work-details-body"></div>
      </details>
    `;
    this.update();
  }

  update() {
    const label = this.querySelector(".task-work-details-label-text");
    const count = this.querySelector(".task-work-details-count");
    const body = this.querySelector(".task-work-details-body");
    label.textContent = this.snapshot.label;
    count.textContent = this.snapshot.updateText;
    if (this.renderedIdentity === this.snapshot.identity) {
      this.rememberDisclosureState();
    }
    body.innerHTML = renderWorkItems(this.snapshot.events);
    this.restoreDisclosureState();
    this.renderedIdentity = this.snapshot.identity;
    this.refreshChevronIcons();
  }

  refreshChevronIcons() {
    const chevron = this.querySelector(".task-work-details-chevron");
    if (!chevron) {
      return;
    }
    chevron.innerHTML = `
      ${renderInlineIcon(
        "ChevronRight",
        "Collapsed",
        "task-work-details-chevron-icon task-work-details-chevron-collapsed",
      )}
      ${renderInlineIcon(
        "ChevronDown",
        "Expanded",
        "task-work-details-chevron-icon task-work-details-chevron-expanded",
      )}
    `;
  }

  handleClick(event) {
    const summary =
      event.target instanceof Element ? event.target.closest("summary") : null;
    const disclosure = summary?.parentElement;
    if (
      !(disclosure instanceof HTMLDetailsElement) ||
      !this.contains(disclosure)
    ) {
      return;
    }
    const key = `${disclosure.dataset.workDetailsDisclosureKey ?? ""}`;
    const open = !disclosure.open;
    this.disclosureState().set(key, open);
    this.dispatchEvent(
      new CustomEvent("caffold:task-work-details-disclosure-intent", {
        bubbles: true,
        composed: true,
        detail: { identity: this.identity, key, open },
      }),
    );
  }

  disclosure(key) {
    return [...this.querySelectorAll("details[data-work-details-disclosure-key]")].find(
      (entry) => entry.dataset.workDetailsDisclosureKey === key,
    );
  }

  disclosureState() {
    const identity = this.identity;
    if (!identity) {
      return new Map();
    }
    let state = disclosureStateByIdentity.get(identity);
    if (!state) {
      state = new Map();
      disclosureStateByIdentity.set(identity, state);
    }
    return state;
  }

  rememberDisclosureState() {
    if (!this.initialized || !this.identity) {
      return;
    }
    const state = this.disclosureState();
    for (const disclosure of this.querySelectorAll(
      "details[data-work-details-disclosure-key]",
    )) {
      state.set(disclosure.dataset.workDetailsDisclosureKey, disclosure.open);
    }
  }

  restoreDisclosureState() {
    if (!this.initialized || !this.identity) {
      return;
    }
    const state = this.disclosureState();
    for (const disclosure of this.querySelectorAll(
      "details[data-work-details-disclosure-key]",
    )) {
      const key = disclosure.dataset.workDetailsDisclosureKey;
      if (state.has(key)) {
        disclosure.toggleAttribute("open", state.get(key));
      }
    }
  }
}

function sameSnapshot(left, right) {
  return Boolean(
    left.identity === right.identity &&
      left.label === right.label &&
      left.updateText === right.updateText &&
      sameEventList(left.events, right.events),
  );
}

function sameEventList(left, right) {
  return (
    left.length === right.length &&
    left.every((event, index) => event === right[index])
  );
}

function renderWorkItems(events) {
  const output = [];
  let combinedEvents = [];
  let combinedType = "";
  const flushCombinedEvents = () => {
    if (combinedType === "reasoning") {
      output.push(renderCombinedReasoningWorkItem(combinedEvents));
    } else if (combinedType === "file_change") {
      output.push(renderCombinedFileChangeWorkItem(combinedEvents));
    }
    combinedEvents = [];
    combinedType = "";
  };

  for (const event of events) {
    if (["reasoning", "file_change"].includes(event.type)) {
      if (combinedType && combinedType !== event.type) {
        flushCombinedEvents();
      }
      combinedType = event.type;
      combinedEvents.push(event);
      continue;
    }
    flushCombinedEvents();
    output.push(renderWorkItem(event));
  }
  flushCombinedEvents();
  return output.filter(Boolean).join("");
}

function renderCombinedReasoningWorkItem(events) {
  if (!events.length) {
    return "";
  }
  const text = events
    .map((event) => {
      const payload = event.payload ?? {};
      const summary = Array.isArray(payload.summary)
        ? payload.summary.filter(Boolean).join("\n\n")
        : "";
      const content = Array.isArray(payload.content)
        ? payload.content.filter(Boolean).join("\n\n")
        : "";
      return [summary, content].filter(Boolean).join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
  return renderWorkItemShell(latestEvent(events), "Thinking", text);
}

function renderCombinedFileChangeWorkItem(events) {
  if (!events.length) {
    return "";
  }
  const latest = latestEvent(events);
  const payload = latest.payload ?? {};
  const latestCount =
    typeof payload.changeCount === "number"
      ? payload.changeCount
      : Array.isArray(payload.changes)
        ? payload.changes.length
        : null;
  const latestSummary =
    typeof latestCount === "number"
      ? latestCount === 1
        ? "Latest: 1 changed file"
        : `Latest: ${latestCount} changed files`
      : "";
  const status = payload.status
    ? `Latest status: ${formatStatus(payload.status)}`
    : "";
  const updateText =
    events.length === 1
      ? "1 file change update"
      : `${events.length} file change updates`;
  return renderFileChangeWorkItemShell(
    latest,
    [updateText, latestSummary, status].filter(Boolean).join("\n"),
    fileChangePaths(events),
  );
}

function latestEvent(events) {
  return events.reduce((latest, event) =>
    (event.createdMs ?? 0) >= (latest.createdMs ?? 0) ? event : latest,
  );
}

function renderWorkItem(event) {
  const payload = event.payload ?? {};
  if (event.type === "assistant_message") {
    return renderWorkItemShell(event, "Update", payload.text);
  }
  if (event.type === "reasoning") {
    const summary = Array.isArray(payload.summary)
      ? payload.summary.filter(Boolean).join("\n\n")
      : "";
    const content = Array.isArray(payload.content)
      ? payload.content.filter(Boolean).join("\n\n")
      : "";
    return renderWorkItemShell(
      event,
      "Thinking",
      [summary, content].filter(Boolean).join("\n\n"),
    );
  }
  if (event.type === "plan") {
    return renderWorkItemShell(event, "Plan", payload.text);
  }
  if (event.type === "command_execution") {
    return renderCommandWorkItem(event);
  }
  if (event.type === "file_change") {
    const count =
      typeof payload.changeCount === "number"
        ? payload.changeCount
        : Array.isArray(payload.changes)
          ? payload.changes.length
          : 0;
    const status = payload.status
      ? `Status: ${formatStatus(payload.status)}`
      : "";
    const summary = count === 1 ? "1 changed file" : `${count} changed files`;
    return renderFileChangeWorkItemShell(
      event,
      [summary, status].filter(Boolean).join("\n"),
      fileChangePaths([event]),
    );
  }
  if (event.type === "task_failed") {
    return renderWorkItemShell(event, "Error", event.summary, "danger");
  }
  return `
    <article class="task-work-details-item" data-event-type="${escapeHtml(event.type)}">
      <header>
        <strong>${escapeHtml(event.summary)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
    </article>
  `;
}

function renderCommandWorkItem(event) {
  const payload = event.payload ?? {};
  const command = `${payload.command ?? ""}`.trim();
  const cwd = `${payload.cwd ?? ""}`.trim();
  const status = `${payload.status ?? ""}`.trim();
  const output = `${payload.aggregatedOutput ?? ""}`.trim();
  if (isTerminalCommandStatus(status)) {
    return `
      <article class="task-work-details-item task-work-details-command" data-event-type="command_execution" data-command-status="${escapeHtml(commandSummaryStatus(event))}" data-command-terminal="true">
        ${renderCommandSummary(event)}
      </article>
    `;
  }
  const open = status && status !== "completed" ? " open" : "";
  return `
    <article class="task-work-details-item task-work-details-command" data-event-type="command_execution" data-command-status="${escapeHtml(status || "unknown")}">
      <details${open}${disclosureIdentityAttribute("command", eventIdentityKey(event))}>
        <summary>
          <strong>Command</strong>
          ${status ? `<span>${escapeHtml(formatStatus(status))}</span>` : ""}
          <time>${escapeHtml(formatDate(event.createdMs))}</time>
        </summary>
        <div class="task-work-details-command-body">
          ${command ? `<code>$ ${escapeHtml(command)}</code>` : ""}
          ${cwd ? `<span>cwd: ${escapeHtml(cwd)}</span>` : ""}
          ${output ? `<pre>${escapeHtml(output)}</pre>` : ""}
        </div>
      </details>
    </article>
  `;
}

function renderWorkItemShell(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-details-item" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
    </article>
  `;
}

function renderFileChangeWorkItemShell(event, text, paths) {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-details-item" data-event-type="file_change" data-tool-tone="neutral">
      <header>
        <strong>Files changed</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
      ${renderChangedFilePaths(paths)}
    </article>
  `;
}

function renderChangedFilePaths(paths) {
  if (!paths.length) {
    return "";
  }
  return `
    <ul class="task-work-details-changed-files" aria-label="Changed files">
      ${paths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join("")}
    </ul>
  `;
}

function disclosureIdentityAttribute(kind, identity) {
  const value = `${identity ?? ""}`.trim();
  return value
    ? ` data-work-details-disclosure-key="${escapeHtml(`${kind}:${value}`)}"`
    : "";
}

function isTerminalCommandStatus(status) {
  return ["completed", "failed"].includes(`${status ?? ""}`);
}

if (!customElements.get("caffold-task-work-details")) {
  customElements.define("caffold-task-work-details", CaffoldTaskWorkDetails);
}
