export function collectComposerActionHintTargets({
  mode,
  scopeId,
  modelTarget,
  promptTarget,
}) {
  if (!COMPOSER_ACTION_HINT_MODES.has(mode) || !scopeId) {
    return [];
  }
  return [modelTarget(), promptTarget()].filter(Boolean);
}

const COMPOSER_ACTION_HINT_MODES = new Set(["create", "follow-up"]);
