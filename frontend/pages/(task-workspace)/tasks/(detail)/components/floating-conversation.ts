import { html, nothing, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { containsAcrossShadowRoots } from "#app/shadow-roots.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";
import { inlineIcon } from "#components/icons.js";
import { SPLIT_VIEW_SINGLE_MAX_WIDTH_PX } from "#components/split-view.js";

import styles from "./floating-conversation.css.js";

// Where Detail shows the Task's conversation: as the Conversation screen,
// over a screen that shows a file, or not at all.
export type FloatingConversationPresentation = "docked" | "floating" | "hidden";

export interface FloatingConversationSnapshot {
  presentation: FloatingConversationPresentation;
  // The Task the conversation belongs to; another Task starts folded.
  subjectKey: string;
}

export interface FloatingConversationChangeDetail {
  open: boolean;
}

export const FLOATING_CONVERSATION_CHANGE_EVENT =
  "caffold:floating-conversation-change";

// The phone width, where the card opens as a sheet over the whole screen, is
// the one where Review shows its list and its file in turn.
const PHONE_QUERY = `(max-width: ${SPLIT_VIEW_SINGLE_MAX_WIDTH_PX}px)`;

// The size the person gives the card, kept on this device.
const SIZE_STORAGE_KEY = "caffold:floating-conversation-size";
// The smallest the card gets, in rem, in either direction.
const MIN_SIZE_REM = 20;
// An arrow key's step, and with Shift, as the pane resizer steps.
const KEY_STEP_PX = 24;
const KEY_STEP_LARGE_PX = 72;
// Each arrow key's change to the width and the height. The card grows from
// its bottom right corner, so left and up make it larger.
const KEY_RESIZE: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

interface CardSize {
  width: number;
  height: number;
}

// The card's size when a resize starts, and how far it may go.
interface ResizeRange extends CardSize {
  maxWidth: number;
  maxHeight: number;
  minSize: number;
}

/**
 * The Task's conversation in Detail. On the Conversation screen it is the
 * whole Detail body. Over a screen that shows a file it is a round button at
 * the bottom right, and opens from there into a card, or on a phone into a
 * sheet over the whole screen; the card's header folds it again, and the
 * card's top left corner resizes it.
 *
 * Detail places Task Detail in this element's slot once. Only the frame around
 * it changes, so the conversation, its draft, and its scroll stay as they are.
 * Whether it is open and the size the person gave it are this element's to
 * keep: Detail says where it shows and whose it is, and hears when it opens
 * and folds.
 */
@customElement("caffold-task-detail-floating-conversation")
export class CaffoldTaskDetailFloatingConversation extends CaffoldElement {
  static override styles = styles;

  @state()
  private accessor presentation: FloatingConversationPresentation = "hidden";
  @state()
  private accessor expanded = false;
  @state()
  private accessor phone = false;
  @state()
  private accessor size: CardSize | null = readStoredSize();
  @state()
  private accessor resizing = false;

  private subjectKey = "";
  private drag:
    | (ResizeRange & {
        pointerId: number;
        startX: number;
        startY: number;
      })
    | null = null;
  private readonly hints = new ActionHints(this);
  private readonly openButton = new DrawnRef<HTMLButtonElement>(this);
  private readonly scrim = new DrawnRef<HTMLElement>(this);
  private readonly card = new DrawnRef<HTMLElement>(this);
  private readonly header = new DrawnRef<HTMLButtonElement>(this);
  private readonly resizeHandle = new DrawnRef<HTMLButtonElement>(this);
  private readonly iconsReady = () => this.requestUpdate();
  private phoneQuery: MediaQueryList | null = null;
  private readonly followPhone = () => {
    this.phone = Boolean(this.phoneQuery?.matches);
  };

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.phoneQuery = window.matchMedia(PHONE_QUERY);
    this.phoneQuery.addEventListener("change", this.followPhone);
    this.followPhone();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.phoneQuery?.removeEventListener("change", this.followPhone);
    this.phoneQuery = null;
    this.drag = null;
    this.resizing = false;
  }

  setSnapshot({ presentation, subjectKey }: FloatingConversationSnapshot) {
    const subjectChanged = subjectKey !== this.subjectKey;
    this.subjectKey = subjectKey;
    this.presentation = presentation;
    if (presentation !== "floating" || subjectChanged) {
      this.setOpen(false);
    }
  }

  // Detail folds the card when the route moves under an open phone sheet,
  // such as a file link in the conversation.
  fold() {
    this.setOpen(false);
  }

  get open() {
    return this.presentation === "floating" && this.expanded;
  }

  get floating() {
    return this.presentation === "floating";
  }

  // On a phone the open card is a sheet over the whole screen, above the
  // Detail header and the workspace's corner controls, so it shows in the
  // browser's top layer as a manual popover. A popover's own backdrop lets
  // taps through, so a scrim shown just under it dims the screen and takes
  // the taps above the sheet.
  get sheet() {
    return this.open && this.phone;
  }

  // An editable in the open card leaves editing for the card's header, so a
  // second Escape folds the card.
  editingEscapeTarget(editable: Element | null) {
    return this.open && containsAcrossShadowRoots(this, editable)
      ? (this.header.value ?? null)
      : null;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  protected override updated(changed: PropertyValues) {
    if (this.dataset.presentation !== this.presentation) {
      this.dataset.presentation = this.presentation;
    }
    this.toggleAttribute("data-open", this.open);
    this.toggleAttribute("data-resizing", this.resizing);
    if (changed.has("size")) {
      this.applySize();
    }
    if (!this.sheet) {
      return;
    }
    for (const layer of [this.scrim.value, this.card.value]) {
      if (layer && !layer.matches(":popover-open")) {
        layer.showPopover();
      }
    }
  }

  override render() {
    const floating = this.floating;
    const open = this.open;
    return html`
      <button
        ${drawn(this.openButton)}
        ${this.hints.disclosure({
          id: "floating-conversation:open",
          label: "Show the conversation",
          action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          when: floating && !open,
        })}
        type="button"
        class="floating-conversation-open"
        aria-label="Show the conversation"
        aria-expanded="false"
        title="Show the conversation"
        ?hidden=${!floating || open}
        @click=${this.openCard}
      >${inlineIcon(
        "MessageSquare",
        "Show the conversation",
        "floating-conversation-icon",
      )}</button>
      <div
        ${drawn(this.scrim)}
        class="floating-conversation-scrim"
        aria-hidden="true"
        popover=${this.sheet ? "manual" : nothing}
        @click=${this.foldByPerson}
      ></div>
      <section
        ${drawn(this.card)}
        class="floating-conversation-card"
        aria-label=${floating ? "Task conversation" : nothing}
        popover=${this.sheet ? "manual" : nothing}
        ?hidden=${floating && !open}
        @keydown=${this.foldOnEscape}
      >
        <button
          ${drawn(this.header)}
          ${this.hints.disclosure({
            id: "floating-conversation:fold",
            label: "Fold the conversation",
            action: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
            when: open,
            badgeAt: "center-right",
          })}
          type="button"
          class="floating-conversation-header"
          aria-expanded="true"
          title="Fold the conversation (Esc)"
          @click=${this.foldByPerson}
        >
          ${inlineIcon("MessageSquare", "", "floating-conversation-title-icon")}
          <span class="floating-conversation-title">Conversation</span>
          ${inlineIcon(
            "ChevronDown",
            "Fold the conversation",
            "floating-conversation-fold-icon",
          )}
        </button>
        <div class="floating-conversation-body"><slot></slot></div>
      </section>
      ${open && !this.phone ? this.resizeFrame() : nothing}
    `;
  }

  // The size the person chose reaches the card and its frame through the
  // host; without one they take the size the card opens at.
  private applySize() {
    if (this.size) {
      this.style.setProperty(
        "--floating-conversation-chosen-width",
        `${this.size.width}px`,
      );
      this.style.setProperty(
        "--floating-conversation-chosen-height",
        `${this.size.height}px`,
      );
    } else {
      this.style.removeProperty("--floating-conversation-chosen-width");
      this.style.removeProperty("--floating-conversation-chosen-height");
    }
  }

  // A frame over the open card, the card's size and outside its clipped
  // corners, carries the resize handle on the card's border line, and the
  // two sides the handle moves.
  private resizeFrame() {
    return html`<div class="floating-conversation-frame">
      <button
        ${drawn(this.resizeHandle)}
        ${this.hints.separator({
          id: "floating-conversation:resize",
          label: "Resize the conversation",
          action: ACTION_HINT_ACTION.CONTROL_SEPARATOR_FOCUS,
        })}
        type="button"
        class="floating-conversation-resize"
        aria-label="Resize the conversation"
        title="Resize the conversation"
        @pointerdown=${this.startResize}
        @pointermove=${this.moveResize}
        @pointerup=${this.endResize}
        @pointercancel=${this.endResize}
        @lostpointercapture=${this.endResize}
        @keydown=${this.resizeFromKeyboard}
      >
        <svg
          class="floating-conversation-resize-mark"
          viewBox="0 0 30 30"
          aria-hidden="true"
        >
          <path d="M10.5 27V24A13.5 13.5 0 0 1 24 10.5H27" />
        </svg>
      </button>
      <span class="floating-conversation-resize-side" data-side="top"></span>
      <span class="floating-conversation-resize-side" data-side="left"></span>
    </div>`;
  }

  private openCard() {
    this.setOpen(true);
    // The person opened the card to read, so their focus waits on its
    // header rather than in the Composer.
    void this.updateComplete.then(() =>
      this.header.value?.focus({ preventScroll: true }),
    );
  }

  // Folding by the person's own hand returns their focus to the button the
  // card opened from.
  private foldByPerson() {
    if (!this.open) {
      return;
    }
    this.setOpen(false);
    void this.updateComplete.then(() =>
      this.openButton.value?.focus({ preventScroll: true }),
    );
  }

  // Escape while editing belongs to the editable and the keyboard mode,
  // which end editing on the card's header; the next Escape folds the card.
  // A menu or dialog open in the card closes first.
  private foldOnEscape(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !this.open ||
      editingTarget(event) ||
      insideOpenLayer(event, this.card.value)
    ) {
      return;
    }
    event.preventDefault();
    this.foldByPerson();
  }

  private startResize(event: PointerEvent) {
    const range = this.resizeRange();
    if (!range || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }
    event.preventDefault();
    this.drag = {
      ...range,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    this.resizing = true;
  }

  private moveResize(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    event.preventDefault();
    this.size = clampSize(
      drag.width + drag.startX - event.clientX,
      drag.height + drag.startY - event.clientY,
      drag,
    );
  }

  private endResize(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    this.drag = null;
    this.resizing = false;
    const handle = event.currentTarget as Element;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    this.keepSize();
  }

  // The arrow keys resize the card. Escape leaves the handle for the card's
  // header, as it leaves the Composer, so the next Escape folds the card.
  private resizeFromKeyboard(event: KeyboardEvent) {
    if (
      event.key === "Escape" &&
      !event.isComposing &&
      !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    ) {
      event.preventDefault();
      this.header.value?.focus({ preventScroll: true });
      return;
    }
    const direction = KEY_RESIZE[event.key];
    if (!direction || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const range = this.resizeRange();
    if (!range) {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? KEY_STEP_LARGE_PX : KEY_STEP_PX;
    this.size = clampSize(
      range.width + direction[0] * step,
      range.height + direction[1] * step,
      range,
    );
    this.keepSize();
  }

  // The card's size now, from its box, and the room the body leaves it: the
  // card keeps the same inset from the body's edges that it keeps at the
  // bottom right.
  private resizeRange(): ResizeRange | null {
    const card = this.card.value;
    if (!this.open || this.phone || !card) {
      return null;
    }
    const body = this.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const inset = body.right - box.right;
    const rootSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    return {
      width: box.width,
      height: box.height,
      maxWidth: body.width - 2 * inset,
      maxHeight: box.bottom - body.top - inset,
      minSize: MIN_SIZE_REM * rootSize,
    };
  }

  private keepSize() {
    if (!this.size) {
      return;
    }
    try {
      window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(this.size));
    } catch {
      // localStorage can be unavailable in private or restricted contexts.
    }
  }

  private setOpen(open: boolean) {
    const next = open && this.presentation === "floating";
    if (next === this.expanded) {
      return;
    }
    this.expanded = next;
    this.drag = null;
    this.resizing = false;
    this.dispatchEvent(
      new CustomEvent<FloatingConversationChangeDetail>(
        FLOATING_CONVERSATION_CHANGE_EVENT,
        { bubbles: true, composed: true, detail: { open: next } },
      ),
    );
  }
}

// A size within the range, whole pixels.
function clampSize(width: number, height: number, range: ResizeRange) {
  const clamp = (value: number, max: number) =>
    Math.round(Math.max(range.minSize, Math.min(value, max)));
  return {
    width: clamp(width, range.maxWidth),
    height: clamp(height, range.maxHeight),
  };
}

function readStoredSize(): CardSize | null {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SIZE_STORAGE_KEY) ?? "null",
    );
    const width = Number(stored?.width);
    const height = Number(stored?.height);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

// Whether a key event started in a popover or dialog shown over the card,
// which owns its own Escape.
function insideOpenLayer(event: Event, card: Element | null | undefined) {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        target !== card &&
        (target instanceof HTMLDialogElement ||
          target.matches(":popover-open")),
    );
}

// Whether a key event started in a field the person types into.
function editingTarget(event: Event) {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement &&
      !["button", "checkbox", "radio", "reset", "submit"].includes(target.type))
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-detail-floating-conversation": CaffoldTaskDetailFloatingConversation;
  }

  interface HTMLElementEventMap {
    [FLOATING_CONVERSATION_CHANGE_EVENT]: CustomEvent<FloatingConversationChangeDetail>;
  }
}
