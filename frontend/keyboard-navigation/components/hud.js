import { clampBadgePosition, normalizeRect } from "../../action-hints.js";

class CaffoldScrollModeHud extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.hidden = true;
    this.innerHTML = `
      <div class="scroll-mode-outline" aria-hidden="true"></div>
      <div class="scroll-mode-status" role="status" aria-live="polite">
        <strong data-scroll-mode-label></strong>
        <span aria-hidden="true">·</span>
        <span data-scroll-mode-shortcut-help>
          <span aria-hidden="true">?</span>
          <span class="sr-only">Press question mark for keyboard shortcuts</span>
        </span>
      </div>
    `;
  }

  show({ label, visibleRect, contextRect } = {}) {
    this.ensureRendered();
    const surface = normalizeRect(visibleRect);
    const context = normalizeRect(contextRect);
    if (!label || !surface || !context) {
      this.close();
      return false;
    }
    this.querySelector("[data-scroll-mode-label]").textContent =
      `Scroll: ${label}`;
    this.contextRect = context;
    this.surfaceRect = surface;
    const outline = this.querySelector(":scope > .scroll-mode-outline");
    outline.style.left = `${surface.left}px`;
    outline.style.top = `${surface.top}px`;
    outline.style.width = `${surface.width}px`;
    outline.style.height = `${surface.height}px`;
    this.hidden = false;
    this.positionStatus();
    return true;
  }

  positionStatus() {
    const context = this.contextRect;
    const surface = this.surfaceRect;
    const status = this.querySelector(":scope > .scroll-mode-status");
    if (!context || !surface || !status) {
      return false;
    }
    status.style.maxWidth = `${
      Math.max(0, Math.min(context.width, surface.width) - 16)
    }px`;
    status.style.left = `${surface.left}px`;
    status.style.top = `${surface.top + 8}px`;
    const bounds = status.getBoundingClientRect();
    const position = clampBadgePosition(
      {
        left: surface.right - bounds.width - 8,
        top: surface.top + 8,
      },
      bounds,
      context,
      8,
    );
    status.style.left = `${position.left}px`;
    status.style.top = `${position.top}px`;
    return true;
  }

  updateLabel(label) {
    const target = this.querySelector("[data-scroll-mode-label]");
    if (!this.hidden && target && label) {
      target.textContent = `Scroll: ${label}`;
      this.positionStatus();
    }
  }

  close() {
    this.ensureRendered();
    this.hidden = true;
    this.contextRect = null;
    this.surfaceRect = null;
    this.querySelector("[data-scroll-mode-label]").textContent = "";
  }
}

if (!customElements.get("caffold-scroll-mode-hud")) {
  customElements.define("caffold-scroll-mode-hud", CaffoldScrollModeHud);
}
