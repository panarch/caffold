import { html, LitElement, type PropertyValues } from "lit";
import { busySpin } from "#app/component-styles.ts";
import { activeTurnDuration } from "../active-turn.ts";

// The turn in progress: how long it has run and what it is doing. Its clock
// ticks only while the conversation is on screen.
export class CaffoldTaskActiveTurn extends LitElement {
  static properties = {
    startedMs: { attribute: false },
    state: { attribute: false },
    active: { attribute: false },
    nowMs: { state: true },
  };

  declare startedMs: number | null;
  declare state: string;
  declare active: boolean;
  declare private nowMs: number;
  private clockTimer: number | null = null;

  constructor() {
    super();
    this.startedMs = null;
    this.state = "Thinking";
    this.active = true;
    this.nowMs = Date.now();
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.syncClock();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.stopClock();
  }

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("startedMs") || changed.has("active")) {
      this.syncClock();
    }
  }

  render() {
    return html`
      <span class="task-active-turn-spinner" aria-hidden="true"></span>
      <span class="task-turn-active-duration">${activeTurnDuration(
        this.startedMs,
        this.nowMs,
      )}</span>
      <span
        class="task-turn-active-state"
        aria-live="polite"
        title=${this.state}
      >${this.state}</span>
    `;
  }

  private syncClock() {
    if (!this.isConnected || !this.active) {
      this.stopClock();
      return;
    }
    this.nowMs = Date.now();
    if (!this.startedMs) {
      this.stopClock();
    } else if (this.clockTimer === null) {
      this.clockTimer = window.setInterval(() => {
        this.nowMs = Date.now();
      }, 1_000);
    }
  }

  private stopClock() {
    window.clearInterval(this.clockTimer ?? undefined);
    this.clockTimer = null;
  }
}

await busySpin.register(
  "caffold-task-active-turn",
  "> .task-active-turn-spinner",
);

customElements.define("caffold-task-active-turn", CaffoldTaskActiveTurn);
