import { html, LitElement } from "lit";
import { type ActionHintPull, ActionHints } from "../action-hints.js";

const START_DEFAULT_WIDTH = 320;
const START_MIN_WIDTH = 180;
const END_MIN_WIDTH = 320;
const START_MAX_RATIO = 0.7;

export type PaneResizePhase = "start" | "update" | "end";

export class CaffoldPaneResizer extends LitElement {
  private currentValue = START_DEFAULT_WIDTH;
  private preferredValue: number | null = null;
  private collapsedPreference = false;
  private resizePointerId: number | null = null;
  private readonly resizeObserver = new ResizeObserver(() =>
    this.handleContainerResize(),
  );
  private readonly onPointerDown = (event: PointerEvent) =>
    this.startResize(event);
  private readonly onPointerMove = (event: PointerEvent) =>
    this.moveResize(event);
  private readonly onPointerEnd = (event: PointerEvent) =>
    this.endResize(event);
  private readonly onKeyDown = (event: KeyboardEvent) =>
    this.adjustFromKeyboard(event);
  private readonly onFocus = () => this.syncRange();
  private readonly hints = new ActionHints(this);

  createRenderRoot() {
    return this;
  }

  // The separator is the host, so the handle carries its Action Hint.
  render() {
    return html`<span
      ${this.hints.separator({
        id: "separator",
        label: this.getAttribute("aria-label") || "Resize pane",
        control: () => this,
        clipRoots: () => [this],
      })}
      class="pane-resizer-handle"
      aria-hidden="true"
    ></span>`;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "separator");
    this.setAttribute("aria-orientation", "vertical");
    if (!this.hasAttribute("aria-label")) {
      this.setAttribute("aria-label", "Resize pane");
    }
    if (!this.hasAttribute("tabindex")) {
      this.tabIndex = 0;
    }
    this.addEventListener("pointerdown", this.onPointerDown);
    this.addEventListener("pointermove", this.onPointerMove);
    this.addEventListener("pointerup", this.onPointerEnd);
    this.addEventListener("pointercancel", this.onPointerEnd);
    this.addEventListener("lostpointercapture", this.onPointerEnd);
    this.addEventListener("keydown", this.onKeyDown);
    this.addEventListener("focus", this.onFocus);
    if (this.parentElement) {
      this.resizeObserver.observe(this.parentElement);
    }
    this.restorePreferredValue();
    this.restoreCollapsed();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelResize();
    this.resizeObserver.disconnect();
    this.removeEventListener("pointerdown", this.onPointerDown);
    this.removeEventListener("pointermove", this.onPointerMove);
    this.removeEventListener("pointerup", this.onPointerEnd);
    this.removeEventListener("pointercancel", this.onPointerEnd);
    this.removeEventListener("lostpointercapture", this.onPointerEnd);
    this.removeEventListener("keydown", this.onKeyDown);
    this.removeEventListener("focus", this.onFocus);
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  get value() {
    return this.currentValue;
  }

  // Whether the person chose to hide the start pane. The host decides when
  // that choice applies, so this only remembers it.
  get collapsed() {
    return this.collapsedPreference;
  }

  setCollapsed(collapsed: boolean) {
    this.collapsedPreference = Boolean(collapsed);
    writeStoredValue(
      this.getAttribute("collapsed-storage-key"),
      `${this.collapsedPreference}`,
    );
  }

