import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  elementStandIn,
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

test("merges its own Back with only the presented page, clipped by the detail pane", () => {
  const pulls = [];
  const page = {
    actionHintScope(pull) {
      pulls.push(["actions", pull]);
      return { targets: [{ id: "settings:appearance:reset-all" }] };
    },
    scrollSurfaceScope(pull) {
      pulls.push(["scroll", pull]);
      return { surfaces: [{ id: "settings:appearance:scroll" }] };
    },
  };
  const detailPane = {};
  const owner = elementStandIn(workspace, {
    section: "appearance",
    wide: true,
    hints: { scope: () => ({ targets: [{ id: "settings:parent:list" }] }) },
    surfaces: { scope: () => ({ surfaces: [] }) },
    detailPane: { value: detailPane },
    pages: { get: (section) => (section === "appearance" ? page : undefined) },
  });

  assert.deepEqual(
    owner.actionHintScope().targets.map(({ id }) => id),
    ["settings:parent:list", "settings:appearance:reset-all"],
  );
  assert.deepEqual(
    owner.scrollSurfaceScope().surfaces.map(({ id }) => id),
    ["settings:appearance:scroll"],
  );
  assert.deepEqual(pulls, [
    ["actions", { scopeId: "settings:appearance", clipRoots: [detailPane] }],
    ["scroll", { scopeId: "settings:appearance", label: "Appearance", clipRoots: [detailPane] }],
  ]);

  owner.section = "";
  owner.wide = false;
  assert.deepEqual(
    owner.actionHintScope().targets.map(({ id }) => id),
    ["settings:parent:list"],
  );
});

test("hands a navigator that connects later the update states it missed", () => {
  const owner = {
    section: "about",
    wide: false,
    caffoldUpdate: { checking: false, status: { updateAvailable: true } },
    updateStatus: null,
    connectedSettingsNavigator: null,
    navigatorIntent: () => {},
    performUpdate() {},
    presentedSection: workspace.presentedSection,
    updateAvailable: workspace.updateAvailable,
    reloadReady: workspace.reloadReady,
  };
  const status = { state: "ready", preparedUpdate: { ready: true, buildId: "next" } };

  workspace.setUpdateStatus.call(owner, status);
  assert.equal(owner.updateStatus, status, "About takes the status it is bound to");

  const navigator = { addEventListener() {}, removeEventListener() {} };
  workspace.connectSettingsNavigator.call(owner, navigator);
  assert.deepEqual(
    {
      selectedSection: navigator.selectedSection,
      updateAvailable: navigator.updateAvailable,
      reloadReady: navigator.reloadReady,
    },
    { selectedSection: "about", updateAvailable: true, reloadReady: true },
  );

  const settled = { state: "settled", preparedUpdate: { ready: false, buildId: null } };
  workspace.setUpdateStatus.call(owner, settled);
  assert.equal(navigator.reloadReady, false);
});
