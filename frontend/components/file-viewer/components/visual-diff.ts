import { html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { formatBytes } from "../../dom.js";
import { DrawnRef, drawn } from "../../drawn-refs.js";
import "../../loading-text.js";
import {
  type PageAnchor,
  readPageAnchor,
  scrollToPageAnchor,
} from "../../page-anchor.js";
import "../../segmented-control.js";
import type {
  CaffoldSegmentedControl,
  SegmentedControlIntentDetail,
} from "../../segmented-control.js";
import {
  CHANGED_COLOR,
  differencePixels,
  formatChangedShare,
} from "./visual-diff/difference.js";

import styles from "./visual-diff.css.js";

// One side of a change as the file viewer fetched it.
export type VisualSide =
  | { status: "loading" }
  | { status: "fetched"; url: string; bytes: number }
  | { status: "failed" };

// The two sides of a change, each absent where the file does not exist.
export interface VisualSides {
  before: VisualSide | null;
  after: VisualSide | null;
}

// How the two sides are compared. The file viewer keeps it, so it stays
// while files and representations change.
export type VisualMode = "side" | "difference";

export interface VisualModeIntentDetail {
  mode: VisualMode;
}

type SideKey = keyof VisualSides;

// A fetched side decoded into a picture, or one the browser could not draw.
type Picture =
  | { url: string; image: HTMLImageElement; width: number; height: number }
  | { url: string; failed: true };

// What one present side shows once every present side is settled.
type SideView =
  | { key: SideKey; label: string; status: "waiting" }
  | { key: SideKey; label: string; status: "failed" }
  | {
      key: SideKey;
      label: string;
      status: "drawn";
      url: string;
      bytes: number;
      width: number;
      height: number;
    };

type Difference =
  | { key: string; status: "comparing" }
  | {
      key: string;
      status: "ready";
      url: string;
      changed: number;
      total: number;
      width: number;
      height: number;
    };

const SIDES: ReadonlyArray<readonly [SideKey, string]> = [
  ["before", "Before"],
  ["after", "After"],
];

const MODES = [
  { value: "side", label: "Side by side" },
  { value: "difference", label: "Difference" },
];

// The pictures on each side of a change: side by side, or the pixels that
// differ between them.
@customElement("caffold-visual-diff")
export class CaffoldVisualDiff extends CaffoldElement {
  static override styles = styles;

  @state()
  private accessor sides: VisualSides | null = null;
  @state()
  private accessor mode: VisualMode = "side";
  @state()
  private accessor pictures: Partial<Record<SideKey, Picture>> = {};
  @state()
  private accessor difference: Difference | null = null;

  private readonly hints = new ActionHints(this);
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly stage = new DrawnRef<HTMLDivElement>(this);
  private readonly modeControl = new DrawnRef<CaffoldSegmentedControl>(this);
  // Where the stage was last read, by the picture at its top, while its
  // pictures were drawn. A stage taken off the page reads 0, so it is kept as
  // the person scrolls.
  private readingAnchor: PageAnchor | null = null;
  // A place handed over is returned to once the pictures are drawn; until
  // then the stage shows no picture to read.
  private returnDue = false;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseDifference();
  }

  override render() {
    const sides = this.sides;
    if (!sides) {
      return nothing;
    }
    const views = SIDES.filter(([key]) => sides[key]).map(([key, label]) =>
      this.sideView(key, label),
    );
    if (views.length === 0) {
      return html`<p class="surface-message">No change for this file.</p>`;
    }
    const both = views.length === 2;
    const settled = views.every((view) => view.status !== "waiting");
    return html`
      ${
        both
          ? html`<div class="visual-bar" @caffold:segmented-control-intent=${this.chooseMode}>
              <caffold-segmented-control
                ${drawn(this.modeControl)}
              ></caffold-segmented-control>
            </div>`
          : nothing
      }
      <div
        ${drawn(this.stage)}
        ${this.surfaces.surface({
          id: "scroll",
          axes: ["vertical", "horizontal"],
          clipRoots: () => [this, this.stage.value],
        })}
        class="visual-stage"
        @scroll=${{ handleEvent: () => this.recordReading(), passive: true }}
      >
        ${
          !settled
            ? html`<caffold-loading-text>Loading images...</caffold-loading-text>`
            : both && this.mode === "difference"
              ? this.renderDifference(views)
              : this.renderSideBySide(views)
        }
      </div>
      <slot name="end"></slot>
    `;
  }

  override updated() {
    this.modeControl.value?.setSnapshot({
      label: "Visual comparison",
      actionVerb: "Show",
      selected: this.mode,
      choices: MODES,
    });
    const stage = this.stage.value;
    const pictures = this.pictureBoxes();
    if (this.returnDue && stage && pictures.length && this.readingAnchor) {
      this.returnDue = false;
      scrollToPageAnchor(stage, pictures, this.readingAnchor);
    }
  }

  // The file viewer hands each side over as it is fetched, with the way they
  // are compared. A side fetched anew is decoded here, so both ways of
  // comparing draw from one picture. `position`, which the viewer's owner
  // gives with a change it shows, is where that change opens.
  setComparison({
    sides,
    mode,
    position,
  }: {
    sides: VisualSides;
    mode: VisualMode;
    position?: PageAnchor | null;
  }) {
    if (position !== undefined) {
      this.readingAnchor = position;
      this.returnDue = position !== null;
    }
    this.sides = sides;
    this.mode = mode;
    // A difference drawn from other pictures goes.
    if (this.difference && this.difference.key !== differenceKey(sides)) {
      this.releaseDifference();
    }
    for (const [key] of SIDES) {
      const side = sides[key];
      if (side?.status === "fetched" && this.pictures[key]?.url !== side.url) {
        this.decode(key, side.url);
      }
    }
    this.compareWhenReady();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      this.modeControl.value?.actionHintScope({
        scopeId: `${pull.scopeId}:mode`,
        actionId: pull.actions?.button,
        clipRoots: [this, ...(pull.clipRoots ?? [])],
      }),
    );
  }

  scrollSurfaceScope({ label = "Visual", ...pull }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, label });
  }

  readingPosition() {
    return this.readingAnchor;
  }

  private renderSideBySide(views: SideView[]) {
    const drawnViews = views.filter((view) => view.status === "drawn");
    return html`<div
      class="side-by-side"
      data-sides=${views.length}
      style=${sizeStyle(drawnViews)}
    >
      ${views.map(
        (view) => html`<figure data-side=${view.key}>
          <figcaption class="caption">
            <strong>${view.label}</strong>
            ${
              view.status === "drawn"
                ? html`<span>${pictureFacts(view)}</span>`
                : nothing
            }
          </figcaption>
          ${
            view.status === "drawn"
              ? html`<img
                  src=${view.url}
                  alt=${view.label}
                  style="--natural-width: ${view.width}; --natural-height: ${view.height};"
                >`
              : html`<p class="surface-message side-message">This picture could not be loaded.</p>`
          }
        </figure>`,
      )}
    </div>`;
  }

  private renderDifference(views: SideView[]) {
    const failed = views
      .filter((view) => view.status === "failed")
      .map((view) => view.label);
    if (failed.length > 0) {
      return html`<div class="surface-message difference-message">
        <p>Difference needs both pictures.</p>
        <p>${failed.join(" and ")} could not be loaded.</p>
      </div>`;
    }
    const [before, after] = views;
    if (before.status !== "drawn" || after.status !== "drawn") {
      return nothing;
    }
    if (before.width !== after.width || before.height !== after.height) {
      return html`<div class="surface-message difference-message">
        <p>Difference compares pictures of the same size.</p>
        <p>
          Before is ${before.width} × ${before.height} and After is
          ${after.width} × ${after.height}. Side by side shows both.
        </p>
      </div>`;
    }
    const difference = this.difference;
    if (difference?.status !== "ready") {
      return html`<caffold-loading-text>Comparing images...</caffold-loading-text>`;
    }
    return html`<div class="difference" style=${sizeStyle([difference])}>
      <div class="difference-captions">
        <p class="caption">
          <strong>Difference</strong>
          <span>${formatChangedShare(difference.changed, difference.total)} of pixels changed</span>
        </p>
        <p class="caption">
          <span
            class="swatch"
            style="--changed-color: rgb(${CHANGED_COLOR.join(" ")});"
            aria-hidden="true"
          ></span>
          <span>Changed</span>
        </p>
      </div>
      <img
        src=${difference.url}
        alt="Changed pixels"
        style="--natural-width: ${difference.width}; --natural-height: ${difference.height};"
      >
    </div>`;
  }

  private sideView(key: SideKey, label: string): SideView {
    const side = this.sides?.[key];
    if (!side || side.status === "loading") {
      return { key, label, status: "waiting" };
    }
    if (side.status === "failed") {
      return { key, label, status: "failed" };
    }
    const picture = this.pictures[key];
    if (picture?.url !== side.url) {
      return { key, label, status: "waiting" };
    }
    if ("failed" in picture) {
      return { key, label, status: "failed" };
    }
    return {
      key,
      label,
      status: "drawn",
      url: side.url,
      bytes: side.bytes,
      width: picture.width,
      height: picture.height,
    };
  }

  private chooseMode(event: CustomEvent<SegmentedControlIntentDetail>) {
    // The viewer keeps the choice; no review surface above owns it.
    event.stopPropagation();
    const mode = event.detail?.value;
    if (mode === "side" || mode === "difference") {
      this.dispatchEvent(
        new CustomEvent<VisualModeIntentDetail>(
          "caffold:visual-diff-mode-intent",
          {
            detail: { mode },
          },
        ),
      );
    }
  }

  private decode(key: SideKey, url: string) {
    const image = new Image();
    image.src = url;
    const current = () => {
      const side = this.sides?.[key];
      return side?.status === "fetched" && side.url === url;
    };
    image.decode().then(
      () => {
        if (current()) {
          this.pictures = {
            ...this.pictures,
            [key]: {
              url,
              image,
              width: image.naturalWidth,
              height: image.naturalHeight,
            },
          };
          this.compareWhenReady();
        }
      },
      () => {
        if (current()) {
          this.pictures = { ...this.pictures, [key]: { url, failed: true } };
        }
      },
    );
  }

  // Difference is worked out once for each pair of pictures, when it is
  // shown and both are drawn at one size.
  private compareWhenReady() {
    if (this.mode !== "difference") {
      return;
    }
    const before = this.sideView("before", "Before");
    const after = this.sideView("after", "After");
    if (
      before.status !== "drawn" ||
      after.status !== "drawn" ||
      before.width !== after.width ||
      before.height !== after.height
    ) {
      return;
    }
    const key = differenceKey(this.sides);
    if (this.difference?.key === key) {
      return;
    }
    this.releaseDifference();
    this.difference = { key, status: "comparing" };
    const pictures = this.pictures;
    // Comparing a large picture takes a moment; the wait shows first.
    window.setTimeout(() => {
      if (this.difference?.key === key) {
        void this.compare(key, pictures, before.width, before.height);
      }
    });
  }

  private async compare(
    key: string,
    pictures: Partial<Record<SideKey, Picture>>,
    width: number,
    height: number,
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const before = pictures.before;
    const after = pictures.after;
    if (
      !context ||
      !before ||
      !after ||
      "failed" in before ||
      "failed" in after
    ) {
      return;
    }
    context.drawImage(before.image, 0, 0, width, height);
    const beforePixels = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(after.image, 0, 0, width, height);
    const afterPixels = context.getImageData(0, 0, width, height).data;
    const result = context.createImageData(width, height);
    const changed = differencePixels(beforePixels, afterPixels, result.data);
    context.putImageData(result, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve),
    );
    if (!blob || this.difference?.key !== key || !this.isConnected) {
      return;
    }
    this.difference = {
      key,
      status: "ready",
      url: URL.createObjectURL(blob),
      changed,
      total: width * height,
      width,
      height,
    };
  }

  private recordReading() {
    const stage = this.stage.value;
    const pictures = this.pictureBoxes();
    if (!this.returnDue && stage && pictures.length) {
      this.readingAnchor =
        readPageAnchor(stage, pictures) ?? this.readingAnchor;
    }
  }

  // The drawn pictures in the stage, each with its caption: both sides, or
  // the difference.
  private pictureBoxes() {
    return [
      ...(this.stage.value?.querySelectorAll<HTMLElement>(
        ":scope > .side-by-side > figure, :scope > .difference",
      ) ?? []),
    ];
  }

  private releaseDifference() {
    if (this.difference?.status === "ready") {
      URL.revokeObjectURL(this.difference.url);
    }
    this.difference = null;
  }
}

// Names the pair of fetched pictures a difference is drawn from.
function differenceKey(sides: VisualSides | null) {
  const before = sides?.before;
  const after = sides?.after;
  return before?.status === "fetched" && after?.status === "fetched"
    ? `${before.url} ${after.url}`
    : "";
}

// The size every picture is scaled against, so both sides share one scale.
function sizeStyle(pictures: Array<{ width: number; height: number }>) {
  const width = Math.max(1, ...pictures.map((picture) => picture.width));
  const height = Math.max(1, ...pictures.map((picture) => picture.height));
  return `--max-natural-width: ${width}; --max-natural-height: ${height};`;
}

function pictureFacts(view: { width: number; height: number; bytes: number }) {
  return `${view.width} × ${view.height} · ${formatBytes(view.bytes)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-visual-diff": CaffoldVisualDiff;
  }

  interface HTMLElementEventMap {
    "caffold:visual-diff-mode-intent": CustomEvent<VisualModeIntentDetail>;
  }
}
