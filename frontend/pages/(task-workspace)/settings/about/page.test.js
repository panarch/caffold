import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

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
await import("./page.js");
const about = registry.element("caffold-settings-about-page").prototype;
after(() => {
  registry.restore();
  buildInfoHook.deregister();
});

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

test("provides current About actions and its exact scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 240,
    getClientRects: () => [{}],
  };
  const reload = button("Reload to update");
  const copy = button("Copy diagnostics");
  const controls = new Map([
    ['button[data-action="reload-update"]', reload],
    ['button[data-action="copy-diagnostics"]', copy],
  ]);
  const owner = {
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector === ":scope > .settings-content-scroll") return scrollport;
      return controls.get(selector) ?? null;
    },
  };

  const scope = about.actionHintScope.call(owner);
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "settings:about:reload-update",
    "settings:about:copy-diagnostics",
  ]);
  assert.equal(about.scrollSurfaceScope.call(owner).surfaces[0].scrollport, scrollport);
  reload.disabled = true;
  assert.equal(scope.targets[0].isActionable(), false);
});

const { caffoldUpdatesView, lastUpdateValue } = await import("./page.js");

function answered(status) {
  return { checking: false, status, error: null };
}

const NEWER = {
  version: "0.18.2",
  latestRelease: {
    version: "0.18.3",
    url: "https://github.com/panarch/caffold/releases/tag/v0.18.3",
  },
  updateAvailable: true,
  updateTask: { cwd: "data/caffold-updates", command: "caffold update" },
};

test("tells each update state in one sentence", () => {
  const view = (snapshot, health) => caffoldUpdatesView(snapshot, health);

  assert.deepEqual(
    view({ checking: true, status: null, error: null }, { version: "0.18.2" }),
    {
      summary: "Checking for updates…",
      checking: true,
      version: "0.18.2",
      latest: { text: "Checking…", url: null },
      lastUpdate: null,
      canUpdate: false,
    },
  );
  assert.equal(
    view({ checking: false, status: null, error: "Request timed out." }).summary,
    "Caffold could not check for updates.\nRequest timed out.",
  );
  assert.equal(
    view(answered({ version: "0.18.2", releaseError: "GitHub answered HTTP 403 Forbidden.", updateAvailable: false })).summary,
    "Caffold could not check for updates.\nGitHub answered HTTP 403 Forbidden.",
  );
  assert.equal(
    view(answered({ ...NEWER, latestRelease: { ...NEWER.latestRelease, version: "0.18.2" }, updateAvailable: false, updateTask: undefined })).summary,
    "Caffold is up to date.",
  );
  const available = view(answered(NEWER));
  assert.equal(
    available.summary,
    "Caffold 0.18.3 is available. The menu-bar app can also update it.",
  );
  assert.equal(available.canUpdate, true);
  assert.deepEqual(available.latest, {
    text: "0.18.3",
    url: "https://github.com/panarch/caffold/releases/tag/v0.18.3",
  });
  assert.equal(available.version, "0.18.2");

  const elsewhere = view(answered({ ...NEWER, updateTask: undefined }));
  assert.equal(
    elsewhere.summary,
    "Caffold 0.18.3 is available. Install it from the release page.",
  );
  assert.equal(elsewhere.canUpdate, false);

  const running = view(answered({
    ...NEWER,
    runningAttempt: { id: "a", fromVersion: "0.18.2", outcome: "running" },
  }));
  assert.equal(running.summary, "Updating to Caffold 0.18.3…");
  assert.equal(running.checking, true);
  assert.equal(running.canUpdate, false);
});

test("tells how the last update ended", () => {
  const attempt = (outcome, extra = {}) => ({
    id: "a",
    fromVersion: "0.18.2",
    toVersion: "0.18.3",
    outcome,
    ...extra,
  });

  assert.deepEqual(lastUpdateValue(attempt("succeeded")), {
    text: "Updated to 0.18.3",
    state: "positive",
  });
  assert.deepEqual(
    lastUpdateValue(attempt("rolledBack", { reason: "0.18.3 could not start" })),
    { text: "Rolled back to 0.18.2 — 0.18.3 could not start", state: "negative" },
  );
  assert.equal(
    lastUpdateValue(attempt("rolledBack", { reason: "Caffold did not quit" })).text,
    "Rolled back to 0.18.2 — Caffold did not quit",
  );
  assert.deepEqual(lastUpdateValue(attempt("homebrewFailed")), {
    text: "Homebrew could not update",
    state: "negative",
  });
  assert.deepEqual(lastUpdateValue(attempt("upToDate")), {
    text: "Already up to date",
    state: "",
  });
  assert.deepEqual(lastUpdateValue(attempt("restoreFailed")), {
    text: "Could not restore 0.18.2",
    state: "negative",
  });
  assert.deepEqual(lastUpdateValue(attempt("interrupted")), {
    text: "Interrupted",
    state: "negative",
  });
  assert.equal(lastUpdateValue(attempt("running")), null);
  assert.equal(lastUpdateValue(null), null);

  const timed = lastUpdateValue(
    attempt("succeeded", { finishedAt: "2026-10-04T12:10:00Z" }),
  );
  assert.match(timed.text, /^Updated to 0\.18\.3 · .+/);
});
