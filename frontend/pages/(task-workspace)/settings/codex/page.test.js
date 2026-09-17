import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const codex = registry.element("caffold-settings-codex-page").prototype;
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

function link(label) {
  const attributes = new Map([
    ["href", "https://learn.chatgpt.com/docs/codex/cli"],
    ["target", "_blank"],
    ["rel", "noreferrer"],
  ]);
  return {
    hidden: false,
    textContent: label,
    getAttribute: (name) => attributes.get(name) ?? null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
}

test("provides current Codex actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refreshRequests = [];
  const copy = button("Copy command");
  const restart = button("Restart runtime");
  const guide = link("Official Codex CLI guide");
  const controls = new Map([
    ['button[data-action="copy-codex-install"]', copy],
    ['button[data-action="open-codex-restart"]', restart],
    ['.settings-codex-repair a[href]', guide],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    refreshButton: {
      actionHintScope(request) {
        refreshRequests.push(request);
        return { targets: [{ id: `${request.scopeId}:refresh` }] };
      },
    },
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = codex.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:codex:refresh",
    "settings:codex:copy-install-command",
    "settings:codex:restart-runtime",
    "settings:codex:official-guide",
  ]);
  assert.deepEqual(refreshRequests[0].clipRoots, [owner, scrollport]);
  assert.equal(refreshRequests[0].isCurrent(), true);
  assert.equal(codex.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  copy.disabled = true;
  assert.equal(scope.targets[1].isActionable(), false);
  guide.hidden = true;
  assert.equal(scope.targets.at(-1).isActionable(), false);
  owner.hidden = true;
  assert.equal(refreshRequests[0].isCurrent(), false);
});
