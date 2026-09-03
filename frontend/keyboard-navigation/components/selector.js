import { clampBadgePosition } from "../../action-hints.js";

export const SCROLL_SURFACE_SELECT_EVENT = "caffold:scroll-surface-select";
export const SCROLL_SURFACE_CANCEL_EVENT = "caffold:scroll-surface-cancel";

class CaffoldScrollSurfaceSelector extends HTMLElement {
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
    this.close();
  }

  ensureState() {
    if (this.stateReady) {
      return;
    }
    this.stateReady = true;
    this.surfaces = [];
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
        class="scroll-surface-selector"
        aria-labelledby="scroll-surface-selector-title"
        aria-describedby="scroll-surface-selector-description"
        tabindex="-1"
      >
        <span id="scroll-surface-selector-title" class="sr-only">Select a scroll area</span>
        <span id="scroll-surface-selector-description" class="sr-only">Type a shown code. Press ? for keyboard shortcuts or Escape to cancel.</span>
        <output class="scroll-surface-selector-input-status sr-only" aria-live="polite"></output>
        <div class="scroll-surface-selector-regions"></div>
      </dialog>
    `;
    this.dialog = this.querySelector(":scope > dialog");
    this.regions = this.dialog.querySelector(
      ":scope > .scroll-surface-selector-regions",
    );
    this.status = this.dialog.querySelector(
      ":scope > .scroll-surface-selector-input-status",
    );
  }

  open(surfaces, viewportRect) {
    this.ensureRendered();
    if (this.dialog.open) {
      throw new Error("The Scroll surface selector is already open.");
    }
    this.surfaces = [...surfaces];
    this.viewportRect = viewportRect;
    this.renderRegions();
    this.updateInput({
      buffer: "",
      matches: surfaces.map(({ code }) => code),
      status: "idle",
    });
    this.dialog.showModal();
    this.positionBadges();
    this.dialog.focus({ preventScroll: true });
  }

  close() {
    if (this.dialog?.open) {
      this.dialog.close();
    }
    this.surfaces = [];
    this.viewportRect = null;
  }

  ownsModal(element) {
    return element === this.dialog;
  }

  allowsNativeActivation(event) {
    return Boolean(
      (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        this.dialog?.contains(event.target)
    );
  }

  updateInput({ buffer = "", matches = [], status = "idle" } = {}) {
    const matching = new Set(matches);
    this.dialog.dataset.inputState = status;
    this.dialog.dataset.input = buffer;
    for (const region of this.regions.querySelectorAll(
      ":scope > .scroll-surface-selector-region",
    )) {
      const badge = region.querySelector("button[data-scroll-surface-code]");
      region.hidden = !badge ||
        !matching.has(badge.dataset.scrollSurfaceCode);
    }
    this.status.textContent = buffer ? `Typed ${buffer}` : "";
  }

  updateSurfaceLabels(surfaces) {
    const labels = new Map(surfaces.map(({ code, label }) => [code, label]));
    for (const badge of this.regions.querySelectorAll(
      "button[data-scroll-surface-code]",
    )) {
      const label = labels.get(badge.dataset.scrollSurfaceCode);
      if (label) {
        badge.setAttribute(
          "aria-label",
          `${badge.dataset.scrollSurfaceCode} — ${label}`,
        );
      }
    }
  }

  handleClick(event) {
    const badge = event.target instanceof Element
      ? event.target.closest("button[data-scroll-surface-code]")
      : null;
    if (
      badge &&
      !badge.parentElement?.hidden &&
      this.dialog.contains(badge)
    ) {
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

  dispatchCancel(reason, originalEvent) {
    this.dispatchEvent(
      new CustomEvent(SCROLL_SURFACE_CANCEL_EVENT, {
        bubbles: true,
        detail: { reason, originalEvent },
      }),
    );
  }

  renderRegions() {
    const fragment = document.createDocumentFragment();
    for (const surface of this.surfaces) {
      const region = document.createElement("div");
      region.className = "scroll-surface-selector-region";
      region.style.left = `${surface.visibleRect.left}px`;
      region.style.top = `${surface.visibleRect.top}px`;
      region.style.width = `${surface.visibleRect.width}px`;
      region.style.height = `${surface.visibleRect.height}px`;
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "scroll-surface-selector-badge";
      badge.dataset.scrollSurfaceCode = surface.code;
      badge.setAttribute("aria-label", `${surface.code} — ${surface.label}`);
      badge.textContent = surface.code;
      region.append(badge);
      fragment.append(region);
    }
    this.regions.replaceChildren(fragment);
  }

  positionBadges() {
    const occupied = [];
    for (const region of this.regions.querySelectorAll(
      ":scope > .scroll-surface-selector-region",
    )) {
      const badge = region.querySelector("button[data-scroll-surface-code]");
      const surface = this.surfaces.find(
        ({ code }) => code === badge?.dataset.scrollSurfaceCode,
      );
      if (!badge || !surface) {
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
      });
    }
  }
}

function unoccupiedBadgePosition(
  surfaceRect,
  badgeRect,
  viewportRect,
  occupied = [],
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
    const position = clampBadgePosition(
      candidate,
      badgeRect,
      viewportRect,
    );
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

function rectsOverlap(left, right) {
  return left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top;
}

if (!customElements.get("caffold-scroll-surface-selector")) {
  customElements.define(
    "caffold-scroll-surface-selector",
    CaffoldScrollSurfaceSelector,
  );
}
