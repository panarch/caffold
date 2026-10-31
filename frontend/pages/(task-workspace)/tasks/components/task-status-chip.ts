import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TaskThreadStatus } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { inlineIcon, warmIcons } from "#components/icons.js";
import { taskStatusView } from "../runtime-state.js";

import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./task-status-chip.css.js";

// A spinner turns once in this long; a staggered one starts somewhere along
// the turn.
const SPINNER_TURN_MS = 800;

/**
 * Where a Task stands, in a round slot: a spinner while it runs, an icon while
 * it waits on the person, has failed, or rests with work still running in the
 * background.
 *
 * The host is the chip, so its owner places it by a class of its own and
 * shows it only for a Task that has a status to show (`taskStatusView`). An
 * owner that shows many running Tasks side by side sets `staggered`, so their
 * spinners do not turn in step.
 */
@customElement("caffold-task-status-chip")
export class CaffoldTaskStatusChip extends CaffoldElement {
  @property({ attribute: false })
  accessor task: {
    threadStatus: TaskThreadStatus;
    backgroundWork: boolean;
  } | null = null;
  @property({ type: Boolean })
  accessor staggered = false;

  static override styles = [
    scopedStyle(busySpin, ".task-status-spinner"),
    styles,
  ];

  private spinnerDelayMs: number | null = null;
  private readonly iconsReady = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    if (!this.classList.contains("task-status-chip")) {
      this.classList.add("task-status-chip");
    }
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  // A staggered spinner takes its starting point when the Task starts running
  // and keeps it until the Task stops.
  override willUpdate() {
    if (this.staggered && taskStatusView(this.task)?.status === "running") {
      this.spinnerDelayMs ??= -(Math.random() * (SPINNER_TURN_MS - 1) + 1);
    } else {
      this.spinnerDelayMs = null;
    }
  }

  override render() {
    const view = taskStatusView(this.task);
    if (!view) {
      return nothing;
    }
    if (view.icon) {
      return inlineIcon(view.icon, view.label, "task-status-icon");
    }
    const delay = this.spinnerDelayMs;
    return html`<span
        class="task-status-spinner"
        aria-hidden="true"
        style=${delay === null ? nothing : `animation-delay: ${delay}ms`}
      ></span><span class="sr-only">${view.label}</span>`;
  }

  override updated() {
    const view = taskStatusView(this.task);
    syncAttribute(this, "data-status", view?.status ?? null);
    syncAttribute(this, "title", view?.label ?? null);
    syncAttribute(this, "aria-label", view?.label ?? null);
  }
}

function syncAttribute(element: Element, name: string, value: string | null) {
  if (element.getAttribute(name) === value) {
    return;
  }
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-status-chip": CaffoldTaskStatusChip;
  }
}
