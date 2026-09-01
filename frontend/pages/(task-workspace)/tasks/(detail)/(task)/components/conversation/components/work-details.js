import { escapeHtml } from "../../../../../../../../components/dom.js";
import {
  renderInlineIcon,
  warmIcons,
} from "../../../../../../../../components/icons.js";
import {
  eventIdentityKey,
  fileChangePathPresentations,
  sortEventsChronologically,
  taskEventAnchorMs,
  taskEventPositionIndex,
} from "../../../../../task-events.js";
import {
  formatDate,
  formatStatus,
  taskEventObservedMs,
  toolCallPresentation,
} from "../../../../../task-format.js";
import "./assistant-message.js";
import "./changed-files.js";
import "./command.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../action-hints.js";

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
    reconcileWorkItems(
      body,
      view.html,
      view.changedFiles,
      view.commands,
      view.messages,
    );
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
      !disclosure.hasAttribute("data-work-details-disclosure-key") ||
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

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureState();
    const body = this.querySelector(
      ":scope > details > .task-work-details-body",
    );
    if (!scopeId || !body || !this.identity || this.hidden) {
      return emptyActionHintScope();
    }
    const scopes = [];
    for (const item of body.children) {
      const commandIdentity = `${item.dataset.commandWorkIdentity ?? ""}`;
      const command = commandIdentity
        ? item.querySelector(":scope > caffold-task-command")
        : null;
      if (command) {
        scopes.push(command.actionHintScope?.({
          scopeId: `${scopeId}:command:${commandIdentity}`,
          clipRoots: [this, body, ...clipRoots].filter(Boolean),
        }));
      }
      const messageIdentity = `${item.dataset.messageWorkIdentity ?? ""}`;
      const message = messageIdentity
        ? item.querySelector(":scope > caffold-task-assistant-message")
        : null;
      if (message) {
        scopes.push(message.actionHintScope?.({
          scopeId: `${scopeId}:message:${messageIdentity}`,
          clipRoots: [this, body, ...clipRoots].filter(Boolean),
        }));
      }
    }
    return mergeActionHintScopes(...scopes);
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
  const commands = new Map();
  const messages = new Map();
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
      renderWorkItem(
        event,
        filePathPresentationBase,
        changedFiles,
        commands,
        messages,
      ),
    );
  }
  flushCombinedEvents();
  return {
    html: output.filter(Boolean).join(""),
    changedFiles,
    commands,
    messages,
  };
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
  const latestCount = Array.isArray(payload.paths) ? payload.paths.length : null;
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
  return sortEventsChronologically(events).at(-1);
}

