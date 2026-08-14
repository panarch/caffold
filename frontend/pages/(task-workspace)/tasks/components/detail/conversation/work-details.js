import { escapeHtml } from "../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../components/icons.js";
import {
  eventIdentityKey,
  fileChangePathPresentations,
} from "../../../task-events.js";
import {
  formatDate,
  formatStatus,
} from "../../../task-format.js";
import {
  commandSummaryStatus,
  renderCommandSummary,
} from "./command-summary.js";
import "./components/changed-files.js";

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
      filePathPresentationBase: "",
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
      filePathPresentationBase: `${snapshot.filePathPresentationBase ?? ""}`,
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
    const view = renderWorkItems(
      this.snapshot.events,
      this.snapshot.filePathPresentationBase,
    );
    reconcileWorkItems(body, view.html, view.changedFiles);
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
      left.filePathPresentationBase === right.filePathPresentationBase &&
      sameEventList(left.events, right.events),
  );
}

function sameEventList(left, right) {
  return (
    left.length === right.length &&
    left.every((event, index) => event === right[index])
  );
}

function renderWorkItems(events, filePathPresentationBase) {
  const output = [];
  const changedFiles = new Map();
  let combinedEvents = [];
  let combinedType = "";
  const flushCombinedEvents = () => {
    if (combinedType === "reasoning") {
      output.push(renderCombinedReasoningWorkItem(combinedEvents));
    } else if (combinedType === "file_change") {
      output.push(
        renderCombinedFileChangeWorkItem(
          combinedEvents,
          filePathPresentationBase,
          changedFiles,
        ),
      );
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
    output.push(
      renderWorkItem(event, filePathPresentationBase, changedFiles),
    );
  }
  flushCombinedEvents();
  return { html: output.filter(Boolean).join(""), changedFiles };
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

function renderCombinedFileChangeWorkItem(
  events,
  filePathPresentationBase,
  changedFiles,
) {
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
  const identity = fileChangeWorkIdentity(events);
  changedFiles.set(identity, {
    files: fileChangePathPresentations(events, filePathPresentationBase),
  });
  return renderFileChangeWorkItemShell(
    latest,
    [updateText, latestSummary, status].filter(Boolean).join("\n"),
    identity,
  );
}

function latestEvent(events) {
  return events.reduce((latest, event) =>
    (event.createdMs ?? 0) >= (latest.createdMs ?? 0) ? event : latest,
  );
}

function renderWorkItem(event, filePathPresentationBase, changedFiles) {
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
    const identity = fileChangeWorkIdentity([event]);
    changedFiles.set(identity, {
      files: fileChangePathPresentations([event], filePathPresentationBase),
    });
    return renderFileChangeWorkItemShell(
      event,
      [summary, status].filter(Boolean).join("\n"),
      identity,
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

function renderFileChangeWorkItemShell(event, text, identity) {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-details-item" data-event-type="file_change" data-tool-tone="neutral" data-file-change-work-identity="${escapeHtml(identity)}">
      <header>
        <strong>Files changed</strong>
        <time>${escapeHtml(formatDate(event.createdMs))}</time>
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
      <caffold-task-changed-files></caffold-task-changed-files>
    </article>
  `;
}

function fileChangeWorkIdentity(events) {
  const first = events[0];
  return `file-change:${
    eventIdentityKey(first) ||
    [first?.threadId ?? "", first?.createdMs ?? ""].join(":")
  }`;
}

function reconcileWorkItems(body, html, changedFiles) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const existingFileChangeItems = new Map(
    [...body.children]
      .filter((item) => item.hasAttribute("data-file-change-work-identity"))
      .map((item) => [item.dataset.fileChangeWorkIdentity, item]),
  );
  const desiredItems = [...template.content.children].map((item) => {
    const identity = `${item.dataset.fileChangeWorkIdentity ?? ""}`;
    const existing = existingFileChangeItems.get(identity);
    if (identity && existing && patchFileChangeWorkItem(existing, item)) {
      return existing;
    }
    return item;
  });
  reconcileWorkItemChildren(body, desiredItems);
  for (const item of desiredItems) {
    const identity = `${item.dataset.fileChangeWorkIdentity ?? ""}`;
    const owner = item.querySelector(":scope > caffold-task-changed-files");
    const snapshot = changedFiles.get(identity);
    if (owner && snapshot) {
      owner.setSnapshot(snapshot);
    }
  }
}

function patchFileChangeWorkItem(current, desired) {
  const currentTime = current.querySelector(":scope > header > time");
  const desiredTime = desired.querySelector(":scope > header > time");
  const currentSummary = current.querySelector(":scope > pre");
  const desiredSummary = desired.querySelector(":scope > pre");
  const owner = current.querySelector(":scope > caffold-task-changed-files");
  if (
    !currentTime ||
    !desiredTime ||
    !owner ||
    Boolean(currentSummary) !== Boolean(desiredSummary)
  ) {
    return false;
  }
  syncElementAttributes(current, desired, [
    "class",
    "data-event-type",
    "data-tool-tone",
    "data-file-change-work-identity",
  ]);
  patchText(currentTime, desiredTime.textContent);
  if (currentSummary && desiredSummary) {
    patchText(currentSummary, desiredSummary.textContent);
  }
  return true;
}

function syncElementAttributes(current, desired, names) {
  for (const name of names) {
    if (desired.hasAttribute(name)) {
      const value = desired.getAttribute(name);
      if (current.getAttribute(name) !== value) {
        current.setAttribute(name, value);
      }
    } else {
      current.removeAttribute(name);
    }
  }
}

function patchText(element, value) {
  if (element.textContent !== value) {
    element.textContent = value;
  }
}

function reconcileWorkItemChildren(body, desiredItems) {
  const desired = new Set(desiredItems);
  for (const item of [...body.children]) {
    if (!desired.has(item)) {
      item.remove();
    }
  }
  let anchor = null;
  for (let index = desiredItems.length - 1; index >= 0; index -= 1) {
    const item = desiredItems[index];
    if (item.parentElement !== body || item.nextElementSibling !== anchor) {
      body.insertBefore(item, anchor);
    }
    anchor = item;
  }
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
