import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.js");
const navigator = registry.element("caffold-settings-navigator").prototype;
after(() => registry.restore());

test("provides all non-current direct Settings sections", () => {
  const sections = [
    "appearance",
    "keyboard",
    "files",
    "notifications",
    "remote-access",
    "codex",
    "claude",
    "about",
  ];
  const controls = new Map(sections.map((section) => [section, {
    disabled: false,
    getAttribute: () => null,
    focus() {},
    click() {},
  }]));
  const scroller = {};
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    selectedSection: "appearance",
    querySelector(selector) {
      if (selector === ":scope > .settings-navigator-list") {
        return scroller;
      }
      const section = selector.match(/data-settings-section="([^"]+)"/)?.[1];
      return controls.get(section) ?? null;
    },
  };

  const scope = navigator.actionHintScope.call(owner, {
    clipRoots: [owner],
  });
  assert.equal(scope.targets.length, 7);
  assert.deepEqual(
    scope.targets.map(({ id }) => id),
    sections.slice(1).map((section) => `settings:section:${section}`),
  );
  assert.ok(scope.targets.every(
    ({ actionId, controlKind, clipRoots }) =>
      actionId === "navigation.settings.section" &&
      controlKind === "button" &&
      clipRoots[0] === owner &&
      clipRoots[1] === scroller,
  ));
  assert.deepEqual(scope.scrollRoots, [scroller]);

  owner.selectedSection = "keyboard";
  assert.equal(scope.targets[0].isActionable(), false);
});

test("provides only its exact retained section list as a Scroll surface", () => {
  const scroller = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const owner = {
    initialized: true,
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => scroller,
  };
  const scope = navigator.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scroller);
  assert.equal(scope.surfaces[0].isEligible(), true);
  scroller.scrollHeight = 100;
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.deepEqual(navigator.scrollSurfaceScope.call(owner).surfaces, []);
});
