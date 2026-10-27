export const CAFFOLD_ORIGIN_REACHABLE_EVENT = "caffold:origin-reachable";

export function reportOriginReachable(
  target: EventTarget | undefined = globalThis.window,
) {
  if (!target?.dispatchEvent) {
    return false;
  }
  target.dispatchEvent(new Event(CAFFOLD_ORIGIN_REACHABLE_EVENT));
  return true;
}
