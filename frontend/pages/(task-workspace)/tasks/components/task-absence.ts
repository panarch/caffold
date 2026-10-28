import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { TASK_ABSENCE, type TaskAbsence } from "#app/api.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import secondaryButton from "#app/component-styles/secondary-button.css.js";
import actionIcon from "#tasks/component-styles/action-icon.css.js";
import styles from "./task-absence.css.js";

export const TASK_ABSENCE_INTENT_EVENT = "caffold:task-absence-intent";

// What the owner shows: why the Task is absent, its title when known, whether
// the owner's Restore request is running, and why the last one failed.
export interface TaskAbsenceSnapshot {
  absence: TaskAbsence;
  title?: string | null;
  restoring?: boolean;
  error?: { message?: string } | null;
}

export interface TaskAbsenceIntent {
  type: "restore";
}

const COPY: Readonly<
  Record<TaskAbsence, { icon: string; heading: string; messages: string[] }>
> = {
  [TASK_ABSENCE.ARCHIVED]: {
    icon: "Archive",
    heading: "Task archived",
    messages: [
      "This Task was archived.",
      "Restore it to open its conversation again.",
    ],
  },
  [TASK_ABSENCE.NOT_FOUND]: {
    icon: "TriangleAlert",
    heading: "Task not found",
    messages: [
      "Caffold has no record of this Task.",
      "It may have been deleted, or the link may be wrong.",
    ],
  },
};

/**
 * What a Task surface shows in place of a Task that is archived or that
 * Caffold cannot find, laid out like Task Recovery. An archived Task offers
 * Restore; its owner sends the request and hands back how it went.
 */
@customElement("caffold-task-absence")
export class CaffoldTaskAbsence extends CaffoldElement {
  @state()
  private accessor snapshot: TaskAbsenceSnapshot | null = null;

  static override styles = [
    scopedStyle(secondaryButton, ".task-secondary-button"),
    scopedStyle(actionIcon, ".task-action-icon"),
    styles,
  ];

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setSnapshot(snapshot: TaskAbsenceSnapshot) {
    this.snapshot = snapshot;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  override render() {
    const snapshot = this.snapshot;
    const copy = snapshot ? COPY[snapshot.absence] : null;
    const restoring = Boolean(snapshot?.restoring);
    const message = `${snapshot?.error?.message ?? ""}`;
    const title = snapshot
      ? `${snapshot.title ?? ""}`.trim() || "Unavailable Task"
      : "";
    return html`<section class="task-absence-view">
      <header class="task-absence-header">
        <h2>${title}</h2>
      </header>
      <div class="task-absence-body">
        <div class="task-absence-content">
          <div class="task-absence-heading" role="status">
            <span class="task-absence-icon-slot">${
              copy
                ? inlineIcon(copy.icon, copy.heading, "task-absence-icon")
                : nothing
            }</span>
            <h3>${copy?.heading ?? ""}</h3>
          </div>
          <div class="task-absence-description">${copy?.messages.map(
            (text) => html`<p>${text}</p>`,
          )}</div>
          <div
            class="task-absence-actions"
            ?hidden=${snapshot?.absence !== TASK_ABSENCE.ARCHIVED}
          >
            <button
              ${this.hints.button({
                id: "restore",
                label: "Restore",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              class="task-secondary-button"
              data-task-absence-action="restore"
              ?disabled=${restoring}
              @click=${this.requestRestore}
            >
              <span class="task-absence-action-icon-slot">${
                copy
                  ? inlineIcon("ArchiveRestore", "Restore", "task-action-icon")
                  : nothing
              }</span>
              <span>Restore</span>
            </button>
          </div>
          <div class="task-absence-feedback" aria-live="polite">
            <p class="task-absence-progress" role="status" ?hidden=${!restoring}
              >Restoring Task…</p
            >
            <p class="task-absence-error" role="alert" ?hidden=${!message}
              >${message}</p
            >
          </div>
        </div>
      </div>
    </section>`;
  }

  private requestRestore() {
    this.dispatchEvent(
      new CustomEvent<TaskAbsenceIntent>(TASK_ABSENCE_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { type: "restore" },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-absence": CaffoldTaskAbsence;
  }

  interface HTMLElementEventMap {
    [TASK_ABSENCE_INTENT_EVENT]: CustomEvent<TaskAbsenceIntent>;
  }
}
