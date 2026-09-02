import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const remoteAccess = registry.element(
  "caffold-settings-remote-access-page",
).prototype;
after(() => registry.restore());

function button(label) {
  return {
    disabled: false,
    hidden: false,
    textContent: label,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}

function link(label, attributes) {
  return {
    textContent: label,
    getAttribute: (name) => attributes.get(name) ?? null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}

test("provides only current retained actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refresh = button("Refresh");
  const retry = button("Retry");
  const copy = button("Copy link");
  copy.getClientRects = () => [];
  const linkAttributes = new Map([
    ["href", "https://caffold.example.ts.net/"],
    ["target", "_blank"],
    ["rel", "noopener noreferrer"],
  ]);
  const open = link("Open link", linkAttributes);
  const controls = new Map([
    ['button[data-action="refresh"]', refresh],
    ['button[data-action="retry"]', retry],
    ['button[data-action="copy"]', copy],
    ['a[data-action="open"]', open],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    snapshot: {
      status: {
        state: "ready",
        tailnetUrl: "https://caffold.example.ts.net/",
      },
    },
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = remoteAccess.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:remote-access:refresh",
    "settings:remote-access:retry",
    "settings:remote-access:open-link",
  ]);
  retry.hidden = true;
  assert.equal(scope.targets[1].isActionable(), false);
  assert.equal(
    scope.targets[2].label,
    "Open private access address in a new tab",
  );
  linkAttributes.set("href", "https://changed.example.ts.net/");
  assert.equal(scope.targets[2].isActionable(), false);
  assert.equal(
    remoteAccess.scrollSurfaceScope.call(owner).surfaces[0].scrollport,
    scrollport,
  );
});
