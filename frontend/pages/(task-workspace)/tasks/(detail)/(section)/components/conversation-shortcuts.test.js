import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import {
  createCodexStatusSnapshot,
} from "#app/pages/(task-workspace)/codex-status.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation-shortcuts.js");
const shortcuts = registry.element("caffold-section-conversation-shortcuts").prototype;
after(() => registry.restore());

test("provides the retained Fork opener only for the active Section context", () => {
  let control = {
    disabled: false,
    textContent: "Fork from Codex thread ID",
    getAttribute: () => null,
    focus() {},
    click() {},
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    context: { key: "section-a\0/repo" },
    ensureRendered() {},
    querySelector: () => control,
  };

  const target = shortcuts.actionHintScope.call(owner, {
    scopeId: "section:section-a",
  }).targets[0];
  assert.equal(target.id, "section:section-a:fork-conversation");
  assert.equal(target.actionId, "button.activate");
  assert.equal(target.isActionable(), true);
  owner.context = { key: "section-b\0/repo" };
  assert.equal(target.isActionable(), false);
  control = null;
});

test("shows the Fork opener only once Codex is known to be installed", () => {
  const button = { disabled: false, title: "" };
  const reason = { textContent: "", hidden: true };
  const owner = {
    active: true,
    hidden: false,
    context: { sectionId: "section-a" },
    transportAvailable: true,
    taskStoreStatusSnapshot: null,
    codexReadiness: createCodexStatusSnapshot(),
    toggleAttribute(name, force) {
      assert.equal(name, "hidden");
      this.hidden = force;
    },
    disabledReason: shortcuts.disabledReason,
    querySelector: (selector) =>
      selector.includes("fork-codex") ? button : reason,
  };
  const answered = (state, diagnosticMessage = "") => createCodexStatusSnapshot({
    phase: "loaded",
    status: {
      readiness: {
        state,
        blocksTaskOperations: state !== "ready",
        diagnosticMessage,
      },
    },
  });

  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, true, "nothing is shown before the server answers");

  owner.codexReadiness = createCodexStatusSnapshot({ phase: "loaded", status: null });
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, true, "a server that has not checked yet shows nothing");

  owner.codexReadiness = answered("missing", "Install Codex.");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, true);

  owner.codexReadiness = answered("signInRequired", "Sign in to Codex.");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(reason.textContent, "Sign in to Codex.");

  owner.codexReadiness = answered("ready");
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, false);
  assert.equal(button.disabled, false);

  owner.codexReadiness = createCodexStatusSnapshot({
    phase: "failed",
    error: "Load failed",
  });
  shortcuts.patch.call(owner);
  assert.equal(owner.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(reason.textContent, "Load failed");
});

test("asks what the server knows about Codex when shown and drops an answer that comes after hiding", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = shortcutsOwner();

    owner.activate();
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/api/codex/readiness");
    requests[0].answer({
      readiness: {
        state: "signInRequired",
        blocksTaskOperations: true,
        diagnosticMessage: "Sign in to Codex.",
      },
    });
    await settled();
    assert.equal(owner.codexReadiness.status.readiness.state, "signInRequired");

    owner.activate();
    assert.equal(requests.length, 1, "a row already shown does not ask again");

    owner.deactivate();
    owner.activate();
    assert.equal(requests.length, 2, "showing the row again asks again");
    owner.deactivate();
    requests[1].answer({
      readiness: { state: "ready", blocksTaskOperations: false, diagnosticMessage: "" },
    });
    await settled();
    assert.equal(
      owner.codexReadiness.status.readiness.state,
      "signInRequired",
      "an answer for a row no longer shown changes nothing",
    );
  } finally {
    restore();
  }
});

test("a failed question is shown as the reason the Fork opener is unavailable", async () => {
  const requests = [];
  const restore = answerRequests(requests);
  try {
    const owner = shortcutsOwner();

    owner.activate();
    requests[0].fail(new TypeError("Load failed"));
    await settled();

    assert.equal(owner.codexReadiness.phase, "failed");
    assert.equal(owner.codexReadiness.error, "Load failed");

    owner.setTransportAvailable(false);
    owner.setTransportAvailable(true);
    assert.equal(requests.length, 2, "a failed question is asked again once Caffold is back");
    requests[1].answer({ readiness: null });
    await settled();
    owner.setTransportAvailable(false);
    owner.setTransportAvailable(true);
    assert.equal(requests.length, 2, "an answer in hand is not asked for again");
  } finally {
    restore();
  }
});

function shortcutsOwner() {
  return Object.assign(Object.create(shortcuts), {
    active: false,
    context: { key: "section-a\0/repo", sectionId: "section-a", path: "/repo" },
    transportAvailable: true,
    taskStoreStatusSnapshot: null,
    codexReadiness: createCodexStatusSnapshot(),
    codexReadinessRequest: 0,
    ensureRendered() {},
    forkDialog: () => null,
    patch() {},
  });
}

function answerRequests(requests) {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = {
    ...previousWindow,
    location: { origin: "https://caffold.test" },
  };
  globalThis.fetch = (url) => {
    const answer = Promise.withResolvers();
    requests.push({
      url: String(url),
      answer: (body) =>
        answer.resolve({ ok: true, status: 200, json: async () => body }),
      fail: (error) => answer.reject(error),
    });
    return answer.promise;
  };
  return () => {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  };
}

function settled() {
  return new Promise((resolve) => setImmediate(resolve));
}
