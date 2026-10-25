import { html, LitElement, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
import type { TaskEventPayload } from "#app/api.js";
import { inlineIcon, warmIcons } from "#components/icons.ts";

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
export class CaffoldTaskAssistantMessageSuggestedPrompts extends LitElement {
  static properties = {
    threadId: { attribute: false },
    prompts: { attribute: false },
    disabled: { attribute: false },
  };

  declare threadId: string;
  declare prompts: TaskEventPayload["suggestedPrompts"];
  declare disabled: boolean;
  private offered: SuggestedPrompt[] = [];
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.threadId = "";
    this.prompts = [];
    this.disabled = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // Different requests get new buttons; the same ones arriving again keep the
  // buttons already drawn.
  willUpdate(changed: PropertyValues<this>) {
    if (!changed.has("prompts")) {
      return;
    }
    const offered = suggestedPrompts(this.prompts);
    if (!sameRequests(this.offered, offered)) {
      this.offered = offered;
    }
  }

  render() {
    const icon = inlineIcon(
      "CornerDownRight",
      "",
      "task-suggested-prompt-icon-svg",
    );
    return keyed(
      this.offered,
      this.offered.map(
        ({ label }, index) => html`<button
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

  updated() {
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

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    if (!scopeId || !this.isConnected || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = this.buttons.flatMap((control, index) =>
      isChoosable(control)
        ? [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: `${scopeId}:prompt:${index + 1}`,
              actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              label: control.textContent ?? "",
              control,
              clipRoots: [this, ...clipRoots].filter(Boolean),
              isActionable: () =>
                this.isConnected &&
                !this.hidden &&
                this.buttons[index] === control &&
                isChoosable(control),
            }),
          ]
        : [],
    );
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private get buttons() {
    return Array.from(
      this.querySelectorAll<HTMLButtonElement>(
        ":scope > button[data-suggested-prompt]",
      ),
    );
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

function isChoosable(control: HTMLButtonElement) {
  return !control.disabled && hasActionHintLayoutBox(control);
}

customElements.define(
  "caffold-task-assistant-message-suggested-prompts",
  CaffoldTaskAssistantMessageSuggestedPrompts,
);
