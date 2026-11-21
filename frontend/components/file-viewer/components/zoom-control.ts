import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";
import { DrawnRef, drawn } from "../../drawn-refs.js";
import { inlineIcon, warmIcons } from "../../icons.js";
import "../../segmented-control.js";
import type {
  CaffoldSegmentedControl,
  SegmentedControlIntentDetail,
} from "../../segmented-control.js";
import type { ViewerZoom } from "../../viewer-zoom.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import styles from "./zoom-control.css.js";

// What the control shows: the size chosen, and the percent the preview is
// drawn at, which is unknown until it is drawn.
export interface ZoomControlSnapshot {
  zoom: ViewerZoom;
  percent: number | null;
}

// A size the person chose. `dragging` holds while they hold the slider; a
// viewer that draws pictures waits until it ends to draw them again.
export interface ZoomControlIntentDetail {
  zoom: ViewerZoom;
  dragging: boolean;
}

// The percents that − and + and the slider's arrow keys move between.
const ZOOM_STEPS = [
  10, 25, 33, 50, 67, 75, 90, 100, 125, 150, 200, 300, 400,
] as const;
const MIN_PERCENT = ZOOM_STEPS[0];
const MAX_PERCENT = ZOOM_STEPS[ZOOM_STEPS.length - 1];
// The slider's notches: 100% is the middle, and each half runs by ratio.
const SLIDER_END = 1000;
// A percent shown rounded is at the step it reads as.
const STEP_TOLERANCE = 0.5;

const FIT_CHOICES = [
  {
    value: "width",
    label: "Fit width",
    icon: "AlignHorizontalSpaceAround",
    title: "Fit width",
  },
  { value: "page", label: "Fit page", icon: "Scan", title: "Fit page" },
];

