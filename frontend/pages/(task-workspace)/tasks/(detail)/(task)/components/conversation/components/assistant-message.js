import { assistantMessagePhase } from "#tasks/task-events.js";
import { formatDate, taskEventObservedMs } from "#tasks/task-format.js";
import "./markdown.js";
import "./assistant-message/components/copy-button.js";
import "./assistant-message/components/suggested-prompts.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { emptyScrollSurfaceScope } from "#app/scroll-scope.js";

/**
 * What the agent said, drawn the same way wherever the conversation shows it.
 *
 * A turn in progress lists its messages inline and a finished turn folds them
 * into its work details, but that is a difference in where the message is
 * placed. Owning the card here is what keeps the message from changing shape
 * when its turn ends, and what gives every message the same Copy control
 * beside its time.
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
      <div class="task-assistant-message-header">
        <time></time>
        <caffold-task-assistant-message-copy-button></caffold-task-assistant-message-copy-button>
      </div>
      <div class="task-assistant-message-body">
        <caffold-task-markdown></caffold-task-markdown>
      </div>
      <caffold-task-assistant-message-suggested-prompts></caffold-task-assistant-message-suggested-prompts>
    `;
    this.update();
  }

  update() {
    const {
      text,
      time,
      threadId,
      fileLinks,
      phase,
      suggestedPrompts,
      controlsDisabled,
    } = this.presentation;
    syncAttribute(this, "data-message-phase", phase);
    patchText(
      this.querySelector(":scope > .task-assistant-message-header > time"),
      time,
    );
    this.copyButton().setText(text);
    // A message of suggestions alone has no text to copy.
    this.copyButton().hidden = !text.trim();
    this.suggestedPrompts().setSnapshot({
      threadId,
      prompts: suggestedPrompts,
      disabled: controlsDisabled,
    });

    // The markdown element reads these while it parses, so a change to any of
    // them has to reach it before the text does.
    const markdown = this.markdown();
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
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    const childClipRoots = [this, ...clipRoots].filter(Boolean);
    return mergeActionHintScopes(
      this.copyButton()?.actionHintScope?.({
        scopeId: `${scopeId}:copy-button`,
        clipRoots: childClipRoots,
      }),
      this.markdown()?.actionHintScope?.({
        scopeId: `${scopeId}:markdown`,
        clipRoots: childClipRoots,
      }),
      this.suggestedPrompts()?.actionHintScope?.({
        scopeId: `${scopeId}:suggested-prompts`,
        clipRoots: childClipRoots,
      }),
    );
  }

  scrollSurfaceScope({ scopeId = "", clipRoots = [], isCurrent } = {}) {
    const markdown = this.markdown();
    const parentIsCurrent = typeof isCurrent === "function"
      ? isCurrent
      : () => true;
    return scopeId && markdown && !this.hidden
      ? markdown.scrollSurfaceScope?.({
          scopeId: `${scopeId}:markdown`,
          clipRoots: [this, ...clipRoots].filter(Boolean),
          isCurrent: () =>
            this.isConnected &&
            !this.hidden &&
            parentIsCurrent() &&
            this.markdown() === markdown,
        }) ?? emptyScrollSurfaceScope()
      : emptyScrollSurfaceScope();
  }

  copyButton() {
    return this.querySelector(
      ":scope > .task-assistant-message-header > caffold-task-assistant-message-copy-button",
    );
  }

  markdown() {
    return this.querySelector(
      ":scope > .task-assistant-message-body > caffold-task-markdown",
    );
  }

  suggestedPrompts() {
    return this.querySelector(
      ":scope > caffold-task-assistant-message-suggested-prompts",
    );
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
  const turnCompletedMs = Number.isFinite(snapshot.turnCompletedMs)
    ? snapshot.turnCompletedMs
    : null;
  const timeMs = observedMs ?? turnCompletedMs;
  const fileLinks = Array.isArray(event.fileLinks) ? event.fileLinks : [];
  return {
    text: `${payload.text ?? ""}`,
    time: timeMs === null ? "" : formatDate(timeMs),
    threadId: `${event.threadId ?? payload.threadId ?? ""}`.trim(),
    fileLinks: fileLinks.length ? JSON.stringify(fileLinks) : "",
    phase: assistantMessagePhase(snapshot.phase ?? payload.phase) ?? "",
    suggestedPrompts: Array.isArray(payload.suggestedPrompts)
      ? payload.suggestedPrompts
      : [],
    controlsDisabled: Boolean(snapshot.controlsDisabled),
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
      left.phase === right.phase &&
      JSON.stringify(left.suggestedPrompts) ===
        JSON.stringify(right.suggestedPrompts) &&
      left.controlsDisabled === right.controlsDisabled,
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
