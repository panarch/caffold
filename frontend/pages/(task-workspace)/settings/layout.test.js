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
await import("./layout.ts");
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
  const header = { hidden: false, querySelector: () => control };
  const detail = {
    querySelector: (selector) =>
      selector.endsWith(".settings-workspace-detail-header") ? header : null,
  };
  const owner = {
    hidden: false,
    isConnected: true,
    section: "appearance",
    wide: true,
    performUpdate() {},
    presentedSection: workspace.presentedSection,
    page: (section) => (section === "appearance" ? page : null),
    querySelector: (selector) =>
      selector.endsWith(".settings-workspace-detail-pane") ? detail : null,
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
  owner.wide = false;
  assert.deepEqual(workspace.actionHintScope.call(owner).targets, []);
  assert.deepEqual(workspace.scrollSurfaceScope.call(owner).surfaces, []);
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
