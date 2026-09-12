import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const grok = registry.element("caffold-settings-grok-page").prototype;
after(() => registry.restore());

test("provides the check-again action and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const refresh = {
    disabled: false,
    hidden: false,
    textContent: "Check again",
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      if (selector === 'button[data-action="refresh-grok-status"]') {
        return refresh;
      }
      return null;
    },
  };

  const scope = grok.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), ["settings:grok:refresh"]);
  assert.equal(scope.targets[0].label, "Check again");
  assert.equal(grok.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  refresh.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
  owner.hidden = true;
  assert.deepEqual(grok.actionHintScope.call(owner).targets, []);
  assert.deepEqual(grok.scrollSurfaceScope.call(owner).surfaces, []);
});

test("reads each block for itself, so one silent source costs one block", () => {
  const owner = {
    status: {
      executable: { path: "/Users/example/.local/bin/grok", version: "grok 1.0.30 (04b7ffed98c6) [stable]" },
      leader: { socketPath: "/Users/example/.grok/leader-caffold.sock", running: true, socketStale: false, pid: 36832, version: "1.0.29" },
      connection: { state: "ready", agentVersion: "1.0.30", authMethods: ["cached_token", "Grok"], defaultAuthMethod: "cached_token" },
      auth: { cachedSignIn: true },
      problems: { auth: "Grok did not answer within 30 seconds" },
    },
    statusState: "loaded",
  };
  const value = (rows, key) => rows.find((row) => row.key === key);

  assert.equal(value(grok.agentRows.call(owner), "version").value, "grok 1.0.30 (04b7ffed98c6) [stable]");
  assert.equal(value(grok.accountRows.call(owner), "account").value, "Unavailable — Grok did not answer within 30 seconds");
  assert.equal(value(grok.accountRows.call(owner), "method").value, "Unknown");
  assert.equal(value(grok.leaderRows.call(owner), "leader").value, "Running · pid 36832");
  assert.deepEqual(value(grok.leaderRows.call(owner), "leader-build"), {
    key: "leader-build",
    label: "Leader build",
    value: "1.0.29 — differs from the installed 1.0.30",
    state: "negative",
  });
  assert.equal(value(grok.connectionRows.call(owner), "connection").value, "Connected · agent 1.0.30");
  assert.equal(value(grok.connectionRows.call(owner), "auth-methods").value, "cached_token · Grok");

  owner.status = {
    leader: { socketPath: "/Users/example/.grok/leader-caffold.sock", running: false, socketStale: false },
    connection: { state: "down", authMethods: [] },
    auth: { cachedSignIn: false },
    problems: { executable: "grok was not found on PATH, in ~/.grok/bin or in ~/.local/bin. Install the Grok CLI to use Grok." },
  };
  assert.equal(value(grok.agentRows.call(owner), "version").state, "negative");
  assert.equal(value(grok.agentRows.call(owner), "path").value, "Unknown");
  assert.equal(value(grok.accountRows.call(owner), "account").value, "Signed out — no cached sign-in");
  assert.equal(value(grok.leaderRows.call(owner), "leader").value, "Not running — starts with the first Grok Task");
  assert.equal(value(grok.leaderRows.call(owner), "leader-build").value, "—");
  assert.equal(
    value(grok.connectionRows.call(owner), "connection").value,
    "Not connected — connects with the first Grok Task",
  );

  owner.statusState = "unavailable";
  assert.equal(grok.unansweredRows.call(owner)[0].value, "Unavailable — The server did not answer.");
});
