import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ActionHintSessionTarget } from "../../action-hints.js";
import { DrawnRef, DrawnRefs, drawn } from "../../components/drawn-refs.js";
import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "../control.js";
import { clampBadgePosition, type HintProgress, type Rect } from "../model.js";

let actionHintDialogInstanceId = 0;

/**
 * The modal one keyboard context shows its Action Hint badges in, each at
 * its target and named by the code that activates it.
 *
 * The controller opens it with a session's targets and draws it again as the
 * person types or the targets move. A badge keeps its element while its code
 * stays, so focus and measurements carry over.
 */
@customElement("caffold-action-hint-dialog")
export class CaffoldActionHintDialog extends LitElement {
  private readonly titleId: string;
  private readonly descriptionId: string;
  private targets: readonly ActionHintSessionTarget[] = [];
  private viewportRect: Rect | null = null;
  private progress: Pick<HintProgress, "buffer" | "matches" | "status"> = {
    buffer: "",
    matches: [],
    status: "idle",
  };
  // Each badge's size once it had one, so a badge hidden while typing keeps
  // its place.
  private badgeSizes = new WeakMap<
    Element,
    { width: number; height: number }
  >();
  private readonly dialog = new DrawnRef<HTMLDialogElement>(this);
  private readonly badges = new DrawnRefs<HTMLButtonElement>(this);
  // Scrolling and pinching stay with the badges while they are shown.
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

  constructor() {
    super();
    actionHintDialogInstanceId += 1;
    this.titleId = `action-hint-title-${actionHintDialogInstanceId}`;
    this.descriptionId = `action-hint-description-${actionHintDialogInstanceId}`;
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    const dialog = this.dialog.value;
    if (dialog?.open) {
      dialog.close();
    }
  }

  override render() {
    const { buffer, status } = this.progress;
    const matching = new Set(this.progress.matches);
    return html`<dialog
      ${drawn(this.dialog)}
      class="action-hint-dialog"
      aria-labelledby=${this.titleId}
      aria-describedby=${this.descriptionId}
      tabindex="-1"
      data-input-state=${status}
      data-input=${buffer}
      @click=${this.handleClick}
      @cancel=${this.handleCancel}
      @wheel=${this.wheel}
      @touchmove=${this.touchMove}
    >
      <span id=${this.titleId} class="sr-only">Action Hints</span>
      <span id=${this.descriptionId} class="sr-only"
        >Type a shown code. Press ? for keyboard shortcuts or Escape to
        cancel.</span
      >
      <output class="action-hint-input-status sr-only" aria-live="polite"
        >${buffer ? `Typed ${buffer}` : ""}</output
      >
      <div class="action-hint-badges">${repeat(
        this.targets,
        (target) => target.code,
        (target) => html`<button
          ${drawn(this.badges.of(target.code))}
          type="button"
          class="action-hint-badge"
          data-action-hint-code=${target.code}
          aria-label=${`${target.code} — ${target.label}`}
          ?hidden=${!matching.has(target.code)}
        >${target.code}</button>`,
      )}</div>
    </dialog>`;
  }

  open(targets: readonly ActionHintSessionTarget[], viewportRect: Rect | null) {
    const dialog = this.dialog.value;
    if (!dialog) {
      return;
    }
    if (dialog.open) {
      throw new Error("The Action Hint dialog is already open.");
    }
    this.targets = [...targets];
    this.viewportRect = viewportRect;
    this.badgeSizes = new WeakMap();
    this.progress = {
      buffer: "",
      matches: targets.map(({ code }) => code),
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
    this.targets = [];
    this.viewportRect = null;
    this.draw();
  }

  allowsNativeActivation(event: KeyboardEvent) {
    return Boolean(
      (event.key === "Enter" || event.key === " ") &&
        event.target instanceof HTMLButtonElement &&
        this.dialog.value?.contains(event.target),
    );
  }

  ownsModal(element: Element) {
    return element === this.dialog.value;
  }

  // Moves the badges to targets that kept their codes. A target with a code
  // the dialog has no badge for asks for a new session instead.
  reconcileTargets(
    targets: readonly ActionHintSessionTarget[],
    viewportRect: Rect | null,
  ) {
    const dialog = this.dialog.value;
    if (!dialog?.open) {
      return false;
    }
    const codes = new Set(targets.map(({ code }) => code));
    if (
      codes.size !== targets.length ||
      targets.some(({ code }) => !this.badges.get(code))
    ) {
      return false;
    }
    const focused = document.activeElement;
    const focusedBadge =
      focused instanceof HTMLButtonElement && dialog.contains(focused)
        ? focused
        : null;
    this.targets = [...targets];
    this.viewportRect = viewportRect;
    this.draw();
    this.positionBadges();
    if (focusedBadge && !focusedBadge.isConnected) {
      dialog.focus({ preventScroll: true });
    }
    return true;
  }

  updateInput({
    buffer = "",
    matches = [],
    status = "idle",
  }: Partial<HintProgress> = {}) {
    this.progress = { buffer, matches, status };
    this.draw();
  }

  private handleClick(event: MouseEvent) {
    const badge =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(
            "button[data-action-hint-code]",
          )
        : null;
    if (badge && !badge.hidden) {
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

  private handleCancel(event: Event) {
    event.preventDefault();
    this.dispatchCancel("escape", event);
  }

  private dispatchCancel(reason: string, originalEvent: Event) {
    this.dispatchEvent(
      new CustomEvent(ACTION_HINT_CANCEL_EVENT, {
        bubbles: true,
        detail: { reason, originalEvent },
      }),
    );
  }

  // Each badge sits at its target's start, or its end for a target that
  // asks, and inside the viewport. Sizes are read once the badges are drawn.
  private positionBadges() {
    for (const target of this.targets) {
      const badge = this.badges.get(target.code);
      if (!badge) {
        continue;
      }
      const measured = badge.getBoundingClientRect();
      if (measured.width > 0 && measured.height > 0) {
        this.badgeSizes.set(badge, {
          width: measured.width,
          height: measured.height,
        });
      }
      const bounds = this.badgeSizes.get(badge) ?? measured;
      const rect = target.visibleRect;
      const position = clampBadgePosition(
        {
          left: target.badgeAtEnd ? rect.right - bounds.width : rect.left,
          top: rect.top,
        },
        bounds,
        this.viewportRect,
      );
      badge.style.left = `${position.left}px`;
      badge.style.top = `${position.top}px`;
    }
  }

  private draw() {
    this.requestUpdate();
    this.performUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-action-hint-dialog": CaffoldActionHintDialog;
  }
}
