export const CAFFOLD_ORIGIN_REACHABLE_EVENT = "caffold:origin-reachable";

export function reportOriginReachable(target = globalThis.window) {
  if (!target?.dispatchEvent) {
    return false;
  }
  target.dispatchEvent(new Event(CAFFOLD_ORIGIN_REACHABLE_EVENT));
  return true;
}
