import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const buildInfoHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("build-info.js")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const BUILD_INFO={id:'test',version:'test',number:0}",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const workspace = registry.element("caffold-settings-workspace").prototype;
after(() => {
  registry.restore();
  buildInfoHook.deregister();
});

test("merges responsive Back with only the presented direct page", () => {
  const childTarget = { id: "appearance-reset" };
  const childSurface = { id: "appearance-scroll" };
  const page = {
    hidden: false,
    getClientRects: () => [{}],
    actionHintScope: () => ({
      targets: [childTarget],
      mutationRoots: [page],
      scrollRoots: [],
    }),
    scrollSurfaceScope: () => ({
      surfaces: [childSurface],
      mutationRoots: [page],
      resizeElements: [page],
      scrollRoots: [],
    }),
  };
  const control = {
    disabled: false,
    getAttribute: () => "Back to settings",
    focus() {},
    click() {},
  };
  const header = { hidden: false };
  const detail = {};
  const owner = {
    hidden: false,
    isConnected: true,
    section: "appearance",
    masterDetailMedia: { matches: true },
    ensureRendered() {},
    presentedSection() {
      return workspace.presentedSection.call(this);
    },
    settingsPages: () => ({ appearance: page }),
    querySelector(selector) {
      if (selector.includes("button[data-action=")) return control;
      if (selector.endsWith(".settings-workspace-detail-header")) return header;
      if (selector.endsWith(".settings-workspace-detail-pane")) return detail;
      return null;
    },
  };

  assert.deepEqual(
    workspace.actionHintScope.call(owner).targets.map(({ id }) => id),
    ["settings:parent:list", "appearance-reset"],
  );
  assert.deepEqual(
    workspace.scrollSurfaceScope.call(owner).surfaces,
    [childSurface],
  );

  owner.section = "";
  assert.deepEqual(
    workspace.actionHintScope.call(owner).targets,
    [childTarget],
  );
  owner.masterDetailMedia.matches = false;
  assert.deepEqual(workspace.actionHintScope.call(owner).targets, []);
  assert.deepEqual(workspace.scrollSurfaceScope.call(owner).surfaces, []);
});
