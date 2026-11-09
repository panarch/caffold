import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.js";
import { CaffoldElement } from "../caffold-element.js";
import { focusedElement } from "../shadow-roots.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import { inlineIcon, warmIcons } from "./icons.js";
import "./pane-resizer.js";
import type { CaffoldPaneResizer, PaneResizeDetail } from "./pane-resizer.js";

import styles from "./split-view.css.js";

// The widths where split-view.css changes how the list meets the file.
export const SPLIT_VIEW_SINGLE_MAX_WIDTH_PX = 560;
export const SPLIT_VIEW_DRAWER_MAX_WIDTH_PX = 1060;

const SINGLE_MEDIA_QUERY = `(max-width: ${SPLIT_VIEW_SINGLE_MAX_WIDTH_PX}px)`;
const DRAWER_MEDIA_QUERY = `(min-width: ${
  SPLIT_VIEW_SINGLE_MAX_WIDTH_PX + 1
}px) and (max-width: ${SPLIT_VIEW_DRAWER_MAX_WIDTH_PX}px)`;

// The drawer covers the file instead of narrowing it, so it never needs to
// be narrower than the list's starting width and leaves the file no room.
const DRAWER_START_MIN = "320";
const DRAWER_END_MIN = "0";

type SplitViewMode = "single" | "drawer" | "beside";

// What the workspace's corner toggle reads to show and hide the list.
export interface SplitViewSidePane {
  label: string;
  beside: boolean;
  collapsible: boolean;
  collapsed: boolean;
  setCollapsed(collapsed: boolean): void;
}

/**
 * A list and the file it opens, as the review file screens lay them out.
 *
 * - `single`, on a phone: the list and the file take turns.
 * - `drawer`, between a phone and a wide window: an open file takes the
 *   width and the list folds into a drawer with only its edge, a strip, in
 *   view. The strip or the corner toggle slides the drawer out over the file.
 * - `beside`, wider: the list sits beside the file, and the person may
 *   collapse it while a file is open.
 *
 * The host puts its list in the `list` slot and its file in the `detail`
 * slot, says whether a file is open, and names the list on the strip. Its
 * attributes name the list for the corner toggle (`pane-label`) and the pane
 * resizer's `storage-key`, `collapsed-storage-key`, `resizer-label`, and
 * side-by-side `start-min` and `end-min`.
 */
@customElement("caffold-split-view")
export class CaffoldSplitView extends CaffoldElement {
  static override styles = styles;

  @state()
  private accessor drawerOpen = false;
  @state()
  private accessor detailOpen = false;
  @state()
  private accessor listName = "";
  @state()
  private accessor listCount: number | null = null;

  // Where focus was when the drawer opened, so closing it returns there.
  private openedFrom: Element | null = null;
  private readonly queries: MediaQueryList[] = [];
  private readonly onModeChange = () => this.followMode();
  private readonly onKeyDown = (event: KeyboardEvent) =>
    this.closeOnEscape(event);
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly resizer = new DrawnRef<CaffoldPaneResizer>(this);
  private readonly listPane = new DrawnRef<HTMLElement>(this);
  private readonly stripIcon = new DrawnRef<HTMLElement>(this);

  override connectedCallback() {
    super.connectedCallback();
    for (const query of [SINGLE_MEDIA_QUERY, DRAWER_MEDIA_QUERY]) {
      const list = window.matchMedia(query);
      list.addEventListener("change", this.onModeChange);
      this.queries.push(list);
    }
    this.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    for (const query of this.queries.splice(0)) {
      query.removeEventListener("change", this.onModeChange);
    }
    this.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    this.drawerOpen = false;
    this.openedFrom = null;
    this.settle();
  }

