import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const voicePage = registry.element("caffold-settings-voice-page").prototype;
after(() => registry.restore());

function control({ checked = false, hidden = false, disabled = false } = {}) {
  return {
    checked,
    hidden,
    disabled,
    getAttribute: () => null,
    getClientRects: () => [{}],
    closest: () => null,
    focus() {},
    click() {},
  };
}

test("offers only available provider choices and actions with the exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const whisper = control({ checked: true });
  const openai = control();
  const gemini = control({ disabled: true });
  const grok = control();
  const removeModel = control();
  const download = control({ hidden: true });
  const saveOpenaiKey = control();
  const saveGrokKey = control();
  const controls = new Map([
    ['input[type="radio"][name="voice-provider"][value="whisper"]', whisper],
    ['input[type="radio"][name="voice-provider"][value="openai"]', openai],
    ['input[type="radio"][name="voice-provider"][value="gemini"]', gemini],
    ['input[type="radio"][name="voice-provider"][value="grok"]', grok],
    ['button[data-action="download-model"]', download],
    ['button[data-action="remove-model"]', removeModel],
    ['form[data-key-provider="openai"] button[type="submit"]', saveOpenaiKey],
    ['form[data-key-provider="grok"] button[type="submit"]', saveGrokKey],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = voicePage.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:voice:provider:openai",
    "settings:voice:provider:grok",
    "settings:voice:remove-model",
    "settings:voice:save-key:openai",
    "settings:voice:save-key:grok",
  ]);
  assert.equal(scope.targets[0].label, "Use OpenAI for voice input");
  assert.equal(scope.targets[1].label, "Use Grok for voice input");
  assert.equal(scope.targets[4].label, "Save the Grok API key");
  openai.checked = true;
  assert.equal(scope.targets[0].isActionable(), false);
  removeModel.hidden = true;
  assert.equal(scope.targets[2].isActionable(), false);
  assert.equal(
    voicePage.scrollSurfaceScope.call(owner).surfaces[0].scrollport,
    scrollport,
  );
});
