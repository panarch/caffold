import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { activeTurnDuration } from "../active-turn.js";

import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./active-turn.css.js";

// The turn in progress: how long it has run and what it is doing. Its clock
// ticks only while the conversation is on screen.
@customElement("caffold-task-active-turn")
export class CaffoldTaskActiveTurn extends CaffoldElement {
  @property({ attribute: false })
  accessor startedMs: number | null = null;
  @property({ attribute: false })
  accessor state = "Thinking";
  @property({ attribute: false })
  accessor active = true;
  @state()
  private accessor nowMs: number = Date.now();

  static override styles = [
    scopedStyle(busySpin, ".task-active-turn-spinner"),
    styles,
  ];

  private clockTimer: number | null = null;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated) {
      this.syncClock();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.stopClock();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("startedMs") || changed.has("active")) {
      this.syncClock();
    }
  }

  override render() {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-active-turn": CaffoldTaskActiveTurn;
  }
}