function renderWorkItem(
  event,
  filePathPresentationBase,
  changedFiles,
  commands,
  messages,
) {
  const payload = event.payload ?? {};
  if (event.type === "assistant_message") {
    return renderMessageWorkItem(event, messages);
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
    return renderCommandWorkItem(event, commands);
  }
  if (event.type === "file_change") {
    const count =
      Array.isArray(payload.paths) ? payload.paths.length : 0;
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
  if (event.type === "tool_call") {
    const tool = toolCallPresentation(payload);
    return renderWorkItemShell(event, tool.label, tool.text, tool.tone);
  }
  if (event.type === "task_failed") {
    return renderWorkItemShell(event, "Error", event.summary, "danger");
  }
  return `
    <article class="task-work-details-item" data-event-type="${escapeHtml(event.type)}">
      <header>
        <strong>${escapeHtml(event.summary)}</strong>
        ${renderObservedTime(event)}
      </header>
    </article>
  `;
}

// A message the agent wrote reads as prose wherever it appears, so a folded
// turn mounts the same component the conversation shows inline. Only the
// placement differs.
function renderMessageWorkItem(event, messages) {
  const identity = eventIdentityKey(event) || `${event?.id ?? ""}`;
  if (identity) {
    messages.set(identity, { event });
  }
  return `
    <article class="task-work-details-item task-work-details-message" data-event-type="assistant_message" data-message-work-identity="${escapeHtml(identity)}">
      <caffold-task-assistant-message></caffold-task-assistant-message>
    </article>
  `;
}

function renderCommandWorkItem(event, commands) {
  const identity = eventIdentityKey(event) || `${event?.id ?? ""}`;
  if (identity) {
    commands.set(identity, event);
  }
  return `
    <article class="task-work-details-item task-work-details-command" data-event-type="command_execution" data-command-work-identity="${escapeHtml(identity)}">
      <caffold-task-command></caffold-task-command>
    </article>
  `;
}

function renderWorkItemShell(event, label, text, tone = "neutral") {
  const value = `${text ?? ""}`.trim();
  return `
    <article class="task-work-details-item" data-event-type="${escapeHtml(event.type)}" data-tool-tone="${escapeHtml(tone)}">
      <header>
        <strong>${escapeHtml(label)}</strong>
        ${renderObservedTime(event)}
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
        ${renderObservedTime(event)}
      </header>
      ${value ? `<pre>${escapeHtml(value)}</pre>` : ""}
      <caffold-task-changed-files></caffold-task-changed-files>
    </article>
  `;
}

function renderObservedTime(event) {
  const observedMs = taskEventObservedMs(event);
  return observedMs === null
    ? ""
    : `<time>${escapeHtml(formatDate(observedMs))}</time>`;
}

function fileChangeWorkIdentity(events) {
  const first = events[0];
  return `file-change:${
    eventIdentityKey(first) ||
    [
      first?.threadId ?? "",
      taskEventAnchorMs(first),
      taskEventPositionIndex(first),
    ].join(":")
  }`;
}

function reconcileWorkItems(body, html, changedFiles, commands, messages) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const existingFileChangeItems = new Map(
    [...body.children]
      .filter((item) => item.hasAttribute("data-file-change-work-identity"))
      .map((item) => [item.dataset.fileChangeWorkIdentity, item]),
  );
  const existingCommandItems = new Map(
    [...body.children]
      .filter((item) => item.hasAttribute("data-command-work-identity"))
      .map((item) => [item.dataset.commandWorkIdentity, item]),
  );
  const existingMessageItems = new Map(
    [...body.children]
      .filter((item) => item.hasAttribute("data-message-work-identity"))
      .map((item) => [item.dataset.messageWorkIdentity, item]),
  );
  const desiredItems = [...template.content.children].map((item) => {
    const messageIdentity = `${item.dataset.messageWorkIdentity ?? ""}`;
    const existingMessage = existingMessageItems.get(messageIdentity);
    if (messageIdentity && existingMessage) {
      return existingMessage;
    }
    const commandIdentity = `${item.dataset.commandWorkIdentity ?? ""}`;
    const existingCommand = existingCommandItems.get(commandIdentity);
    if (commandIdentity && existingCommand) {
      return existingCommand;
    }
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
    const commandIdentity = `${item.dataset.commandWorkIdentity ?? ""}`;
    const commandOwner = item.querySelector(":scope > caffold-task-command");
    const commandSnapshot = commands.get(commandIdentity);
    if (commandOwner && commandSnapshot) {
      commandOwner.setSnapshot(commandSnapshot);
    }
    const messageIdentity = `${item.dataset.messageWorkIdentity ?? ""}`;
    const messageOwner = item.querySelector(
      ":scope > caffold-task-assistant-message",
    );
    const messageSnapshot = messages.get(messageIdentity);
    if (messageOwner && messageSnapshot) {
      messageOwner.setSnapshot(messageSnapshot);
    }
  }
}

function patchFileChangeWorkItem(current, desired) {
  const currentHeader = current.querySelector(":scope > header");
  const desiredHeader = desired.querySelector(":scope > header");
  const currentSummary = current.querySelector(":scope > pre");
  const desiredSummary = desired.querySelector(":scope > pre");
  const owner = current.querySelector(":scope > caffold-task-changed-files");
  if (
    !currentHeader ||
    !desiredHeader ||
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
  patchOptionalTime(currentHeader, desiredHeader);
  if (currentSummary && desiredSummary) {
    patchText(currentSummary, desiredSummary.textContent);
  }
  return true;
}

function patchOptionalTime(currentHeader, desiredHeader) {
  const current = currentHeader.querySelector(":scope > time");
  const desired = desiredHeader.querySelector(":scope > time");
  if (!desired) {
    current?.remove();
  } else if (!current) {
    currentHeader.append(desired.cloneNode(true));
  } else {
    patchText(current, desired.textContent);
  }
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

if (!customElements.get("caffold-task-work-details")) {
  customElements.define("caffold-task-work-details", CaffoldTaskWorkDetails);
}
