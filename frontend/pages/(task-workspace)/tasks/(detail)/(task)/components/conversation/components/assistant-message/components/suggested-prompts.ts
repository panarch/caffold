import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import type { TaskEventPayload } from "#app/api.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

export interface SuggestedPromptIntentDetail {
  threadId: string;
  prompt: string;
}

interface SuggestedPrompt {
  label: string;
  prompt: string;
}

/**
 * The requests an agent offered for the person to send next, one button each.
 *
 * Choosing one asks for its request to be put in the Composer. The Composer
 * belongs to the Task, so this only says which request was chosen and leaves
 * the writing to whoever owns it. The requests cannot be chosen while the
 * Composer they would go to is out of reach.
 */
@customElement("caffold-task-assistant-message-suggested-prompts")
export class CaffoldTaskAssistantMessageSuggestedPrompts extends LitElement {
  @property({ attribute: false })
  accessor threadId = "";
  @property({ attribute: false })
  accessor prompts: TaskEventPayload["suggestedPrompts"] = [];
  @property({ attribute: false })
  accessor disabled = false;

  private offered: SuggestedPrompt[] = [];
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // Different requests get new buttons; the same ones arriving again keep the
  // buttons already drawn.
  override willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("prompts")) {
      return;
    }
    const offered = suggestedPrompts(this.prompts);
    if (!sameRequests(this.offered, offered)) {
      this.offered = offered;
    }
  }

  override render() {
    const icon = inlineIcon(
      "CornerDownRight",
      "",
      "task-suggested-prompt-icon-svg",
    );
    return keyed(
      this.offered,
      this.offered.map(
        ({ label }, index) => html`<button
          ${this.hints.button({
            id: `prompt:${index + 1}`,
            label,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          class="task-suggested-prompt"
          data-suggested-prompt=${index}
          ?disabled=${this.disabled}
          @click=${() => this.choose(index)}
        ><span class="task-suggested-prompt-icon">${icon}</span><span
          class="task-suggested-prompt-label"
        >${label}</span></button>`,
      ),
    );
  }

  override updated() {
    const hidden = this.offered.length === 0;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  choose(index: number) {
    const chosen = this.offered[index];
    if (!chosen || this.disabled) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<SuggestedPromptIntentDetail>(
        "caffold:task-suggested-prompt-intent",
        {
          bubbles: true,
          composed: true,
          detail: { threadId: this.threadId, prompt: chosen.prompt },
        },
      ),
    );
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }
}

function suggestedPrompts(prompts: TaskEventPayload["suggestedPrompts"]) {
  return (Array.isArray(prompts) ? prompts : []).flatMap((entry) => {
    const label = `${entry?.label ?? ""}`;
    const prompt = `${entry?.prompt ?? ""}`;
    return label.trim() && prompt.trim() ? [{ label, prompt }] : [];
  });
}

function sameRequests(left: SuggestedPrompt[], right: SuggestedPrompt[]) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.label === right[index].label &&
        entry.prompt === right[index].prompt,
    )
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-assistant-message-suggested-prompts": CaffoldTaskAssistantMessageSuggestedPrompts;
  }

  interface HTMLElementEventMap {
    "caffold:task-suggested-prompt-intent": CustomEvent<SuggestedPromptIntentDetail>;
  }
}
