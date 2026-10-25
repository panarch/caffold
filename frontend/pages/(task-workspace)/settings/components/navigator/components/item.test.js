import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./item.ts");
const item = registry.element("caffold-settings-navigator-item").prototype;
after(() => registry.restore());

const KEYBOARD = { section: "keyboard", label: "Keyboard", icon: "Keyboard" };

function control() {
  return {
    disabled: false,
    getAttribute: () => null,
    toggleAttribute() {},
    focus() {},
    click() {},
  };
}

function itemHost(entry, button = control()) {
  return Object.assign(Object.create(item, { button: { value: button } }), {
    entry,
    selected: false,
    updateAvailable: false,
    reloadReady: false,
    isConnected: true,
  });
}

test("offers its Settings section as an Action Hint while it is not the current one", () => {
  const scroller = {};
  const host = itemHost(KEYBOARD);
  let current = true;

  const scope = host.actionHintScope({
    clipRoots: [scroller],
    isCurrent: () => current,
  });
  assert.equal(scope.targets.length, 1);
  const [target] = scope.targets;
  assert.equal(target.id, "settings:section:keyboard");
  assert.equal(target.actionId, "navigation.settings.section");
  assert.equal(target.controlKind, "button");
  assert.equal(target.label, "Open Keyboard settings");
  assert.equal(target.invalidationOwner, host);
  assert.deepEqual(target.clipRoots, [scroller]);
  assert.deepEqual(scope.mutationRoots, [host]);
  assert.equal(target.isActionable(), true);

  current = false;
  assert.equal(target.isActionable(), false);
  current = true;
  host.selected = true;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(host.actionHintScope().targets, []);
});

test("names the Codex entry like any other agent's", () => {
  const host = itemHost({
    section: "codex",
    label: "Codex",
    brand: "codex-template@2x.png",
  });

  assert.equal(host.actionHintScope().targets[0].label, "Open Codex settings");
});

test("asks to open its section when its own button is clicked", () => {
  const host = itemHost(KEYBOARD);
  const events = [];
  host.dispatchEvent = (event) => events.push(event);

  host.open();

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:settings-navigator-intent");
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, { section: "keyboard" });
});

test("names the About entry with every update notice it shows", () => {
  const host = itemHost({ section: "about", label: "About Caffold", icon: "Info" });
  const label = (notices) => {
    Object.assign(host, { updateAvailable: false, reloadReady: false }, notices);
    return item.render
      .call(host)
      .values.find((value) => typeof value === "string" && value.includes(" — "));
  };

  assert.equal(label({ updateAvailable: true }), "About Caffold — update available");
  assert.equal(label({ reloadReady: true }), "About Caffold — reload to update");
  assert.equal(
    label({ updateAvailable: true, reloadReady: true }),
    "About Caffold — update available, reload to update",
  );
  assert.equal(label({}), undefined);
});
