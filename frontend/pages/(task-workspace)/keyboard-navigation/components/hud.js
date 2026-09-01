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
        <span>J/K small · D/U half page · F Action Hints · Escape exits</span>
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
    const status = this.querySelector(":scope > .scroll-mode-status");
    if (!context || !status) {
      return false;
    }
    status.style.maxWidth = `${Math.max(0, context.width - 16)}px`;
    status.style.left = `${context.left + context.width / 2}px`;
    status.style.top = `${context.bottom - 8}px`;
    const bounds = status.getBoundingClientRect();
    const position = clampBadgePosition(
      {
        left: context.left + (context.width - bounds.width) / 2,
        top: context.bottom - bounds.height - 8,
      },
      bounds,
      context,
      8,
    );
    status.style.left = `${position.left}px`;
    status.style.top = `${position.top}px`;
    correctClampedPosition(status, context, 8);
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
    this.querySelector("[data-scroll-mode-label]").textContent = "";
  }
}

function correctClampedPosition(element, bounds, margin) {
  const placed = element.getBoundingClientRect();
  const corrected = clampBadgePosition(
    { left: placed.left, top: placed.top },
    placed,
    bounds,
    margin,
  );
  const deltaLeft = corrected.left - placed.left;
  const deltaTop = corrected.top - placed.top;
  if (Math.abs(deltaLeft) > 0.5) {
    element.style.left = `${
      (Number.parseFloat(element.style.left) || 0) + deltaLeft
    }px`;
  }
  if (Math.abs(deltaTop) > 0.5) {
    element.style.top = `${
      (Number.parseFloat(element.style.top) || 0) + deltaTop
    }px`;
  }
}

if (!customElements.get("caffold-scroll-mode-hud")) {
  customElements.define("caffold-scroll-mode-hud", CaffoldScrollModeHud);
}
