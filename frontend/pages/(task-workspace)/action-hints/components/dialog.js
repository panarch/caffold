import { clampBadgePosition } from "../model.js";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "../control.js";

class CaffoldActionHintDialog extends HTMLElement {
  connectedCallback() {
    this.ensureState();
    this.ensureRendered();
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.dialog.addEventListener("click", this.boundClick);
    this.dialog.addEventListener("cancel", this.boundCancel);
    this.dialog.addEventListener("wheel", this.boundWheel, { passive: false });
    this.dialog.addEventListener("touchmove", this.boundTouchMove, {
      passive: false,
    });
  }

  disconnectedCallback() {
    if (!this.listenersAttached) {
      return;
    }
    this.listenersAttached = false;
    this.dialog.removeEventListener("click", this.boundClick);
    this.dialog.removeEventListener("cancel", this.boundCancel);
    this.dialog.removeEventListener("wheel", this.boundWheel);
    this.dialog.removeEventListener("touchmove", this.boundTouchMove);
    if (this.dialog.open) {
      this.dialog.close();
    }
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.targets = [];
    this.viewportRect = null;
    this.boundClick = (event) => this.handleClick(event);
    this.boundCancel = (event) => {
      event.preventDefault();
      this.dispatchCancel("escape", event);
    };
    this.boundWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
      }
    };
    this.boundTouchMove = (event) => {
      if (event.touches.length < 2) {
        event.preventDefault();
      }
    };
  }

  ensureRendered() {
    this.ensureState();
    if (this.querySelector(":scope > dialog")) {
      return;
    }
    this.innerHTML = `
      <dialog
        class="action-hint-dialog"
        aria-labelledby="action-hint-title"
        aria-describedby="action-hint-description"
        tabindex="-1"
      >
        <div class="action-hint-instructions">
          <span id="action-hint-title">Action Hints</span>
          <span id="action-hint-description">Type a shown code, or press Escape to cancel.</span>
          <output class="action-hint-input-status" aria-live="polite"></output>
        </div>
        <div class="action-hint-badges"></div>
      </dialog>
    `;
    this.dialog = this.querySelector(":scope > dialog");
    this.badges = this.dialog.querySelector(":scope > .action-hint-badges");
    this.status = this.dialog.querySelector(
      ":scope > .action-hint-instructions > .action-hint-input-status",
    );
  }

  open(targets, viewportRect) {
    this.ensureRendered();
    if (this.dialog.open) {
      throw new Error("The Action Hint dialog is already open.");
    }
    this.targets = [...targets];
    this.viewportRect = viewportRect;
    this.renderBadges();
    this.updateInput({ buffer: "", matches: targets.map(({ code }) => code), status: "idle" });
    this.dialog.showModal();
    this.positionBadges();
    this.dialog.focus({ preventScroll: true });
  }

  close() {
    if (this.dialog?.open) {
      this.dialog.close();
    }
    this.targets = [];
    this.viewportRect = null;
  }

  allowsNativeActivation(event) {
    return Boolean(
      (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        this.dialog?.contains(event.target),
    );
  }

  ownsModal(element) {
    return element === this.dialog;
  }

  updateTargetLabels(targets) {
    const labels = new Map(
      targets.map((target) => [target.code, target.label]),
    );
    for (const badge of this.badges?.querySelectorAll(
      "button[data-action-hint-code]",
    ) ?? []) {
      const label = labels.get(badge.dataset.actionHintCode);
      if (!label) {
        continue;
      }
      const accessibleName = `${badge.dataset.actionHintCode} — ${label}`;
      if (badge.getAttribute("aria-label") !== accessibleName) {
        badge.setAttribute("aria-label", accessibleName);
      }
    }
  }

  updateInput({ buffer = "", matches = [], status = "idle" } = {}) {
    if (!this.dialog) {
      return;
    }
    const matching = new Set(matches);
    this.dialog.dataset.inputState = status;
    this.dialog.dataset.input = buffer;
    for (const badge of this.badges?.querySelectorAll("button[data-action-hint-code]") ?? []) {
      badge.dataset.match = matching.has(badge.dataset.actionHintCode)
        ? "true"
        : "false";
    }
    if (!this.status) {
      return;
    }
    this.status.textContent = status === "no-match"
      ? `${buffer}: no matching action`
      : buffer
        ? `Typed ${buffer}`
        : "";
  }

  handleClick(event) {
    const badge = event.target instanceof Element
      ? event.target.closest("button[data-action-hint-code]")
      : null;
    if (badge && this.dialog.contains(badge)) {
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent(ACTION_HINT_ACTIVATE_EVENT, {
          bubbles: true,
          detail: { code: badge.dataset.actionHintCode },
        }),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dispatchCancel("overlay", event);
  }

  dispatchCancel(reason, originalEvent) {
    this.dispatchEvent(
      new CustomEvent(ACTION_HINT_CANCEL_EVENT, {
        bubbles: true,
        detail: { reason, originalEvent },
      }),
    );
  }

  renderBadges() {
    const fragment = document.createDocumentFragment();
    for (const target of this.targets) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-hint-badge";
      button.dataset.actionHintCode = target.code;
      button.setAttribute("aria-label", `${target.code} — ${target.label}`);
      button.textContent = target.code;
      button.style.left = `${target.visibleRect.left}px`;
      button.style.top = `${target.visibleRect.top}px`;
      fragment.append(button);
    }
    this.badges.replaceChildren(fragment);
  }

  positionBadges() {
    for (const button of this.badges.querySelectorAll(
      "button[data-action-hint-code]",
    )) {
      const target = this.targets.find(
        ({ code }) => code === button.dataset.actionHintCode,
      );
      if (!target) {
        continue;
      }
      const bounds = button.getBoundingClientRect();
      const position = clampBadgePosition(
        { left: target.visibleRect.left, top: target.visibleRect.top },
        bounds,
        this.viewportRect,
      );
      button.style.left = `${position.left}px`;
      button.style.top = `${position.top}px`;
    }
  }
}

if (!customElements.get("caffold-action-hint-dialog")) {
  customElements.define(
    "caffold-action-hint-dialog",
    CaffoldActionHintDialog,
  );
}
