import {
  type PageAnchor,
  readPageAnchor,
  scrollToPageAnchor,
} from "./page-anchor.js";

// The size a preview is drawn at, as the person chose it in the file viewer.
// A fit is a rule that follows the room the viewer has: `width` fits each page
// to the width, `page` fits each whole page, and neither enlarges a page past
// its own size. A percent is one scale for every page, of the page's own size.
export type ViewerZoom = { fit: "width" | "page" } | { percent: number };

export interface ZoomSize {
  width: number;
  height: number;
}

// What a viewer says when the scale it shows changes: the percent of its own
// size that the page at the top is drawn at.
export interface ViewerZoomShownDetail {
  percent: number;
}

// The scale a page of `size` is drawn at in `room`.
export function zoomScale(zoom: ViewerZoom, size: ZoomSize, room: ZoomSize) {
  if ("percent" in zoom) {
    return zoom.percent / 100;
  }
  const byWidth = room.width / size.width;
  return Math.min(
    1,
    zoom.fit === "page"
      ? Math.min(byWidth, room.height / size.height)
      : byWidth,
  );
}

// The room a scrollport gives what it scrolls: its inner size less padding.
export function zoomRoom(scrollport: HTMLElement): ZoomSize {
  const style = getComputedStyle(scrollport);
  return {
    width:
      scrollport.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight),
    height:
      scrollport.clientHeight -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom),
  };
}

// A phone would otherwise allocate a canvas proportional to its full device
// pixel ratio for every page it draws.
const MAX_CANVAS_PIXEL_RATIO = 2;
// Safari on an iPhone draws nothing into a canvas of more pixels than this.
const MAX_CANVAS_PIXELS = 4096 * 4096;

// The canvas pixels for each CSS pixel of a page drawn `width` by `height`.
// A page zoomed far in is drawn coarser rather than not at all; the ratio is
// kept just under the limit, so rounding each side up cannot pass it.
export function canvasPixelRatio(
  width: number,
  height: number,
  deviceRatio: number,
) {
  const ratio = Math.min(deviceRatio || 1, MAX_CANVAS_PIXEL_RATIO);
  const fitting =
    Math.floor(Math.sqrt(MAX_CANVAS_PIXELS / (width * height)) * 1000) / 1000;
  return Math.min(ratio, fitting);
}

// Says the scale a viewer shows whenever it changes.
export class ShownZoom {
  private readonly host: HTMLElement;
  private percent: number | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  report(scale: number | null) {
    if (scale === null || !Number.isFinite(scale)) {
      return;
    }
    const percent = scale * 100;
    if (percent === this.percent) {
      return;
    }
    this.percent = percent;
    this.host.dispatchEvent(
      new CustomEvent<ViewerZoomShownDetail>("caffold:viewer-zoom-shown", {
        detail: { percent },
      }),
    );
  }

  // A document shown anew says its scale again, even an equal one.
  forget() {
    this.percent = null;
  }
}

// Where a scrollport is read, kept across a change of zoom: the page at its top
// edge and how far into it when it shows pages, and the middle of what it shows
// across, and down when it shows no pages.
export interface ZoomPlace {
  anchor: PageAnchor | null;
  across: number;
  down: number;
}

export function readZoomPlace(
  scrollport: HTMLElement,
  pages: readonly Element[],
): ZoomPlace {
  return {
    anchor: readPageAnchor(scrollport, pages),
    across: middleShare(
      scrollport.scrollLeft,
      scrollport.clientWidth,
      scrollport.scrollWidth,
    ),
    down: middleShare(
      scrollport.scrollTop,
      scrollport.clientHeight,
      scrollport.scrollHeight,
    ),
  };
}

export function returnToZoomPlace(
  scrollport: HTMLElement,
  pages: readonly Element[],
  place: ZoomPlace,
) {
  if (place.anchor) {
    scrollToPageAnchor(scrollport, pages, place.anchor);
  } else {
    scrollport.scrollTop =
      place.down * scrollport.scrollHeight - scrollport.clientHeight / 2;
  }
  scrollport.scrollLeft =
    place.across * scrollport.scrollWidth - scrollport.clientWidth / 2;
}

function middleShare(start: number, view: number, extent: number) {
  return extent > 0 ? (start + view / 2) / extent : 0.5;
}

declare global {
  interface HTMLElementEventMap {
    "caffold:viewer-zoom-shown": CustomEvent<ViewerZoomShownDetail>;
  }
}
