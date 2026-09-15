import {
  emptyActionHintScope,
  hasActionHintLayoutBox,
  separatorActionHintTarget,
} from "../action-hint-scope.js";

export const PANE_RESIZER_DEFAULT_WIDTH = 320;
const START_MIN_WIDTH = 180;
const END_MIN_WIDTH = 320;
const START_MAX_RATIO = 0.7;

export class CaffoldPaneResizer extends HTMLElement {
  constructor() {
    super();
    this.currentValue = PANE_RESIZER_DEFAULT_WIDTH;
    this.resizePointerId = null;
    this.boundPointerDown = (event) => this.startResize(event);
    this.boundPointerMove = (event) => this.moveResize(event);
    this.boundPointerUp = (event) => this.endResize(event);
    this.boundLostPointerCapture = (event) => this.endResize(event);
    this.boundKeyDown = (event) => this.adjustFromKeyboard(event);
    this.boundFocus = () => this.syncRange();
    this.resizeObserver = new ResizeObserver(() => this.handleContainerResize());
  }

  connectedCallback() {
    this.setAttribute("role", "separator");
    this.setAttribute("aria-orientation", "vertical");
    if (!this.hasAttribute("aria-label")) {
      this.setAttribute("aria-label", "Resize pane");
    }
    if (!this.hasAttribute("tabindex")) {
      this.tabIndex = 0;
    }
    if (!this.handle) {
      this.handle = document.createElement("span");
      this.handle.className = "pane-resizer-handle";
      this.handle.setAttribute("aria-hidden", "true");
      this.append(this.handle);
    }

    this.addEventListener("pointerdown", this.boundPointerDown);
    this.addEventListener("pointermove", this.boundPointerMove);
    this.addEventListener("pointerup", this.boundPointerUp);
    this.addEventListener("pointercancel", this.boundPointerUp);
    this.addEventListener("lostpointercapture", this.boundLostPointerCapture);
    this.addEventListener("keydown", this.boundKeyDown);
    this.addEventListener("focus", this.boundFocus);
    if (this.parentElement) {
      this.resizeObserver.observe(this.parentElement);
    }
    this.syncRange();
  }

  disconnectedCallback() {
    this.cancelResize();
    this.resizeObserver.disconnect();
    this.removeEventListener("pointerdown", this.boundPointerDown);
    this.removeEventListener("pointermove", this.boundPointerMove);
    this.removeEventListener("pointerup", this.boundPointerUp);
    this.removeEventListener("pointercancel", this.boundPointerUp);
    this.removeEventListener("lostpointercapture", this.boundLostPointerCapture);
    this.removeEventListener("keydown", this.boundKeyDown);
    this.removeEventListener("focus", this.boundFocus);
  }

  actionHintScope({
    scopeId = "",
    actionId = "",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const parent = this.parentElement;
    if (
      !scopeId ||
      !actionId ||
      this.hidden ||
      !this.canResize() ||
      !hasActionHintLayoutBox(this)
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [separatorActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:separator`,
        actionId,
        label: this.getAttribute("aria-label") || "Resize pane",
        control: this,
        anchor: this.handle,
        clipRoots: [this, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.parentElement === parent &&
          isCurrent() &&
          this.canResize() &&
          hasActionHintLayoutBox(this),
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  setValue(value) {
    this.currentValue = this.clampValue(value);
    this.syncRange();
    return this.currentValue;
  }

  startResize(event) {
    if (!this.canResize()) {
      return;
    }

    event.preventDefault();
    this.resizePointerId = event.pointerId;
    this.setPointerCapture(event.pointerId);
    this.dataset.resizing = "";
    this.emitResize("start");
    this.updateFromPointer(event);
  }

  moveResize(event) {
    if (event.pointerId !== this.resizePointerId) {
      return;
    }

    event.preventDefault();
    this.updateFromPointer(event);
  }

  endResize(event) {
    if (event.pointerId !== this.resizePointerId) {
      return;
    }

    const pointerId = this.resizePointerId;
    this.resizePointerId = null;
    delete this.dataset.resizing;
    if (this.hasPointerCapture(pointerId)) {
      this.releasePointerCapture(pointerId);
    }
    this.emitResize("end");
  }

  cancelResize() {
    if (this.resizePointerId === null) {
      return;
    }

    const pointerId = this.resizePointerId;
    this.resizePointerId = null;
    delete this.dataset.resizing;
    if (this.hasPointerCapture(pointerId)) {
      this.releasePointerCapture(pointerId);
    }
    this.emitResize("end");
  }

  adjustFromKeyboard(event) {
    if (!this.canResize()) {
      return;
    }

    const step = event.shiftKey ? 72 : 24;
    let nextValue = this.currentValue;
    if (event.key === "ArrowLeft") {
      nextValue -= step;
    } else if (event.key === "ArrowRight") {
      nextValue += step;
    } else if (event.key === "Home") {
      nextValue = this.minimumValue();
    } else if (event.key === "End") {
      nextValue = this.maxValue();
    } else {
      return;
    }

    event.preventDefault();
    this.updateValue(nextValue);
  }

  updateFromPointer(event) {
    const container = this.parentElement;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    this.updateValue(event.clientX - rect.left);
  }

  updateValue(value) {
    this.currentValue = this.clampValue(value);
    this.syncRange();
    this.emitResize("update", this.currentValue);
  }

  handleContainerResize() {
    if (!this.canResize()) {
      this.syncRange();
      return;
    }

    const nextValue = this.clampValue(this.currentValue);
    if (nextValue !== this.currentValue) {
      this.updateValue(nextValue);
      return;
    }
    this.syncRange();
  }

  syncRange() {
    const maxValue = this.maxValue();
    const ariaMax = this.canResize()
      ? maxValue
      : Math.max(maxValue, this.currentValue);
    this.setAttribute("aria-valuemin", `${this.minimumValue()}`);
    this.setAttribute("aria-valuemax", `${ariaMax}`);
    this.setAttribute("aria-valuenow", `${this.currentValue}`);
  }

  clampValue(value) {
    const numericValue = Number(value);
    const normalizedValue = Number.isFinite(numericValue)
      ? numericValue
      : PANE_RESIZER_DEFAULT_WIDTH;
    const minimumClampedValue = Math.max(
      Math.round(normalizedValue),
      this.minimumValue(),
    );
    return this.canResize()
      ? Math.min(minimumClampedValue, this.maxValue())
      : minimumClampedValue;
  }

  maxValue() {
    const width = this.parentElement?.getBoundingClientRect().width ?? 0;
    if (!width) {
      return PANE_RESIZER_DEFAULT_WIDTH;
    }

    const ratioMax = Math.round(width * START_MAX_RATIO);
    const minimum = this.minimumValue();
    const startMax = numericAttribute(this, "start-max", Number.POSITIVE_INFINITY);
    const endMinimumLimit = Math.max(minimum, width - this.endMinimumValue());
    return Math.max(minimum, Math.min(startMax, ratioMax, endMinimumLimit));
  }

  minimumValue() {
    return numericAttribute(this, "start-min", START_MIN_WIDTH);
  }

  endMinimumValue() {
    return numericAttribute(this, "end-min", END_MIN_WIDTH);
  }

  canResize() {
    return Boolean(this.parentElement && this.getClientRects().length > 0);
  }

  emitResize(phase, value = null) {
    const detail = value === null ? { phase } : { phase, value };
    this.dispatchEvent(
      new CustomEvent("caffold:pane-resize", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }
}

customElements.define("caffold-pane-resizer", CaffoldPaneResizer);

function numericAttribute(element, name, fallback) {
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
