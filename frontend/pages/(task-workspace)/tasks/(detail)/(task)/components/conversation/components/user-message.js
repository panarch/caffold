import { escapeHtml } from "../../../../../../../../components/dom.js";
import { PROMPT_SUBMISSION_STATE } from "../../../../../runtime-state.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../../../../../../../../action-hints.js";
import "./message-attachments.js";

const { UPLOADING, SENDING, ACCEPTED, OUTCOME_UNKNOWN } = PROMPT_SUBMISSION_STATE;

/**
 * A prompt, as the person who sent it typed it.
 *
 * The Composer is a plain textarea, so the text keeps the characters it was
 * typed with; Markdown is the agent's own formatting. Until the agent's history
 * holds the message, its header says how far it has got. While its files go up,
 * each line of its file list carries that file's progress, drawn over the line
 * so the text sits exactly where it will once sent.
 */
class CaffoldTaskUserMessage extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    if (!this.initialized) {
      this.initialized = true;
      this.render();
    }
  }

  /** What to draw, as the conversation currently reports it. */
  setSnapshot(snapshot = {}) {
    this.ensureState();
    const next = messagePresentation(snapshot);
    if (JSON.stringify(next) === JSON.stringify(this.presentation)) {
      return false;
    }
    this.presentation = next;
    if (this.initialized) {
      this.update();
    }
    return true;
  }

  /**
   * How far the message's files have gone up: `percent` for the header and a
   * fraction per listed file. Painted onto the lines already drawn.
   */
  setUploadProgress(progress) {
    this.ensureState();
    this.uploadProgress = progress ?? null;
    if (this.initialized) {
      this.paintDelivery();
    }
  }

  render() {
    this.innerHTML = `
      <div class="task-user-message-header">
        <span class="task-user-message-delivery"></span>
        <time></time>
      </div>
      <caffold-task-message-attachments align-end></caffold-task-message-attachments>
      <div class="task-user-message-content">
        <div class="task-user-message-text"></div>
      </div>
    `;
    this.update();
  }

  update() {
    const { text, attachments, deliveryState, time, uploadLines } =
      this.presentation;
    syncAttribute(this, "data-delivery-state", deliveryState);
    patchText(
      this.querySelector(":scope > .task-user-message-header > time"),
      time,
    );
    const list = this.attachments();
    list.hidden = !attachments.length;
    list.setSnapshot({ attachments });

    const content = this.querySelector(":scope > .task-user-message-content");
    content.hidden = !text;
    const lines = deliveryState === UPLOADING ? uploadLines : [];
    const rendered = JSON.stringify([text, lines]);
    if (this.renderedText !== rendered) {
      this.renderedText = rendered;
      content.querySelector(":scope > .task-user-message-text").innerHTML =
        renderText(text, lines);
    }
    this.paintDelivery();
  }

  paintDelivery() {
    const progress = this.uploadProgress;
    patchText(
      this.querySelector(
        ":scope > .task-user-message-header > .task-user-message-delivery",
      ),
      deliveryLabel(this.presentation.deliveryState, progress),
    );
    for (const line of this.querySelectorAll(
      ":scope > .task-user-message-content > .task-user-message-text > [data-upload-line]",
    )) {
      line.style.setProperty(
        "--upload-progress",
        `${progress?.lines?.[Number(line.dataset.uploadLine)] ?? 0}`,
      );
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    if (!scopeId || this.hidden) {
      return emptyActionHintScope();
    }
    return mergeActionHintScopes(
      this.attachments()?.actionHintScope?.({
        scopeId: `${scopeId}:attachments`,
        clipRoots: [this, ...clipRoots].filter(Boolean),
      }),
    );
  }

  attachments() {
    return this.querySelector(":scope > caffold-task-message-attachments");
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.presentation = messagePresentation();
    this.uploadProgress = null;
  }
}

function messagePresentation(snapshot = {}) {
  return {
    text: `${snapshot.text ?? ""}`,
    attachments: Array.isArray(snapshot.attachments) ? snapshot.attachments : [],
    deliveryState: `${snapshot.deliveryState ?? ""}`,
    time: `${snapshot.time ?? ""}`,
    uploadLines: Array.isArray(snapshot.uploadLines) ? snapshot.uploadLines : [],
  };
}

function deliveryLabel(state, progress) {
  if (state === UPLOADING) {
    return `Uploading ${progress?.percent ?? 0}%`;
  }
  return {
    [SENDING]: "Sending...",
    [ACCEPTED]: "Accepted - syncing...",
    [OUTCOME_UNKNOWN]: "Delivery unconfirmed",
  }[state] ?? "";
}

// The characters of the message, with each listed file on a line of its own
// while it uploads so its bar can sit beneath it.
function renderText(text, lines) {
  const list = lines.map((line) => `- ${line.path}`).join("\n");
  if (!lines.length || !text.endsWith(`\n${list}`)) {
    return escapeHtml(text);
  }
  const head = text.slice(0, text.length - list.length - 1);
  return `${escapeHtml(head)}${lines
    .map(
      (line, index) =>
        `<span class="task-user-message-upload-line" data-upload-line="${index}">${escapeHtml(`- ${line.path}`)}${
          line.done
            ? ""
            : '<span class="task-user-message-upload-bar" aria-hidden="true"></span>'
        }</span>`,
    )
    .join("")}`;
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

if (!customElements.get("caffold-task-user-message")) {
  customElements.define("caffold-task-user-message", CaffoldTaskUserMessage);
}
