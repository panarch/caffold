import type { ActionHintTarget } from "#app/action-hint-scope.js";

export function collectComposerActionHintTargets({
  mode,
  scopeId,
  modelTarget,
  permissionTarget,
  promptTarget,
}: {
  mode: string;
  scopeId: string;
  modelTarget: () => ActionHintTarget | null;
  permissionTarget: () => ActionHintTarget | null;
  promptTarget: () => ActionHintTarget | null;
}) {
  if (!COMPOSER_ACTION_HINT_MODES.has(mode) || !scopeId) {
    return [];
  }
  return [modelTarget(), permissionTarget(), promptTarget()].filter(
    (target): target is ActionHintTarget => Boolean(target),
  );
}

const COMPOSER_ACTION_HINT_MODES = new Set(["create", "follow-up"]);
