import { clampBadgePosition } from "../model.js";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "../control.js";

let actionHintDialogInstanceId = 0;

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
    actionHintDialogInstanceId += 1;
    this.titleId = `action-hint-title-${actionHintDialogInstanceId}`;
    this.descriptionId =
      `action-hint-description-${actionHintDialogInstanceId}`;
    this.badgeSizes = new WeakMap();
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
        aria-labelledby="${this.titleId}"
        aria-describedby="${this.descriptionId}"
        tabindex="-1"
      >
        <span id="${this.titleId}" class="sr-only">Action Hints</span>
        <span id="${this.descriptionId}" class="sr-only">Type a shown code. Press ? for keyboard shortcuts or Escape to cancel.</span>
        <output class="action-hint-input-status sr-only" aria-live="polite"></output>
        <div class="action-hint-badges"></div>
      </dialog>
    `;
    this.dialog = this.querySelector(":scope > dialog");
    this.badges = this.dialog.querySelector(":scope > .action-hint-badges");
    this.status = this.dialog.querySelector(
      ":scope > .action-hint-input-status",
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

  reconcileTargets(targets, viewportRect) {
    if (!this.dialog?.open || !this.badges) {
      return false;
    }
    const nextTargets = [...targets];
    const targetByCode = new Map(
      nextTargets.map((target) => [target.code, target]),
    );
    if (targetByCode.size !== nextTargets.length) {
      return false;
    }
    const badgesByCode = new Map(
      Array.from(this.badges.querySelectorAll(
        "button[data-action-hint-code]",
      )).map((badge) => [badge.dataset.actionHintCode, badge]),
    );
    if (nextTargets.some((target) => !badgesByCode.has(target.code))) {
      return false;
    }
    const focusedBadge = document.activeElement instanceof HTMLButtonElement &&
        this.badges.contains(document.activeElement)
      ? document.activeElement
      : null;
    for (const [code, badge] of badgesByCode) {
      if (!targetByCode.has(code)) {
        badge.remove();
      }
    }
    for (const target of nextTargets) {
      const badge = badgesByCode.get(target.code);
      const accessibleName = `${target.code} — ${target.label}`;
      if (badge.getAttribute("aria-label") !== accessibleName) {
        badge.setAttribute("aria-label", accessibleName);
      }
      badge.style.left = `${target.visibleRect.left}px`;
      badge.style.top = `${target.visibleRect.top}px`;
    }
    this.targets = nextTargets;
    this.viewportRect = viewportRect;
    this.positionBadges();
    if (focusedBadge && !focusedBadge.isConnected) {
      this.dialog.focus({ preventScroll: true });
    }
    return true;
  }

  updateInput({ buffer = "", matches = [], status = "idle" } = {}) {
    if (!this.dialog) {
      return;
    }
    const matching = new Set(matches);
    this.dialog.dataset.inputState = status;
    this.dialog.dataset.input = buffer;
    for (const badge of this.badges?.querySelectorAll(
      "button[data-action-hint-code]",
    ) ?? []) {
      badge.hidden = !matching.has(badge.dataset.actionHintCode);
    }
    if (!this.status) {
      return;
    }
    this.status.textContent = buffer ? `Typed ${buffer}` : "";
  }

  handleClick(event) {
    const badge = event.target instanceof Element
      ? event.target.closest("button[data-action-hint-code]")
      : null;
    if (badge && !badge.hidden && this.dialog.contains(badge)) {
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
    this.badgeSizes = new WeakMap();
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
      const measured = button.getBoundingClientRect();
      if (measured.width > 0 && measured.height > 0) {
        this.badgeSizes.set(button, {
          width: measured.width,
          height: measured.height,
        });
      }
      const bounds = this.badgeSizes.get(button) ?? measured;
      const position = clampBadgePosition(
        target.visibleRect,
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
