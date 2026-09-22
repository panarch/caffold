import {
  ACTION_HINT_ACTION,
  hasActionHintLayoutBox,
  linkActionHintLabel,
  linkActionHintTarget,
} from "../../../action-hints.js";

const SERVICE_STATUS_SELECTOR = "a.settings-service-status";

export function serviceStatusTargets(owner, {
  scopeId,
  clipRoots,
  isCurrent,
}) {
  const control = owner.querySelector(SERVICE_STATUS_SELECTOR);
  if (!control || control.hidden || !hasActionHintLayoutBox(control)) {
    return [];
  }
  return [linkActionHintTarget({
    invalidationOwner: owner,
    id: `${scopeId}:service-status`,
    actionId: ACTION_HINT_ACTION.LINK_OPEN,
    label: linkActionHintLabel(control),
    control,
    clipRoots,
    isActionable: () =>
      owner.isConnected &&
      !owner.hidden &&
      isCurrent() &&
      owner.querySelector(SERVICE_STATUS_SELECTOR) === control &&
      !control.hidden &&
      hasActionHintLayoutBox(control),
  })];
}
