export function differencePixels(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  out: Uint8ClampedArray,
) {
  // Compares two pictures of one size, given as RGBA bytes, and draws the
  // result into `out`: a changed pixel in CHANGED_COLOR, an unchanged one as
  // a faint grey copy of After, so the changes can be placed in the picture.
  // Returns how many pixels changed.
  let changed = 0;
  for (let index = 0; index < after.length; index += 4) {
    if (pixelChanged(before, after, index)) {
      changed += 1;
      out[index] = CHANGED_COLOR[0];
      out[index + 1] = CHANGED_COLOR[1];
      out[index + 2] = CHANGED_COLOR[2];
      out[index + 3] = 255;
      continue;
    }
    const grey = Math.round(
      0.299 * after[index] +
        0.587 * after[index + 1] +
        0.114 * after[index + 2],
    );
    out[index] = grey;
    out[index + 1] = grey;
    out[index + 2] = grey;
    out[index + 3] = Math.round(after[index + 3] * UNCHANGED_OPACITY);
  }
  return changed;
}

export function formatChangedShare(changed: number, total: number) {
  // The share of pixels that changed, as the caption says it: one decimal,
  // and a change too small for one decimal still reads as a change.
  const share = total > 0 ? (changed / total) * 100 : 0;
  if (share > 0 && share < 0.1) {
    return "< 0.1%";
  }
  return `${share.toFixed(1)}%`;
}

// A pixel counts as changed when one of its channels moves by more than this,
// out of 255, so the noise of saving a picture again does not light it up.
export const CHANNEL_TOLERANCE = 12;

// The color a changed pixel is drawn in, in both themes.
export const CHANGED_COLOR: readonly [number, number, number] = [229, 46, 63];

// How strongly an unchanged pixel shows.
const UNCHANGED_OPACITY = 0.22;

function pixelChanged(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  index: number,
) {
  for (let channel = 0; channel < 4; channel += 1) {
    if (
      Math.abs(before[index + channel] - after[index + channel]) >
      CHANNEL_TOLERANCE
    ) {
      return true;
    }
  }
  return false;
}