  override render() {
    const drawerLimits = this.mode() === "drawer" && this.detailOpen;
    const openLabel = `Show ${this.paneLabel()}`;
    // The strip names what it folds, so its name differs from the corner
    // toggle's, which does the same.
    const listSummary = [this.listName, this.listCount ?? ""].join(" ").trim();
    const stripLabel = listSummary ? `${openLabel}, ${listSummary}` : openLabel;
    // The strip is the folded drawer's edge, so it moves with the drawer.
    return html`
      <div
        ${drawn(this.listPane)}
        class="split-view-list"
        tabindex="-1"
        @transitionend=${this.followSlide}
        @transitioncancel=${this.followSlide}
      >
        <div class="split-view-list-content"><slot name="list"></slot></div>
        <button
          ${this.hints.button({
            id: "drawer",
            label: stripLabel,
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: !this.drawerShown(),
            anchor: () => this.stripIcon.value,
          })}
          type="button"
          class="split-view-strip"
          ?inert=${this.drawerShown()}
          aria-label=${stripLabel}
          title=${openLabel}
          @click=${this.showDrawer}
        >
          <span
            ${drawn(this.stripIcon)}
            class="split-view-strip-icon"
          >${inlineIcon("ChevronRight", "", "split-view-strip-chevron")}</span>
          <span class="split-view-strip-label" aria-hidden="true">${
            this.listName
          }${
            this.listCount === null
              ? nothing
              : html` <span class="split-view-strip-count">${this.listCount}</span>`
          }</span>
        </button>
      </div>
      <caffold-pane-resizer
        ${drawn(this.resizer)}
        storage-key=${this.getAttribute("storage-key") ?? nothing}
        collapsed-storage-key=${
          this.getAttribute("collapsed-storage-key") ?? nothing
        }
        aria-label=${this.getAttribute("resizer-label") ?? nothing}
        start-min=${
          drawerLimits
            ? DRAWER_START_MIN
            : (this.getAttribute("start-min") ?? nothing)
        }
        end-min=${
          drawerLimits
            ? DRAWER_END_MIN
            : (this.getAttribute("end-min") ?? nothing)
        }
        @caffold:pane-resize=${this.followResize}
      ></caffold-pane-resizer>
      <div
        class="split-view-dim"
        aria-hidden="true"
        @click=${this.dismissDrawer}
      ></div>
      <div
        class="split-view-detail"
        ?inert=${this.drawerShown()}
      ><slot name="detail"></slot></div>
    `;
  }

  override updated() {
    this.markHost();
  }

  override firstUpdated() {
    this.applyListWidth();
  }

  setDetailOpen(open: boolean) {
    const detailOpen = Boolean(open);
    if (detailOpen === this.detailOpen) {
      return;
    }
    this.detailOpen = detailOpen;
    if (!detailOpen) {
      this.drawerOpen = false;
    }
    this.settle();
    this.announce();
  }

  // The list's name and how many files it holds, as the strip shows them.
  setListName(name: string, count: number | null = null) {
    this.listName = name;
    this.listCount = count;
  }

  // Closes the drawer when the person chooses a file from it or leaves the
  // screen.
  closeDrawer() {
    if (this.drawerOpen) {
      this.hideDrawer({ returnFocus: true });
    }
  }

  /**
   * The list as the corner toggle serves it. It sits beside the file off a
   * phone. While a file is open it collapses wide, and in the drawer it opens
   * and closes over the file.
   */
  sidePane(): SplitViewSidePane {
    const mode = this.mode();
    return {
      label: this.paneLabel(),
      beside: mode !== "single",
      collapsible: this.detailOpen,
      collapsed:
        mode === "drawer"
          ? this.detailOpen && !this.drawerOpen
          : this.collapsed(),
      setCollapsed: (collapsed: boolean) => {
        if (this.mode() === "drawer") {
          if (collapsed) {
            this.hideDrawer({ returnFocus: true });
          } else {
            this.showDrawer();
          }
          return;
        }
        this.paneResizer.setCollapsed(collapsed);
        this.requestUpdate();
        this.announce();
      },
    };
  }

  // Whether the phone layout shows the list and the file in turn.
  showsOnePane() {
    return this.mode() === "single";
  }

  // Whether the person can reach the list now.
  listShown() {
    switch (this.mode()) {
      case "single":
        return !this.detailOpen;
      case "drawer":
        return !this.detailOpen || this.drawerOpen;
      case "beside":
        return !this.collapsed();
    }
  }

