import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigation.js");
const navigation = registry.element("caffold-task-workspace-navigation").prototype;
after(() => registry.restore());

test("provides only the non-current workspace routes through their owned buttons", () => {
  let clicks = 0;
  const controls = {
    tasks: { disabled: false, getAttribute: () => null },
    notes: { disabled: false, getAttribute: () => null, focus() {}, click() {} },
    settings: {
      disabled: false,
      getAttribute: () => "Settings — Codex ready",
      focus() {},
      click() {
        clicks += 1;
      },
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    mode: "tasks",
    ensureRendered() {},
    querySelector(selector) {
      const mode = selector.match(/data-workspace-mode="([^"]+)"/)?.[1];
      return controls[mode] ?? null;
    },
  };

  const scope = navigation.actionHintScope.call(owner, {
    clipRoots: [owner],
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label }) => ({ id, actionId, label })),
    [
      {
        id: "workspace:mode:notes",
        actionId: "navigation.workspace.select",
        label: "Open Notes",
      },
      {
        id: "workspace:mode:settings",
        actionId: "navigation.workspace.select",
        label: "Settings — Codex ready",
      },
    ],
  );
  const settings = scope.targets[1];
  assert.equal(settings.isActionable(), true);
  settings.activate();
  assert.equal(clicks, 1);

  owner.mode = "settings";
  assert.equal(settings.isActionable(), false);
  assert.deepEqual(
    navigation.actionHintScope.call(owner, { clipRoots: [owner] }).targets.map(({ id }) => id),
    ["workspace:mode:tasks", "workspace:mode:notes"],
  );
});

test("marks exactly the chosen workspace mode as current", () => {
  const buttons = ["tasks", "notes", "settings"].map((mode) => ({
    dataset: { workspaceMode: mode },
    current: false,
    toggleAttribute(name, force) {
      assert.equal(name, "aria-current");
      this.current = force;
    },
  }));
  const owner = {
    ensureRendered() {},
    querySelectorAll: () => buttons,
  };

  for (const mode of ["notes", "settings", "tasks"]) {
    navigation.setMode.call(owner, mode);
    assert.equal(owner.mode, mode);
    assert.deepEqual(
      buttons.filter((button) => button.current).map((button) => button.dataset.workspaceMode),
      [mode],
    );
  }
  navigation.setMode.call(owner, "unknown");
  assert.equal(owner.mode, "tasks");
});

test("marks the Settings button and its name while a newer Caffold exists", () => {
  const button = {
    dataset: {},
    attributes: new Map(),
    title: "",
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    toggleAttribute(name, force) {
      if (force) {
        this.attributes.set(name, "");
      } else {
        this.attributes.delete(name);
      }
    },
  };
  const owner = {
    codexStatusSnapshotValue: { status: { readiness: { state: "ready" } } },
    updateAvailable: false,
    reloadReady: false,
    ensureRendered() {},
    querySelector: () => button,
  };
  owner.syncSettingsStatus = () => navigation.syncSettingsStatus.call(owner);

  navigation.setCaffoldUpdate.call(owner, {
    checking: false,
    status: { updateAvailable: true },
  });

  assert.equal(button.attributes.has("data-update-available"), true);
  assert.equal(
    button.attributes.get("aria-label"),
    "Settings — Codex ready, Caffold update available",
  );
  assert.equal(button.title, "Settings — Codex ready, Caffold update available");
  assert.equal(button.dataset.codexState, "available");

  navigation.setCaffoldUpdate.call(owner, {
    checking: false,
    status: { updateAvailable: false },
  });
  assert.equal(button.attributes.has("data-update-available"), false);
  assert.equal(button.attributes.get("aria-label"), "Settings — Codex ready");

  navigation.setCaffoldUpdate.call(owner, null);
  assert.equal(button.attributes.has("data-update-available"), false);

  // A new build this window can load marks the same button.
  navigation.setUpdateStatus.call(owner, { state: "ready", preparedUpdate: { ready: true } });
  assert.equal(button.attributes.has("data-update-available"), true);
  assert.equal(
    button.attributes.get("aria-label"),
    "Settings — Codex ready, reload to update",
  );
  navigation.setCaffoldUpdate.call(owner, {
    checking: false,
    status: { updateAvailable: true },
  });
  assert.equal(
    button.attributes.get("aria-label"),
    "Settings — Codex ready, Caffold update available, reload to update",
  );
  navigation.setCaffoldUpdate.call(owner, null);
  navigation.setUpdateStatus.call(owner, { state: "settled", preparedUpdate: { ready: false } });
  assert.equal(button.attributes.has("data-update-available"), false);
  assert.equal(button.attributes.get("aria-label"), "Settings — Codex ready");
});
