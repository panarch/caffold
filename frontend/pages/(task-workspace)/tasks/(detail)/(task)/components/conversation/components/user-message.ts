import { html, LitElement, nothing, type PropertyValues } from "lit";
import type { ActionHintPull } from "#app/action-hints.ts";
import type { TaskUploadLine } from "#app/api.ts";
import { DrawnRef, drawn } from "#components/drawn-refs.ts";
import {
  PROMPT_SUBMISSION_STATE,
  type PromptSubmissionState,
} from "#tasks/runtime-state.ts";
import "./message-attachments.ts";
import type {
  CaffoldTaskMessageAttachments,
  MessageAttachment,
} from "./message-attachments.ts";

const { UPLOADING, SENDING, ACCEPTED, OUTCOME_UNKNOWN } =
  PROMPT_SUBMISSION_STATE;

// How far a message's files have gone up: `percent` for the header and a
// fraction per listed file.
export interface UploadProgress {
  percent?: number;
  lines?: number[];
}

/**
 * A prompt, as the person who sent it typed it.
 *
 * The Composer is a plain textarea, so the text keeps the characters it was
 * typed with; Markdown is the agent's own formatting. Until the agent's history
 * holds the message, its header says how far it has got. While its files go up,
 * each line of its file list carries that file's progress, drawn over the line
 * so the text sits exactly where it will once sent.
 */
export class CaffoldTaskUserMessage extends LitElement {
  static properties = {
    text: { attribute: false },
    attachments: { attribute: false },
    deliveryState: { attribute: false },
    time: { attribute: false },
    uploadLines: { attribute: false },
    uploadProgress: { attribute: false },
  };

  declare text: string;
  declare attachments: MessageAttachment[];
  // `null` once the agent's history holds the message.
  declare deliveryState: PromptSubmissionState | null;
  declare time: string;
  declare uploadLines: TaskUploadLine[];
  declare uploadProgress: UploadProgress | null;
  private readonly attachmentList = new DrawnRef<CaffoldTaskMessageAttachments>(
    this,
  );

  constructor() {
    super();
    this.text = "";
    this.attachments = [];
    this.deliveryState = null;
    this.time = "";
    this.uploadLines = [];
    this.uploadProgress = null;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const lines = this.deliveryState === UPLOADING ? this.uploadLines : [];
    return html`
      <div class="task-user-message-header">
        <span class="task-user-message-delivery">${deliveryLabel(
          this.deliveryState,
          this.uploadProgress,
        )}</span>
        <time>${this.time}</time>
      </div>
      <caffold-task-message-attachments
        ${drawn(this.attachmentList)}
        align-end
        ?hidden=${!this.attachments.length}
        .attachments=${this.attachments}
      ></caffold-task-message-attachments>
      <div class="task-user-message-content" ?hidden=${!this.text}>
        <div class="task-user-message-text">${messageText(
          this.text,
          lines,
          this.uploadProgress,
        )}</div>
      </div>
    `;
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has("deliveryState")) {
      if (this.deliveryState) {
        this.dataset.deliveryState = this.deliveryState;
      } else {
        delete this.dataset.deliveryState;
      }
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
    this.performUpdate();
    return this.attachmentList.value?.actionHintScope({
      scopeId: `${scopeId}:attachments`,
      clipRoots: [this, ...clipRoots],
    });
  }
}

function deliveryLabel(
  state: PromptSubmissionState | null,
  progress: UploadProgress | null,
) {
  switch (state) {
    case UPLOADING:
      return `Uploading ${progress?.percent ?? 0}%`;
    case SENDING:
      return "Sending...";
    case ACCEPTED:
      return "Accepted - syncing...";
    case OUTCOME_UNKNOWN:
      return "Delivery unconfirmed";
    default:
      return "";
  }
}

// The characters of the message, with each listed file on a line of its own
// while it uploads so its bar can sit beneath it.
function messageText(
  text: string,
  lines: TaskUploadLine[],
  progress: UploadProgress | null,
) {
  const list = lines.map((line) => `- ${line.path}`).join("\n");
  if (!lines.length || !text.endsWith(`\n${list}`)) {
    return text;
  }
  const head = text.slice(0, text.length - list.length - 1);
  return html`${head}${lines.map(
    (line, index) => html`<span
      class="task-user-message-upload-line"
      data-upload-line=${index}
      style="--upload-progress: ${progress?.lines?.[index] ?? 0}"
    >- ${line.path}${
      line.done
        ? nothing
        : html`<span
            class="task-user-message-upload-bar"
            aria-hidden="true"
          ></span>`
    }</span>`,
  )}`;
}

customElements.define("caffold-task-user-message", CaffoldTaskUserMessage);
