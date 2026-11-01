import { html, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { TaskEvent } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  type ToolCallPresentation,
  toolCallPresentation,
} from "./tool-call/model.js";

import styles from "./tool-call.css.js";

export interface ToolCallIntentDetail {
  type: "tool-call-details";
  toolCallKey: string;
}

// One tool the agent called, on one line laid out as a finished command's,
// with what it was given and what came back a dialog away.
@customElement("caffold-task-tool-call")
export class CaffoldTaskToolCall extends CaffoldElement {
  @property({ attribute: false })
  accessor event: TaskEvent | null = null;

  static override styles = styles;

  private presentation: ToolCallPresentation = toolCallPresentation(null);
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("event")) {
      this.presentation = toolCallPresentation(this.event);
    }
  }

  override render() {
    const presentation = this.presentation;
    return html`
      <div class="task-tool-call-summary">
        <span
          class="task-tool-call-summary-status"
          data-tool-call-status=${presentation.status}
        >${presentation.statusLabel}</span>
        <code class="task-tool-call-summary-label">${presentation.name}</code>
        <span
          class="task-tool-call-summary-meta"
          ?hidden=${!presentation.metadata}
        >${presentation.metadata}</span>
        <button
          ${this.hints.button({
            id: "view-details",
            label: "View details",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          class="task-tool-call-summary-action"
          aria-haspopup="dialog"
          @click=${this.requestDetails}
        >View details</button>
      </div>
    `;
  }

  override updated() {
    const { status, tone } = this.presentation;
    if (this.dataset.toolCallStatus !== status) {
      this.dataset.toolCallStatus = status;
    }
    if (this.dataset.toolCallTone !== tone) {
      this.dataset.toolCallTone = tone;
    }
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private requestDetails(event: Event) {
    event.stopPropagation();
    const toolCallKey = this.presentation.key;
    if (!toolCallKey) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ToolCallIntentDetail>("caffold:task-tool-call-intent", {
        bubbles: true,
        composed: true,
        detail: { type: "tool-call-details", toolCallKey },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-tool-call": CaffoldTaskToolCall;
  }

  interface HTMLElementEventMap {
    "caffold:task-tool-call-intent": CustomEvent<ToolCallIntentDetail>;
  }
}
