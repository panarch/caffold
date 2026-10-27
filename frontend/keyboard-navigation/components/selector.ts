import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { clampBadgePosition, type Rect } from "../../action-hints.js";
import { DrawnRef, DrawnRefs, drawn } from "../../components/drawn-refs.js";

export const SCROLL_SURFACE_SELECT_EVENT = "caffold:scroll-surface-select";
export const SCROLL_SURFACE_CANCEL_EVENT = "caffold:scroll-surface-cancel";

export interface SelectableScrollSurface {
  code: string;
  label: string;
  visibleRect: Rect;
}

interface SelectorInput {
  buffer?: string;
  matches?: string[];
  status?: string;
}

/**
 * The modal that offers a context's Scroll surfaces when there is more than
 * one: each surface outlined, with the code that chooses it.
 */
@customElement("caffold-scroll-surface-selector")
export class CaffoldScrollSurfaceSelector extends LitElement {
  private surfaces: SelectableScrollSurface[] = [];
  private labels = new Map<string, string>();
  private viewportRect: Rect | null = null;
  private input: Required<SelectorInput> = {
    buffer: "",
    matches: [],
    status: "idle",
  };
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly badges = new DrawnRefs<HTMLButtonElement>(this);
  // Scrolling and pinching stay with the selector while it is shown.
  private readonly wheel = {
    handleEvent: (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) {
        event.preventDefault();
      }
    },
    passive: false,
  };
  private readonly touchMove = {
    handleEvent: (event: TouchEvent) => {
      if (event.touches.length < 2) {
        event.preventDefault();
      }
    },
    passive: false,
  };

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.close();
  }

  override render() {
    const { buffer, status } = this.input;
    const matching = new Set(this.input.matches);
    return html`<dialog
      ${drawn(this.dialog)}
      class="scroll-surface-selector"
      aria-labelledby="scroll-surface-selector-title"
      aria-describedby="scroll-surface-selector-description"
      tabindex="-1"
      data-input-state=${status}
      data-input=${buffer}
      @click=${this.handleClick}
      @cancel=${this.handleCancel}
      @wheel=${this.wheel}
      @touchmove=${this.touchMove}
    >
      <span id="scroll-surface-selector-title" class="sr-only"
        >Select a scroll area</span
      >
      <span id="scroll-surface-selector-description" class="sr-only"
        >Type a shown code. Press ? for keyboard shortcuts or Escape to
        cancel.</span
      >
      <output
        class="scroll-surface-selector-input-status sr-only"
        aria-live="polite"
      >${buffer ? `Typed ${buffer}` : ""}</output>
      <div class="scroll-surface-selector-regions">${repeat(
        this.surfaces,
        (surface) => surface.code,
        ({ code, label, visibleRect: rect }) => html`<div
          class="scroll-surface-selector-region"
          style=${`left: ${rect.left}px; top: ${rect.top}px; width: ${
            rect.width
          }px; height: ${rect.height}px;`}
          ?hidden=${!matching.has(code)}
        >
          <button
            ${drawn(this.badges.of(code))}
            type="button"
            class="scroll-surface-selector-badge"
            data-scroll-surface-code=${code}
            aria-label=${`${code} — ${this.labels.get(code) ?? label}`}
          >${code}</button>
        </div>`,
      )}</div>
    </dialog>`;
  }

  open(
    surfaces: readonly SelectableScrollSurface[],
    viewportRect: Rect | null,
  ) {
    const dialog = this.dialog.value;
    if (!dialog) {
      return;
    }
    if (dialog.open) {
      throw new Error("The Scroll surface selector is already open.");
    }
    this.surfaces = [...surfaces];
    this.labels = new Map();
    this.viewportRect = viewportRect;
    this.input = {
      buffer: "",
      matches: surfaces.map(({ code }) => code),
      status: "idle",
    };
    this.draw();
    dialog.showModal();
    this.positionBadges();
    dialog.focus({ preventScroll: true });
  }

  close() {
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
    this.surfaces = [];
    this.viewportRect = null;
    this.draw();
  }

  ownsModal(element: Element) {
    return element === this.dialog.value;
  }

  allowsNativeActivation(event: KeyboardEvent) {
    return Boolean(
      (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        this.dialog.value?.contains(event.target),
    );
  }

  updateInput({ buffer = "", matches = [], status = "idle" }: SelectorInput) {
    this.input = { buffer, matches, status };
    this.draw();
  }

  // A surface renamed while the selector is open keeps its code and place.
  updateSurfaceLabels(surfaces: readonly { code: string; label: string }[]) {
    for (const { code, label } of surfaces) {
      if (label) {
        this.labels.set(code, label);
      }
    }
    this.draw();
  }

  private handleClick(event: MouseEvent) {
    const badge =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(
            "button[data-scroll-surface-code]",
          )
        : null;
    if (badge && !badge.parentElement?.hidden) {
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent(SCROLL_SURFACE_SELECT_EVENT, {
          bubbles: true,
          detail: { code: badge.dataset.scrollSurfaceCode },
        }),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.dispatchCancel("overlay", event);
  }

  private handleCancel(event: Event) {
    event.preventDefault();
    this.dispatchCancel("escape", event);
  }

  private dispatchCancel(reason: string, originalEvent: Event) {
    this.dispatchEvent(
      new CustomEvent(SCROLL_SURFACE_CANCEL_EVENT, {
        bubbles: true,
        detail: { reason, originalEvent },
      }),
    );
  }

  // Each badge takes the first place in its surface that no earlier badge
  // covers, inside the viewport. Sizes are read once the badges are drawn.
  private positionBadges() {
    const occupied: Rect[] = [];
    for (const surface of this.surfaces) {
      const badge = this.badges.get(surface.code);
      if (!badge) {
        continue;
      }
      const bounds = badge.getBoundingClientRect();
      const position = unoccupiedBadgePosition(
        surface.visibleRect,
        bounds,
        this.viewportRect,
        occupied,
      );
      badge.style.left = `${position.left - surface.visibleRect.left}px`;
      badge.style.top = `${position.top - surface.visibleRect.top}px`;
      occupied.push({
        left: position.left,
        top: position.top,
        right: position.left + bounds.width,
        bottom: position.top + bounds.height,
        width: bounds.width,
        height: bounds.height,
      });
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

function unoccupiedBadgePosition(
  surfaceRect: Rect,
  badgeRect: { width: number; height: number },
  viewportRect: Rect | null,
  occupied: readonly Rect[],
  gap = 4,
) {
  const step = badgeRect.height + gap;
  const candidates = [];
  for (let index = 0; index <= occupied.length; index += 1) {
    candidates.push({
      left: surfaceRect.left,
      top: surfaceRect.top + step * index,
    });
  }
  candidates.push(
    { left: surfaceRect.right - badgeRect.width, top: surfaceRect.top },
    { left: surfaceRect.left, top: surfaceRect.bottom - badgeRect.height },
    {
      left: surfaceRect.right - badgeRect.width,
      top: surfaceRect.bottom - badgeRect.height,
    },
  );
  for (const candidate of candidates) {
    const position = clampBadgePosition(candidate, badgeRect, viewportRect);
    const placed = {
      left: position.left,
      top: position.top,
      right: position.left + badgeRect.width,
      bottom: position.top + badgeRect.height,
    };
    if (!occupied.some((rect) => rectsOverlap(placed, rect))) {
      return position;
    }
  }
  return clampBadgePosition(candidates[0], badgeRect, viewportRect);
}

function rectsOverlap(
  left: Pick<Rect, "left" | "top" | "right" | "bottom">,
  right: Pick<Rect, "left" | "top" | "right" | "bottom">,
) {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-scroll-surface-selector": CaffoldScrollSurfaceSelector;
  }
}