  // Whether the person can reach the file pane now: the drawer covers it.
  detailShown() {
    switch (this.mode()) {
      case "single":
        return this.detailOpen;
      case "drawer":
        return !this.drawerShown();
      case "beside":
        return true;
    }
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.paneResizer.actionHintScope(pull),
    );
  }

  private mode(): SplitViewMode {
    if (window.matchMedia(SINGLE_MEDIA_QUERY).matches) {
      return "single";
    }
    return window.matchMedia(DRAWER_MEDIA_QUERY).matches ? "drawer" : "beside";
  }

  private paneLabel() {
    return this.getAttribute("pane-label") ?? "side panel";
  }

  private drawerShown() {
    return this.mode() === "drawer" && this.detailOpen && this.drawerOpen;
  }

  private collapsed() {
    return (
      this.mode() === "beside" && this.detailOpen && this.paneResizer.collapsed
    );
  }

  private dismissDrawer() {
    this.hideDrawer({ returnFocus: true });
  }

  private showDrawer() {
    if (!this.detailOpen || this.drawerOpen) {
      return;
    }
    this.openedFrom = focusedElement();
    this.toggleAttribute("sliding", true);
    this.drawerOpen = true;
    this.announce();
    void this.updateComplete.then(() => {
      if (this.drawerShown()) {
        this.listPane.value?.focus({ preventScroll: true });
      }
    });
  }

  private hideDrawer({ returnFocus }: { returnFocus: boolean }) {
    if (!this.drawerOpen) {
      return;
    }
    const openedFrom = this.openedFrom;
    this.openedFrom = null;
    this.toggleAttribute("sliding", true);
    this.drawerOpen = false;
    this.announce();
    if (!returnFocus) {
      return;
    }
    void this.updateComplete.then(() => {
      const target =
        openedFrom instanceof HTMLElement &&
        openedFrom.isConnected &&
        openedFrom.getClientRects().length > 0
          ? openedFrom
          : (this.renderRoot as ShadowRoot).querySelector<HTMLElement>(
              ".split-view-strip",
            );
      target?.focus({ preventScroll: true });
    });
  }

  private closeOnEscape(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !this.drawerShown()
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.hideDrawer({ returnFocus: true });
  }

  // Leaving the drawer's widths closes it; the file then has its own room.
  private followMode() {
    if (this.drawerOpen && this.mode() !== "drawer") {
      this.openedFrom = null;
      this.drawerOpen = false;
    }
    this.settle();
    this.requestUpdate();
    this.announce();
  }

  // The drawer's own move ended; the strip's and the rows' transitions pass
  // through as well.
  private followSlide(event: TransitionEvent) {
    if (
      event.target === this.listPane.value &&
      event.propertyName === "transform"
    ) {
      this.settle();
    }
  }

  // The drawer stopped moving, or a change that does not slide it came.
  private settle() {
    this.toggleAttribute("sliding", false);
  }

  // The host's attributes name the layout state its stylesheet draws, set as
  // soon as the state changes so a host that measures right after sees it.
  private markHost() {
    this.toggleAttribute("detail-open", this.detailOpen);
    this.toggleAttribute("collapsed", this.collapsed());
    this.toggleAttribute("drawer-open", this.drawerShown());
  }

  private announce() {
    this.markHost();
    this.dispatchEvent(
      new CustomEvent("caffold:side-pane-change", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private followResize(event: CustomEvent<PaneResizeDetail>) {
    event.stopPropagation();
    if (event.detail.phase === "start") {
      this.toggleAttribute("resizing", true);
    } else if (event.detail.phase === "end") {
      this.toggleAttribute("resizing", false);
    } else {
      this.applyListWidth();
    }
  }

  private applyListWidth() {
    this.style.setProperty(
      "--split-view-list-width",
      `${this.paneResizer.value}px`,
    );
  }

  // The resizer is drawn the first time it is needed, which can be before
  // the split view is in the document.
  private get paneResizer() {
    this.performUpdate();
    return this.resizer.value as CaffoldPaneResizer;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-split-view": CaffoldSplitView;
  }
}