// What the file viewer's Zoom opens. Its owner makes the host the popover and
// puts the keyboard presentation in its slot.
@customElement("caffold-zoom-control")
export class CaffoldZoomControl extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: ZoomControlSnapshot = {
    zoom: { fit: "width" },
    percent: null,
  };
  // The percent shown: the snapshot's, or the one just chosen here until the
  // preview reports another. A second step moves from the first one at once.
  @state()
  private accessor percent: number | null = null;

  static override styles = [
    scopedStyle(compactIconButton, ".zoom-step"),
    styles,
  ];

  private readonly hints = new ActionHints(this);
  private readonly fitControl = new DrawnRef<CaffoldSegmentedControl>(this);
  private readonly slider = new DrawnRef<HTMLInputElement>(this);
  private readonly percentField = new DrawnRef<HTMLInputElement>(this);
  // Whether a finger or the mouse holds the slider. A change it makes is any
  // size; a change while nothing holds it is one notch from the keyboard or a
  // screen reader, and moves one step.
  private holding = false;
  // Whether the held slider has moved since it was taken hold of.
  private dragged = false;
  // Whether the person is typing a percent, which a newer snapshot leaves be.
  private editing = false;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("snapshot") &&
      changed.get("snapshot")?.percent !== this.snapshot.percent
    ) {
      this.percent = this.snapshot.percent;
    }
  }

  override render() {
    const percent = this.percent;
    const drawnAt = percent !== null;
    const text = drawnAt ? formatPercent(percent) : "";
    return html`
      <caffold-segmented-control
        ${drawn(this.fitControl)}
        class="zoom-fit"
        @caffold:segmented-control-intent=${this.chooseFit}
      ></caffold-segmented-control>
      <div class="zoom-steps">
        <button
          ${this.hints.button({
            id: "out",
            label: "Zoom out",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: drawnAt && percent > MIN_PERCENT,
          })}
          type="button"
          class="zoom-step"
          data-zoom-step="out"
          aria-label="Zoom out"
          title="Zoom out"
          ?disabled=${!drawnAt || percent <= MIN_PERCENT}
          @click=${() => this.step(-1)}
        >${inlineIcon("Minus", "", "zoom-step-icon")}</button>
        <input
          ${drawn(this.slider)}
          ${this.hints.range({
            id: "slider",
            label: `Zoom (${text})`,
            action: ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS,
            when: drawnAt,
          })}
          class="zoom-slider"
          type="range"
          min="0"
          max=${SLIDER_END}
          step="1"
          aria-label="Zoom"
          aria-valuetext=${text}
          ?disabled=${!drawnAt}
          @pointerdown=${this.hold}
          @pointerup=${this.letGo}
          @pointercancel=${this.letGo}
          @input=${this.slide}
          @change=${this.settle}
        >
        <button
          ${this.hints.button({
            id: "in",
            label: "Zoom in",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
            when: drawnAt && percent < MAX_PERCENT,
          })}
          type="button"
          class="zoom-step"
          data-zoom-step="in"
          aria-label="Zoom in"
          title="Zoom in"
          ?disabled=${!drawnAt || percent >= MAX_PERCENT}
          @click=${() => this.step(1)}
        >${inlineIcon("Plus", "", "zoom-step-icon")}</button>
        <input
          ${drawn(this.percentField)}
          ${this.hints.textbox({
            id: "percent",
            label: "Zoom percent",
            action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
            when: drawnAt,
          })}
          class="zoom-percent"
          type="text"
          inputmode="numeric"
          enterkeyhint="done"
          autocomplete="off"
          aria-label="Zoom percent"
          ?disabled=${!drawnAt}
          @focus=${this.startEditing}
          @blur=${this.stopEditing}
          @keydown=${this.typePercent}
        >
      </div>
      <slot></slot>
    `;
  }

  // The slider and the percent follow the snapshot, except while the person
  // holds the one or types in the other.
  override updated() {
    const { zoom } = this.snapshot;
    const percent = this.percent;
    this.fitControl.value?.setSnapshot({
      label: "Fit",
      actionVerb: "Choose",
      selected: "fit" in zoom ? zoom.fit : "",
      choices: FIT_CHOICES,
    });
    const slider = this.slider.value;
    if (slider && !this.holding) {
      slider.value = `${sliderPosition(percent ?? 100)}`;
    }
    const field = this.percentField.value;
    if (field && !this.editing) {
      field.value = percent === null ? "" : formatPercent(percent);
    }
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.fitControl.value?.actionHintScope({
        ...pull,
        scopeId: `${pull.scopeId}:fit`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      }),
    );
  }

  private readonly iconsReady = () => this.requestUpdate();

  private chooseFit(event: CustomEvent<SegmentedControlIntentDetail>) {
    event.stopPropagation();
    const fit = event.detail.value;
    if (fit === "width" || fit === "page") {
      this.intend({ fit }, false);
    }
  }

  private step(direction: 1 | -1) {
    const percent = this.percent;
    if (percent !== null) {
      this.intend({ percent: nextStep(percent, direction) }, false);
    }
  }

  private hold() {
    this.holding = true;
  }

  private letGo() {
    this.holding = false;
    this.settle();
  }

  private slide(event: Event) {
    const slider = event.currentTarget as HTMLInputElement;
    const position = slider.valueAsNumber;
    if (this.holding) {
      this.dragged = true;
      this.intend({ percent: sliderPercent(position) }, true);
      return;
    }
    const percent = this.percent;
    if (percent === null) {
      return;
    }
    // The browser has already moved the slider a notch, or to an end; it moves
    // a step instead, before anything is drawn at the notch.
    const next =
      position <= 0
        ? MIN_PERCENT
        : position >= SLIDER_END
          ? MAX_PERCENT
          : nextStep(percent, position > sliderPosition(percent) ? 1 : -1);
    slider.value = `${sliderPosition(next)}`;
    this.intend({ percent: next }, false);
  }

  // A drag ends where the slider was let go of, whichever of letting go and
  // the change the browser reports first.
  private settle() {
    const slider = this.slider.value;
    if (!this.dragged || !slider) {
      return;
    }
    this.dragged = false;
    this.intend({ percent: sliderPercent(slider.valueAsNumber) }, false);
  }

  private startEditing(event: FocusEvent) {
    this.editing = true;
    (event.currentTarget as HTMLInputElement).select();
  }

  // What was typed and not entered gives way to the percent shown.
  private stopEditing(event: FocusEvent) {
    this.editing = false;
    const percent = this.percent;
    (event.currentTarget as HTMLInputElement).value =
      percent === null ? "" : formatPercent(percent);
  }

  private typePercent(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.isComposing) {
      return;
    }
    event.preventDefault();
    const field = event.currentTarget as HTMLInputElement;
    const typed = readPercent(field.value);
    const shown = typed ?? this.percent;
    field.value = shown === null ? "" : formatPercent(shown);
    field.select();
    if (typed !== null) {
      this.intend({ percent: typed }, false);
    }
  }

  private intend(zoom: ViewerZoom, dragging: boolean) {
    if ("percent" in zoom) {
      this.percent = zoom.percent;
    }
    this.dispatchEvent(
      new CustomEvent<ZoomControlIntentDetail>("caffold:zoom-control-intent", {
        detail: { zoom, dragging },
      }),
    );
  }
}

// The nearest step past `percent` in `direction`, or `percent` itself at the
// end of the steps.
export function nextStep(percent: number, direction: 1 | -1) {
  const step =
    direction > 0
      ? ZOOM_STEPS.find((value) => value > percent + STEP_TOLERANCE)
      : ZOOM_STEPS.findLast((value) => value < percent - STEP_TOLERANCE);
  return step ?? percent;
}

// The percent at a notch of the slider.
export function sliderPercent(position: number) {
  const half = SLIDER_END / 2;
  return position <= half
    ? MIN_PERCENT * (100 / MIN_PERCENT) ** (position / half)
    : 100 * (MAX_PERCENT / 100) ** ((position - half) / half);
}

// The notch nearest `percent`; a percent past either end sits at that end.
export function sliderPosition(percent: number) {
  const clamped = Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent));
  const half = SLIDER_END / 2;
  return Math.round(
    clamped <= 100
      ? half * (Math.log(clamped / MIN_PERCENT) / Math.log(100 / MIN_PERCENT))
      : half + half * (Math.log(clamped / 100) / Math.log(MAX_PERCENT / 100)),
  );
}

// The percent typed, as "150" or "150%", kept within the steps' ends; null
// for text that is not a number.
export function readPercent(text: string) {
  const typed = Number.parseFloat(text.replace("%", "").trim());
  return Number.isFinite(typed)
    ? Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, typed))
    : null;
}

function formatPercent(percent: number) {
  return `${Math.round(percent)}%`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-zoom-control": CaffoldZoomControl;
  }

  interface HTMLElementEventMap {
    "caffold:zoom-control-intent": CustomEvent<ZoomControlIntentDetail>;
  }
}
