import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ActionHintPull } from "#app/action-hints.js";
import type { TaskUploadLine } from "#app/api.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import {
  PROMPT_SUBMISSION_STATE,
  type PromptSubmissionState,
} from "#tasks/runtime-state.js";
import "./message-attachments.js";
import type {
  CaffoldTaskMessageAttachments,
  MessageAttachment,
} from "./message-attachments.js";

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
@customElement("caffold-task-user-message")
export class CaffoldTaskUserMessage extends LitElement {
  @property({ attribute: false })
  accessor text = "";
  @property({ attribute: false })
  accessor attachments: MessageAttachment[] = [];
  // `null` once the agent's history holds the message.
  @property({ attribute: false })
  accessor deliveryState: PromptSubmissionState | null = null;
  @property({ attribute: false })
  accessor time = "";
  @property({ attribute: false })
  accessor uploadLines: TaskUploadLine[] = [];
  @property({ attribute: false })
  accessor uploadProgress: UploadProgress | null = null;

  private readonly attachmentList = new DrawnRef<CaffoldTaskMessageAttachments>(
    this,
  );

  override createRenderRoot() {
    return this;
  }

  override render() {
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

  override updated(changed: PropertyValues<this>) {
    if (changed.has("deliveryState")) {
      if (this.deliveryState) {
        this.dataset.deliveryState = this.deliveryState;
      } else {
        delete this.dataset.deliveryState;
      }
    }
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-user-message": CaffoldTaskUserMessage;
  }
}
