import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./item.js");
const item = registry.element("caffold-settings-navigator-item").prototype;
after(() => registry.restore());

const KEYBOARD = { section: "keyboard", label: "Keyboard", icon: "Keyboard" };

function control(ariaLabel = null) {
  return {
    disabled: false,
    getAttribute: (name) => name === "aria-label" ? ariaLabel : null,
    toggleAttribute() {},
    focus() {},
    click() {},
  };
}

function itemHost(entry, button = control()) {
  return Object.assign(Object.create(item), {
    entry,
    selected: false,
    isConnected: true,
    button: () => button,
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
  host.setSelected(true);
  assert.equal(target.isActionable(), false);
  assert.deepEqual(host.actionHintScope().targets, []);
});

test("names its Action Hint by the button's readiness label when it has one", () => {
  const host = itemHost(
    { section: "codex", label: "Codex", brand: "codex-template@2x.png" },
    control("Codex — ready"),
  );

  assert.equal(host.actionHintScope().targets[0].label, "Codex — ready");
});

test("asks to open its section when its own button is clicked", () => {
  const host = itemHost(KEYBOARD);
  const events = [];
  host.dispatchEvent = (event) => events.push(event);

  host.handleClick({ target: { closest: () => host.button() } });
  host.handleClick({ target: { closest: () => null } });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:settings-navigator-intent");
  assert.equal(events[0].bubbles, true);
  assert.deepEqual(events[0].detail, { section: "keyboard" });
});

test("marks the About entry and its name while a newer Caffold exists", () => {
  const attributes = new Map();
  const button = {
    ...control(),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    toggleAttribute: (name, force) =>
      force ? attributes.set(name, "") : attributes.delete(name),
  };
  const host = itemHost(
    { section: "about", label: "About Caffold", icon: "Info" },
    button,
  );

  host.setUpdateAvailable(true);
  assert.equal(attributes.has("data-update-available"), true);
  assert.equal(attributes.get("aria-label"), "About Caffold — update available");
  assert.equal(
    host.actionHintScope().targets[0].label,
    "About Caffold — update available",
  );

  host.setUpdateAvailable(false);
  assert.equal(attributes.has("data-update-available"), false);
  assert.equal(attributes.has("aria-label"), false);
});
