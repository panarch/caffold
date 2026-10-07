import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";

const drawnIcons = new WeakMap();

/**
 * The requests an agent offered for the person to send next, one button each.
 *
 * Choosing one asks for its request to be put in the Composer. The Composer
 * belongs to the Task, so this only says which request was chosen and leaves
 * the writing to whoever owns it.
 */
class CaffoldTaskAssistantMessageSuggestedPrompts extends HTMLElement {
  constructor() {
    super();
    this.threadId = "";
    this.prompts = [];
    this.disabled = false;
    this.renderedPrompts = null;
    this.boundClick = (event) => this.handleClick(event);
  }

  connectedCallback() {
    if (!this.connected) {
      this.connected = true;
      this.addEventListener("click", this.boundClick);
      void warmIcons().then(() => {
        if (this.connected) {
          this.patchIcons();
        }
      });
    }
    this.patch();
  }

  disconnectedCallback() {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.removeEventListener("click", this.boundClick);
  }

  /**
   * The requests to offer, and whether they can be chosen now. They cannot
   * while the Composer they would go to is out of reach.
   */
  setSnapshot({ threadId = "", prompts = [], disabled = false } = {}) {
    const next = suggestedPrompts(prompts);
    const nextThreadId = `${threadId ?? ""}`;
    const nextDisabled = Boolean(disabled);
    const samePrompts = sameRequests(this.prompts, next);
    if (
      this.threadId === nextThreadId &&
      this.disabled === nextDisabled &&
      samePrompts
    ) {
      return false;
    }
    this.threadId = nextThreadId;
    // The buttons are rebuilt only for different requests, so the same ones
    // arriving again keep the buttons already drawn.
    if (!samePrompts) {
      this.prompts = next;
    }
    this.disabled = nextDisabled;
    this.patch();
    return true;
  }

  handleClick(event) {
    const control = event.target.closest?.("button[data-suggested-prompt]");
    if (!control || !this.contains(control) || control.disabled) {
      return;
    }
    const chosen = this.prompts[Number(control.dataset.suggestedPrompt)];
    if (!chosen) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("caffold:task-suggested-prompt-intent", {
        bubbles: true,
        composed: true,
        detail: { threadId: this.threadId, prompt: chosen.prompt },
      }),
    );
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    if (!scopeId || !this.connected || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = this.buttons().flatMap((control, index) =>
      isChoosable(control)
        ? [buttonActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:prompt:${index + 1}`,
            actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            label: control.textContent,
            control,
            clipRoots: [this, ...clipRoots].filter(Boolean),
            isActionable: () =>
              this.connected &&
              this.isConnected &&
              !this.hidden &&
              this.buttons()[index] === control &&
              isChoosable(control),
          })]
        : []
    );
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  patch() {
    this.hidden = this.prompts.length === 0;
    if (this.renderedPrompts !== this.prompts) {
      this.renderedPrompts = this.prompts;
      this.replaceChildren(
        ...this.prompts.map(({ label }, index) => {
          const control = document.createElement("button");
          control.type = "button";
          control.className = "task-suggested-prompt";
          control.dataset.suggestedPrompt = `${index}`;
          const icon = document.createElement("span");
          icon.className = "task-suggested-prompt-icon";
          const name = document.createElement("span");
          name.className = "task-suggested-prompt-label";
          name.textContent = label;
          control.append(icon, name);
          return control;
        }),
      );
      this.patchIcons();
    }
    for (const control of this.buttons()) {
      control.disabled = this.disabled;
    }
  }

  // The arrow is drawn again once the icon set has loaded, as the Copy icon is.
  patchIcons() {
    const icon = renderInlineIcon(
      "CornerDownRight",
      "",
      "task-suggested-prompt-icon-svg",
    );
    for (const slot of this.querySelectorAll(
      ":scope > button > .task-suggested-prompt-icon",
    )) {
      if (drawnIcons.get(slot) !== icon) {
        drawnIcons.set(slot, icon);
        slot.innerHTML = icon;
      }
    }
  }

  buttons() {
    return Array.from(
      this.querySelectorAll(":scope > button[data-suggested-prompt]"),
    );
  }
}

function suggestedPrompts(prompts) {
  return (Array.isArray(prompts) ? prompts : []).flatMap((entry) => {
    const label = `${entry?.label ?? ""}`;
    const prompt = `${entry?.prompt ?? ""}`;
    return label.trim() && prompt.trim() ? [{ label, prompt }] : [];
  });
}

function sameRequests(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.label === right[index].label &&
        entry.prompt === right[index].prompt,
    )
  );
}

function isChoosable(control) {
  return !control.disabled && hasActionHintLayoutBox(control);
}

if (!customElements.get("caffold-task-assistant-message-suggested-prompts")) {
  customElements.define(
    "caffold-task-assistant-message-suggested-prompts",
    CaffoldTaskAssistantMessageSuggestedPrompts,
  );
}