  private startResize(event: PointerEvent) {
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

  private moveResize(event: PointerEvent) {
    if (event.pointerId !== this.resizePointerId) {
      return;
    }

    event.preventDefault();
    this.updateFromPointer(event);
  }

  private endResize(event: PointerEvent) {
    if (event.pointerId !== this.resizePointerId) {
      return;
    }

    const pointerId = this.resizePointerId;
    this.resizePointerId = null;
    delete this.dataset.resizing;
    if (this.hasPointerCapture(pointerId)) {
      this.releasePointerCapture(pointerId);
    }
    this.storePreferredValue();
    this.emitResize("end");
  }

  private cancelResize() {
    if (this.resizePointerId === null) {
      return;
    }

    const pointerId = this.resizePointerId;
    this.resizePointerId = null;
    delete this.dataset.resizing;
    if (this.hasPointerCapture(pointerId)) {
      this.releasePointerCapture(pointerId);
    }
    this.storePreferredValue();
    this.emitResize("end");
  }

  private adjustFromKeyboard(event: KeyboardEvent) {
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
    this.storePreferredValue();
  }

  private updateFromPointer(event: PointerEvent) {
    const container = this.parentElement;
    if (!container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    this.updateValue(event.clientX - rect.left);
  }

  private updateValue(value: number) {
    this.currentValue = this.clampValue(value);
    this.preferredValue = this.currentValue;
    this.syncRange();
    this.emitResize("update", this.currentValue);
  }

  private handleContainerResize() {
    if (!this.canResize()) {
      this.syncRange();
      return;
    }

    this.applyPreferredValue();
  }

  private restorePreferredValue() {
    this.preferredValue =
      readStoredWidth(this.getAttribute("storage-key")) ??
      this.preferredValue ??
      numericAttribute(this, "start-default", START_DEFAULT_WIDTH);
    this.applyPreferredValue();
  }

  private applyPreferredValue() {
    const nextValue = this.clampValue(this.preferredValue);
    if (nextValue === this.currentValue) {
      this.syncRange();
      return;
    }

    this.currentValue = nextValue;
    this.syncRange();
    this.emitResize("update", nextValue);
  }

  private storePreferredValue() {
    if (this.preferredValue !== null && Number.isFinite(this.preferredValue)) {
      writeStoredValue(
        this.getAttribute("storage-key"),
        `${this.preferredValue}`,
      );
    }
  }

  private restoreCollapsed() {
    const stored = readStoredValue(this.getAttribute("collapsed-storage-key"));
    if (stored === "true" || stored === "false") {
      this.collapsedPreference = stored === "true";
    }
  }

  private syncRange() {
    const maxValue = this.maxValue();
    const ariaMax = this.canResize()
      ? maxValue
      : Math.max(maxValue, this.currentValue);
    this.setAttribute("aria-valuemin", `${this.minimumValue()}`);
    this.setAttribute("aria-valuemax", `${ariaMax}`);
    this.setAttribute("aria-valuenow", `${this.currentValue}`);
  }

  private clampValue(value: number | null) {
    const numericValue = Number(value);
    const normalizedValue = Number.isFinite(numericValue)
      ? numericValue
      : START_DEFAULT_WIDTH;
    const minimumClampedValue = Math.max(
      Math.round(normalizedValue),
      this.minimumValue(),
    );
    return this.canResize()
      ? Math.min(minimumClampedValue, this.maxValue())
      : minimumClampedValue;
  }

  private maxValue() {
    const width = this.parentElement?.getBoundingClientRect().width ?? 0;
    if (!width) {
      return START_DEFAULT_WIDTH;
    }

    const ratioMax = Math.round(width * START_MAX_RATIO);
    const minimum = this.minimumValue();
    const startMax = numericAttribute(
      this,
      "start-max",
      Number.POSITIVE_INFINITY,
    );
    const endMinimumLimit = Math.max(minimum, width - this.endMinimumValue());
    return Math.max(minimum, Math.min(startMax, ratioMax, endMinimumLimit));
  }

  private minimumValue() {
    return numericAttribute(this, "start-min", START_MIN_WIDTH);
  }

  private endMinimumValue() {
    return numericAttribute(this, "end-min", END_MIN_WIDTH);
  }

  private canResize() {
    return Boolean(this.parentElement && this.getClientRects().length > 0);
  }

  private emitResize(phase: PaneResizePhase, value: number | null = null) {
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

function numericAttribute(element: Element, name: string, fallback: number) {
  return positiveWidth(element.getAttribute(name)) ?? fallback;
}

function readStoredWidth(key: string | null) {
  return positiveWidth(readStoredValue(key));
}

function readStoredValue(key: string | null) {
  if (!key) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key: string | null, value: string) {
  if (!key) {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage can be unavailable in private or restricted contexts.
  }
}

function positiveWidth(value: string | null) {
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
}
