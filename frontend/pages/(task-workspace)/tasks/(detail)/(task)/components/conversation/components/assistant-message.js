import { assistantMessagePhase } from "../../../../../task-events.js";
import { formatDate, taskEventObservedMs } from "../../../../../task-format.js";
import "./markdown.js";
import { emptyActionHintScope } from "../../../../../../action-hints.js";

/**
 * What the agent said, drawn the same way wherever the conversation shows it.
 *
 * A turn in progress lists its messages inline and a finished turn folds them
 * into its work details, but that is a difference in where the message is
 * placed. Owning the card here is what keeps the message from changing shape
 * when its turn ends.
 */
class CaffoldTaskAssistantMessage extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.initialized) {
      this.initialized = true;
      this.render();
    }
  }

  /**
   * What to draw, as the conversation currently reports it.
   *
   * `phase` is the caller's, not the event's: which message answers a turn is
   * decided by the surface placing it, and Claude does not mark one itself.
   */
  setSnapshot(snapshot = {}) {
    this.ensureState();
    const next = messagePresentation(snapshot);
    if (sameMessagePresentation(this.presentation, next)) {
      return false;
    }
    this.presentation = next;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  render() {
    this.innerHTML = `
      <div class="task-assistant-message-header"><time></time></div>
      <div class="task-assistant-message-body">
        <caffold-task-markdown></caffold-task-markdown>
      </div>
    `;
    this.update();
  }

  update() {
    const { text, time, threadId, fileLinks, phase } = this.presentation;
    syncAttribute(this, "data-message-phase", phase);
    patchText(
      this.querySelector(":scope > .task-assistant-message-header > time"),
      time,
    );

    // The markdown element reads these while it parses, so a change to any of
    // them has to reach it before the text does.
    const markdown = this.querySelector(
      ":scope > .task-assistant-message-body > caffold-task-markdown",
    );
    syncAttribute(markdown, "thread-id", threadId);
    syncAttribute(markdown, "file-links", fileLinks);
    markdown.toggleAttribute("code-block-controls", phase === "final");
    // Parsing is the expensive part, so it waits for something the parse
    // itself reads to change.
    const rendered = JSON.stringify([phase, threadId, fileLinks, text]);
    if (this.renderedMarkdown !== rendered) {
      this.renderedMarkdown = rendered;
      markdown.setMarkdown(text);
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    const markdown = this.querySelector(
      ":scope > .task-assistant-message-body > caffold-task-markdown",
    );
    return scopeId && markdown && !this.hidden
      ? markdown.actionHintScope?.({
          scopeId: `${scopeId}:markdown`,
          clipRoots: [this, ...clipRoots].filter(Boolean),
        }) ?? emptyActionHintScope()
      : emptyActionHintScope();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.presentation = messagePresentation();
  }
}

function messagePresentation(snapshot = {}) {
  const event = snapshot.event ?? {};
  const payload = event.payload ?? {};
  const observedMs = taskEventObservedMs(event);
  const fileLinks = Array.isArray(event.fileLinks) ? event.fileLinks : [];
  return {
    text: `${payload.text ?? ""}`,
    time: observedMs === null ? "" : formatDate(observedMs),
    threadId: `${event.threadId ?? payload.threadId ?? ""}`.trim(),
    fileLinks: fileLinks.length ? JSON.stringify(fileLinks) : "",
    phase: assistantMessagePhase(snapshot.phase ?? payload.phase) ?? "",
  };
}

function sameMessagePresentation(left, right) {
  return Boolean(
    left &&
      right &&
      left.text === right.text &&
      left.time === right.time &&
      left.threadId === right.threadId &&
      left.fileLinks === right.fileLinks &&
      left.phase === right.phase,
  );
}

function syncAttribute(element, name, value) {
  if (value) {
    if (element.getAttribute(name) !== value) {
      element.setAttribute(name, value);
    }
  } else if (element.hasAttribute(name)) {
    element.removeAttribute(name);
  }
}

function patchText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

if (!customElements.get("caffold-task-assistant-message")) {
  customElements.define(
    "caffold-task-assistant-message",
    CaffoldTaskAssistantMessage,
  );
}
