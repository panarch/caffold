// How full the Task's context is, as its agent last said, with the numbers
// behind the pie one press away. A pie rather than a ring, because a partly
// drawn ring beside the microphone reads as its busy spinner.

import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";

const tokenCount = new Intl.NumberFormat("en-US");
let contextUsageInstanceId = 0;

class CaffoldTaskContextUsage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  // `context` is `{ usedTokens, windowTokens }`, or null until the agent says.
  setSnapshot(context = null) {
    this.ensureRendered();
    const next = normalizedContext(context);
    if (sameContext(this.context, next)) {
      return;
    }
    this.context = next;
    this.patch();
  }

  // The pie's place in Action Hints, beside the Composer's other buttons.
  actionHintTarget({ scopeId, clipRoots = [] } = {}) {
    const control = this.button();
    if (!control || !scopeId || this.hidden || !hasActionHintLayoutBox(control)) {
      return null;
    }
    return buttonActionHintTarget({
      invalidationOwner: this,
      id: `task-composer:${scopeId}:context-usage`,
      actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      label: control.getAttribute("aria-label"),
      control,
      clipRoots: [...clipRoots],
      isActionable: () =>
        this.isConnected &&
        !this.hidden &&
        this.button() === control &&
        hasActionHintLayoutBox(control),
    });
  }

  button() {
    return this.querySelector(":scope > .task-context-usage-button");
  }

  ensureRendered() {
    if (this.button()) {
      return;
    }
    contextUsageInstanceId += 1;
    const popoverId = `task-context-usage-${contextUsageInstanceId}`;
    this.context ??= null;
    this.innerHTML = `
      <button
        type="button"
        class="task-context-usage-button"
        popovertarget="${popoverId}"
      >
        <svg class="task-context-usage-pie" viewBox="0 0 24 24" aria-hidden="true">
          <circle class="task-context-usage-outline" cx="12" cy="12" r="9"></circle>
          <circle class="task-context-usage-fill" cx="12" cy="12" r="4.5" pathLength="100"></circle>
        </svg>
      </button>
      <div
        id="${popoverId}"
        class="task-context-usage-popover"
        popover="auto"
        aria-label="Context usage"
      ></div>
    `;
    this.renderedKnown = null;
    this.patch();
  }

  patch() {
    const button = this.button();
    const popover = this.querySelector(":scope > .task-context-usage-popover");
    const view = contextView(this.context);
    button.style.setProperty("--task-context-used", `${view.fill}`);
    button.setAttribute("aria-label", view.label);
    button.title = view.label;
    if (this.renderedKnown !== view.known) {
      this.renderedKnown = view.known;
      popover.innerHTML = view.known
        ? `<dl>
            <div><dt>Used</dt><dd data-context-usage-field="used"></dd></div>
            <div><dt>Window</dt><dd data-context-usage-field="window"></dd></div>
          </dl>`
        : `<p>Not reported yet.</p>`;
    }
    if (view.known) {
      setText(popover.querySelector('[data-context-usage-field="used"]'), view.used);
      setText(popover.querySelector('[data-context-usage-field="window"]'), view.window);
    }
  }
}

function contextView(context) {
  if (!context) {
    return {
      known: false,
      fill: 0,
      label: "Context usage: not reported yet",
    };
  }
  const percent = Math.round((context.usedTokens / context.windowTokens) * 100);
  return {
    known: true,
    // An agent can count past its window; the pie stops at full.
    fill: Math.min(percent, 100),
    label: `Context usage: ${percent}%`,
    used: `${tokenCount.format(context.usedTokens)} tokens (${percent}%)`,
    window: `${tokenCount.format(context.windowTokens)} tokens`,
  };
}

function normalizedContext(context) {
  const usedTokens = Number(context?.usedTokens);
  const windowTokens = Number(context?.windowTokens);
  if (
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(windowTokens) ||
    usedTokens < 0 ||
    windowTokens <= 0
  ) {
    return null;
  }
  return { usedTokens, windowTokens };
}

function sameContext(left, right) {
  return (
    left?.usedTokens === right?.usedTokens &&
    left?.windowTokens === right?.windowTokens
  );
}

function setText(element, value) {
  if (element && element.textContent !== value) {
    element.textContent = value;
  }
}

if (!customElements.get("caffold-task-context-usage")) {
  customElements.define("caffold-task-context-usage", CaffoldTaskContextUsage);
}
