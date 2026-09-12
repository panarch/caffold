import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const appearance = registry.element("caffold-settings-appearance-page").prototype;
after(() => registry.restore());

function button(label) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    title: "",
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

function nativeControl({ checked = false, value = "" } = {}) {
  return {
    checked,
    disabled: false,
    hidden: false,
    value,
    focused: 0,
    clicks: 0,
    pickerCalls: 0,
    closest: () => null,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {
      this.focused += 1;
    },
    click() {
      this.clicks += 1;
    },
    showPicker() {
      this.pickerCalls += 1;
    },
  };
}

test("provides visible reset buttons and the exact settings scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const resetAll = button("Reset all");
  const resetTheme = button("Reset theme");
  const resetUiTypeface = button("Reset interface font");
  resetUiTypeface.hidden = true;
  const resetCodeTypeface = button("Reset code font");
  resetCodeTypeface.hidden = true;
  const controls = new Map([
    ['button[data-action="reset-appearance"]', resetAll],
    ['button[data-action="reset-theme"]', resetTheme],
    [
      'button[data-action="reset-typeface"][data-typeface-setting="uiTypefacePreset"]',
      resetUiTypeface,
    ],
    [
      'button[data-action="reset-typeface"][data-typeface-setting="codeTypefacePreset"]',
      resetCodeTypeface,
    ],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = appearance.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:appearance:reset-all",
    "settings:appearance:reset-theme",
  ]);
  assert.ok(scope.targets.every(({ actionId }) =>
    actionId === "button.activate"
  ));
  scope.targets[0].activate();
  assert.equal(resetAll.clicks, 1);

  controls.set('button[data-action="reset-appearance"]', button("New"));
  assert.equal(scope.targets[0].isActionable(), false);

  const scrollScope = appearance.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 100;
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
});

test("provides alternate themes, typeface, and retained range controls", () => {
  const scrollport = { getClientRects: () => [{}] };
  const system = nativeControl({ checked: true, value: "system" });
  const light = nativeControl({ value: "light" });
  const dark = nativeControl({ value: "dark" });
  const uiTypeface = nativeControl({ value: "geist-sans" });
  uiTypeface.selectedOptions = [{ textContent: "Geist Sans" }];
  const codeTypeface = nativeControl({ value: "d2-coding" });
  codeTypeface.selectedOptions = [{ textContent: "D2 Coding" }];
  const interfaceScale = nativeControl({ value: "100" });
  interfaceScale.getAttribute = (name) => name === "aria-valuetext" ? "100%" : null;
  const conversationText = nativeControl({ value: "14" });
  conversationText.getAttribute = (name) => name === "aria-valuetext" ? "14px" : null;
  const codeText = nativeControl({ value: "13" });
  codeText.getAttribute = (name) => name === "aria-valuetext" ? "13px" : null;
  const controls = new Map([
    [':scope > .settings-scroll', scrollport],
    ['input[type="radio"][data-theme-setting][value="system"]', system],
    ['input[type="radio"][data-theme-setting][value="light"]', light],
    ['input[type="radio"][data-theme-setting][value="dark"]', dark],
    ['select[data-typeface-setting="uiTypefacePreset"]', uiTypeface],
    ['select[data-typeface-setting="codeTypefacePreset"]', codeTypeface],
    ['input[type="range"][data-setting="interfaceScalePercent"]', interfaceScale],
    ['input[type="range"][data-setting="conversationTextPx"]', conversationText],
    ['input[type="range"][data-setting="codeTextPx"]', codeText],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector: (selector) => controls.get(selector) ?? null,
  };

  const scope = appearance.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:appearance:theme:light",
    "settings:appearance:theme:dark",
    "settings:appearance:typeface:uiTypefacePreset",
    "settings:appearance:typeface:codeTypefacePreset",
    "settings:appearance:range:interfaceScalePercent",
    "settings:appearance:range:conversationTextPx",
    "settings:appearance:range:codeTextPx",
  ]);
  assert.deepEqual(scope.targets.map(({ controlKind }) => controlKind), [
    "radio",
    "radio",
    "select",
    "select",
    "range",
    "range",
    "range",
  ]);
  assert.equal(scope.targets[0].label, "Use Light theme");
  assert.equal(
    scope.targets[2].label,
    "Choose interface font (current Geist Sans)",
  );
  assert.equal(scope.targets[3].label, "Choose code font (current D2 Coding)");
  assert.equal(scope.targets[4].label, "Adjust Interface size (100%)");

  scope.targets[0].activate();
  scope.targets[2].activate();
  scope.targets[3].activate();
  scope.targets[4].activate();
  assert.equal(light.focused, 1);
  assert.equal(light.clicks, 1);
  assert.equal(uiTypeface.focused, 1);
  assert.equal(uiTypeface.pickerCalls, 1);
  assert.equal(codeTypeface.focused, 1);
  assert.equal(codeTypeface.pickerCalls, 1);
  assert.equal(interfaceScale.focused, 1);
  assert.equal(interfaceScale.clicks, 0);

  light.checked = true;
  assert.equal(scope.targets[0].isActionable(), false);
  controls.set(
    'input[type="range"][data-setting="interfaceScalePercent"]',
    nativeControl({ value: "105" }),
  );
  assert.equal(scope.targets[4].isActionable(), false);
});
