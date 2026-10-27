import { html, LitElement } from "lit";
import {
  clampBadgePosition,
  normalizeRect,
  type Rect,
  type RectLike,
} from "../../action-hints/model.ts";
import { DrawnRef, drawn } from "../../components/drawn-refs.ts";

/**
 * The outline around the surface Scroll mode moves, and the status at its
 * corner that names it.
 */
export class CaffoldScrollModeHud extends LitElement {
  private label = "";
  private contextRect: Rect | null = null;
  private surfaceRect: Rect | null = null;
  private readonly outline = new DrawnRef<HTMLDivElement>(this);
  private readonly status = new DrawnRef<HTMLDivElement>(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.hidden = !this.surfaceRect;
  }

  render() {
    return html`
      <div
        ${drawn(this.outline)}
        class="scroll-mode-outline"
        aria-hidden="true"
      ></div>
      <div
        ${drawn(this.status)}
        class="scroll-mode-status"
        role="status"
        aria-live="polite"
      >
        <strong data-scroll-mode-label>${
          this.label ? `Scroll: ${this.label}` : ""
        }</strong>
        <span aria-hidden="true">·</span>
        <span data-scroll-mode-shortcut-help>
          <span aria-hidden="true">?</span>
          <span class="sr-only"
            >Press question mark for keyboard shortcuts</span
          >
        </span>
      </div>
    `;
  }

  show({
    label,
    visibleRect,
    contextRect,
  }: {
    label?: string;
    visibleRect?: RectLike;
    contextRect?: RectLike;
  } = {}) {
    const surface = normalizeRect(visibleRect);
    const context = normalizeRect(contextRect);
    if (!label || !surface || !context) {
      this.close();
      return false;
    }
    this.label = label;
    this.contextRect = context;
    this.surfaceRect = surface;
    this.draw();
    const outline = this.outline.value;
    if (outline) {
      outline.style.left = `${surface.left}px`;
      outline.style.top = `${surface.top}px`;
      outline.style.width = `${surface.width}px`;
      outline.style.height = `${surface.height}px`;
    }
    this.hidden = false;
    this.positionStatus();
    return true;
  }

  // The status sits at the surface's top end, inside the context, once its
  // own width is known.
  positionStatus() {
    const context = this.contextRect;
    const surface = this.surfaceRect;
    const status = this.status.value;
    if (!context || !surface || !status) {
      return false;
    }
    status.style.maxWidth = `${Math.max(
      0,
      Math.min(context.width, surface.width) - 16,
    )}px`;
    status.style.left = `${surface.left}px`;
    status.style.top = `${surface.top + 8}px`;
    const bounds = status.getBoundingClientRect();
    const position = clampBadgePosition(
      { left: surface.right - bounds.width - 8, top: surface.top + 8 },
      bounds,
      context,
      8,
    );
    status.style.left = `${position.left}px`;
    status.style.top = `${position.top}px`;
    return true;
  }

  updateLabel(label: string) {
    if (!this.hidden && label) {
      this.label = label;
      this.draw();
      this.positionStatus();
    }
  }

  close() {
    this.hidden = true;
    this.label = "";
    this.contextRect = null;
    this.surfaceRect = null;
    this.draw();
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define("caffold-scroll-mode-hud", CaffoldScrollModeHud);
