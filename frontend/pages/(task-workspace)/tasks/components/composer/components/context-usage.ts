import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";

// How full a Task's context is, as its agent last said.
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
}

const tokenCount = new Intl.NumberFormat("en-US");
let contextUsageInstanceId = 0;

/**
 * How full the Task's context is, as its agent last said, with the numbers
 * behind the pie one press away. A pie rather than a ring, because a partly
 * drawn ring beside the microphone reads as its busy spinner.
 */
@customElement("caffold-task-context-usage")
export class CaffoldTaskContextUsage extends LitElement {
  @state()
  private accessor usage: ContextUsage | null = null;

  private readonly popoverId = `task-context-usage-${++contextUsageInstanceId}`;
  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  // What the agent last reported, or null until it says. A count that is not
  // a share of a window reads as not reported.
  setSnapshot(
    context: { usedTokens?: unknown; windowTokens?: unknown } | null,
  ) {
    const next = normalizedContext(context);
    if (sameContext(this.usage, next)) {
      return;
    }
    this.usage = next;
  }

  override render() {
    const view = contextView(this.usage);
    return html`
      <button
        ${this.hints.button({
          id: "context-usage",
          label: view.label,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="task-context-usage-button"
        popovertarget=${this.popoverId}
        aria-label=${view.label}
        title=${view.label}
      >
        <svg
          class="task-context-usage-pie"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            class="task-context-usage-outline"
            cx="12"
            cy="12"
            r="9"
          ></circle>
          <path
            class="task-context-usage-fill"
            d=${wedgePath(view.fill)}
          ></path>
        </svg>
      </button>
      <div
        id=${this.popoverId}
        class="task-context-usage-popover"
        popover="auto"
        aria-label="Context usage"
      >${
        view.known
          ? html`<dl>
              <div>
                <dt>Used</dt>
                <dd data-context-usage-field="used">${view.used}</dd>
              </div>
              <div>
                <dt>Window</dt>
                <dd data-context-usage-field="window">${view.window}</dd>
              </div>
            </dl>`
          : html`<p>Not reported yet.</p>`
      }</div>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }
}

function contextView(context: ContextUsage | null) {
  if (!context) {
    return {
      known: false,
      fill: 0,
      label: "Context usage: not reported yet",
      used: "",
      window: "",
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

// Filled clockwise from twelve o'clock. With the stylesheet's rounded 1.5
// edge the wedge reaches 6, short of the ring's inner edge at 8.
const WEDGE_RADIUS = 5.25;

function wedgePath(percent: number) {
  if (percent <= 0) {
    return "";
  }
  const top = `12 ${12 - WEDGE_RADIUS}`;
  const arc = `A${WEDGE_RADIUS} ${WEDGE_RADIUS} 0`;
  if (percent >= 100) {
    return `M${top}${arc} 1 1 12 ${12 + WEDGE_RADIUS}${arc} 1 1 ${top}Z`;
  }
  const angle = (percent / 100) * 2 * Math.PI;
  const x = round(12 + WEDGE_RADIUS * Math.sin(angle));
  const y = round(12 - WEDGE_RADIUS * Math.cos(angle));
  return `M12 12L${top}${arc} ${percent > 50 ? 1 : 0} 1 ${x} ${y}Z`;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function normalizedContext(
  context: { usedTokens?: unknown; windowTokens?: unknown } | null,
): ContextUsage | null {
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

function sameContext(left: ContextUsage | null, right: ContextUsage | null) {
  return (
    left?.usedTokens === right?.usedTokens &&
    left?.windowTokens === right?.windowTokens
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-context-usage": CaffoldTaskContextUsage;
  }
}
