// Which rows or columns of a sheet's scrolling part a viewport shows. Track
// sizes come from the workbook, so the offsets are prefix sums over them; the
// frozen tracks before `start` stay outside the scrolling part.

export function trackOffsets(sizes, start = 0) {
  const offsets = new Float64Array(Math.max(sizes.length - start, 0) + 1);
  for (let index = start; index < sizes.length; index += 1) {
    offsets[index - start + 1] = offsets[index - start] + sizes[index];
  }
  return offsets;
}

// The tracks a viewport from `position` over `extent` pixels touches, as
// absolute indices, widened by `overscan` tracks on each side.
export function visibleTracks(offsets, start, position, extent, overscan = 0) {
  const count = offsets.length - 1;
  if (count <= 0) {
    return { first: start, last: start - 1 };
  }
  const first = Math.max(lastOffsetAtOrBefore(offsets, position) - overscan, 0);
  const last = Math.min(
    lastOffsetAtOrBefore(offsets, position + Math.max(extent, 0)) + overscan,
    count - 1,
  );
  return { first: start + first, last: start + Math.max(last, first) };
}

// Grows a range of rows and columns until every merge that touches it lies
// inside, so a merged cell is drawn whole from its origin.
export function coverMerges(range, merges) {
  let { top, bottom, left, right } = range;
  let changed = true;
  while (changed) {
    changed = false;
    for (const merge of merges) {
      const touches = merge.top <= bottom && merge.bottom >= top &&
        merge.left <= right && merge.right >= left;
      if (!touches) {
        continue;
      }
      if (merge.top < top || merge.bottom > bottom || merge.left < left || merge.right > right) {
        top = Math.min(top, merge.top);
        bottom = Math.max(bottom, merge.bottom);
        left = Math.min(left, merge.left);
        right = Math.max(right, merge.right);
        changed = true;
      }
    }
  }
  return { top, bottom, left, right };
}

export function containsRange(outer, inner) {
  return Boolean(outer) &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom &&
    inner.left >= outer.left &&
    inner.right <= outer.right;
}

function lastOffsetAtOrBefore(offsets, position) {
  let low = 0;
  let high = offsets.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
