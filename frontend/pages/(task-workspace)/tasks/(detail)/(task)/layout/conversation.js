import {
  applyDetailRange,
  applyProjectionDelta,
  eventIdentityKey,
  taskEventPosition,
} from "../../../task-events.js";

// Publication revisions apply only to the identities or membership extents
// the server supplied. Extents also remember deletions, so an unseen stale
// delta cannot resurrect an item removed by a newer snapshot.
export class ConversationProjection {
  constructor() {
    this.reset();
  }

  reset() {
    this.items = new Map();
    this.ranges = [];
  }

  snapshot(current, detail) {
    const revision = projectionRevision(detail?.eventRevision);
    if (revision === null) return null;
    const range = detail.eventsRange ?? null;
    const existing = new Map(current.map((event) => [eventIdentityKey(event), event]));
    const accepted = (detail.events ?? []).filter((event) => {
      const previous = existing.get(eventIdentityKey(event));
      // Repeated prompt/start boundaries outside an extent cannot replace a
      // retained item outside that extent (including its stable position).
      if (previous && range && !within(previous, range)) return false;
      return revision >= Math.max(this.revision(event), this.revision(previous));
    });
    const retained = current.filter((event) =>
      event.payload?.optimistic || !range || !within(event, range) ||
      revision < this.revision(event)
    );
    for (const event of accepted) this.items.set(eventIdentityKey(event), revision);
    if (range) {
      this.ranges = this.ranges.filter((previous) =>
        previous.revision > revision || !containsRange(range, previous)
      );
      this.ranges.push({ ...range, revision });
    }
    return applyDetailRange(retained, accepted, null);
  }

  delta(current, event, value) {
    const revision = projectionRevision(value);
    if (revision === null || !eventIdentityKey(event)) return null;
    const previous = current.find((candidate) => eventIdentityKey(candidate) === eventIdentityKey(event));
    if (revision <= Math.max(this.revision(event), this.revision(previous))) return null;
    this.items.set(eventIdentityKey(event), revision);
    return applyProjectionDelta(current, event);
  }

  revision(event) {
    if (!event) return -1;
    return this.ranges.reduce((revision, range) =>
      within(event, range) ? Math.max(revision, range.revision) : revision,
    this.items.get(eventIdentityKey(event)) ?? -1);
  }
}

export function projectionRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function comparePositions(left, right) {
  return left.anchorMs - right.anchorMs || left.index - right.index;
}

function within(event, range) {
  const position = taskEventPosition(event);
  return position && (!range.from || comparePositions(position, range.from) >= 0) &&
    (!range.to || comparePositions(position, range.to) <= 0);
}

function containsRange(outer, inner) {
  return (!outer.from || (inner.from && comparePositions(outer.from, inner.from) <= 0)) &&
    (!outer.to || (inner.to && comparePositions(outer.to, inner.to) >= 0));
}
