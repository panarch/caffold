import { TASK_ABSENCE } from "#app/api.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import { renderInlineIcon, warmIcons } from "#components/icons.js";

export const TASK_ABSENCE_INTENT_EVENT = "caffold:task-absence-intent";

// What a Task surface shows in place of a Task that is archived or that
// Caffold cannot find, laid out like Task Recovery. An archived Task offers
// Restore; its owner sends the request and hands back how it went.
class CaffoldTaskAbsence extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    if (this.snapshot) {
      this.update();
    }
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.boundIconsReady = () => {
      if (this.snapshot) {
        this.refreshIcons();
      }
    };
    warmIcons();
    this.innerHTML = `
      <section class="task-absence-view">
        <header class="task-absence-header">
          <h2></h2>
        </header>
        <div class="task-absence-body">
          <div class="task-absence-content">
            <div class="task-absence-heading" role="status">
              <span class="task-absence-icon-slot"></span>
              <h3></h3>
            </div>
            <div class="task-absence-description"></div>
            <div class="task-absence-actions">
              <button type="button" class="task-secondary-button" data-task-absence-action="restore">
                <span class="task-absence-action-icon-slot"></span>
                <span>Restore</span>
              </button>
            </div>
            <div class="task-absence-feedback" aria-live="polite">
              <p class="task-absence-progress" role="status" hidden>Restoring Task…</p>
              <p class="task-absence-error" role="alert" hidden></p>
            </div>
          </div>
        </div>
      </section>
    `;
    this.addEventListener("click", (event) => {
      const control = event.target instanceof Element
        ? event.target.closest("[data-task-absence-action]")
        : null;
      if (!control || !this.contains(control) || control.disabled) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent(TASK_ABSENCE_INTENT_EVENT, {
          bubbles: true,
          composed: true,
          detail: { type: control.dataset.taskAbsenceAction },
        }),
      );
    });
  }

  // absence: TASK_ABSENCE. title: the Task's title when its owner knew it.
  // restoring: the owner's Restore request is running. error: why the last
  // Restore failed.
  setSnapshot({ absence, title = "", restoring = false, error = null } = {}) {
    const next = {
      absence,
      title: `${title ?? ""}`.trim(),
      restoring: Boolean(restoring),
      message: `${error?.message ?? ""}`,
    };
    const current = this.snapshot;
    if (
      current?.absence === next.absence &&
      current.title === next.title &&
      current.restoring === next.restoring &&
      current.message === next.message
    ) {
      return;
    }
    const absenceChanged = current?.absence !== next.absence;
    this.snapshot = next;
    if (this.rendered) {
      this.update({ icons: absenceChanged });
    }
  }

  update({ icons = true } = {}) {
    const { absence, title, restoring, message } = this.snapshot;
    const copy = COPY[absence];
    this.querySelector(".task-absence-header h2").textContent =
      title || "Unavailable Task";
    this.querySelector(".task-absence-heading h3").textContent = copy.heading;
    const description = this.querySelector(".task-absence-description");
    if (description.dataset.absence !== absence) {
      description.dataset.absence = absence;
      description.replaceChildren(
        ...copy.messages.map((text) => {
          const paragraph = document.createElement("p");
          paragraph.textContent = text;
          return paragraph;
        }),
      );
    }
    const restore = this.restoreButton();
    restore.parentElement.hidden = absence !== TASK_ABSENCE.ARCHIVED;
    restore.disabled = restoring;
    this.querySelector(".task-absence-progress").hidden = !restoring;
    const error = this.querySelector(".task-absence-error");
    error.textContent = message;
    error.hidden = !message;
    if (icons) {
      this.refreshIcons();
    }
  }

  refreshIcons() {
    const copy = COPY[this.snapshot.absence];
    this.querySelector(".task-absence-icon-slot").innerHTML = renderInlineIcon(
      copy.icon,
      copy.heading,
      "task-absence-icon",
    );
    this.querySelector(".task-absence-action-icon-slot").innerHTML =
      renderInlineIcon("ArchiveRestore", "Restore", "task-action-icon");
  }

  actionHintScope({ scopeId, clipRoots = [] } = {}) {
    const control = this.restoreButton();
    if (
      !this.isConnected ||
      this.hidden ||
      !control ||
      control.parentElement.hidden ||
      control.disabled ||
      !hasActionHintLayoutBox(control)
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:restore`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: "Restore",
          control,
          clipRoots: [this, ...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.restoreButton() === control &&
            !control.parentElement.hidden &&
            !control.disabled &&
            hasActionHintLayoutBox(control),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  restoreButton() {
    return this.querySelector('[data-task-absence-action="restore"]');
  }
}

const COPY = Object.freeze({
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
});

if (!customElements.get("caffold-task-absence")) {
  customElements.define("caffold-task-absence", CaffoldTaskAbsence);
}
