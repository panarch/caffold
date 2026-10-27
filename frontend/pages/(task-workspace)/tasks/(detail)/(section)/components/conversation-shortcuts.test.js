import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";
import {
  createCodexStatusSnapshot,
} from "#app/pages/(task-workspace)/codex-status.js";

const registry = installCustomElementUnitRegistry();
await import("./conversation-shortcuts.js");
const { ActionHints } = await import("#app/action-hints.js");
const shortcuts = registry.element("caffold-section-conversation-shortcuts").prototype;
after(() => registry.restore());

test("shows the Fork opener only once Codex is known to be installed", () => {
  const owner = elementStandIn(shortcuts, {
    active: true,
    hidden: false,
    context: { sectionId: "section-a" },
    transportAvailable: true,
    taskStoreStatusSnapshot: null,
    codexReadiness: createCodexStatusSnapshot(),
  });
  owner.hints = new ActionHints(owner);
  const drawn = () => {
    shortcuts.updated.call(owner);
    const markup = templateHtml(owner.render()).replace(/\s+/g, " ");
    return {
      disabled: markup.includes('?disabled="true"'),
      reason: markup.match(/section-conversations-action-reason" \?hidden="\w+" >([^<]*)</)?.[1] ?? "",
    };
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

  drawn();
  assert.equal(owner.hidden, true, "nothing is shown before the server answers");

  owner.codexReadiness = createCodexStatusSnapshot({ phase: "loaded", status: null });
  drawn();
  assert.equal(owner.hidden, true, "a server that has not checked yet shows nothing");

  owner.codexReadiness = answered("missing", "Install Codex.");
  drawn();
  assert.equal(owner.hidden, true);

  owner.codexReadiness = answered("signInRequired", "Sign in to Codex.");
  assert.deepEqual(drawn(), { disabled: true, reason: "Sign in to Codex." });
  assert.equal(owner.hidden, false);

  owner.codexReadiness = answered("ready");
  assert.deepEqual(drawn(), { disabled: false, reason: "" });
  assert.equal(owner.hidden, false);

  owner.codexReadiness = createCodexStatusSnapshot({
    phase: "failed",
    error: "Load failed",
  });
  assert.deepEqual(drawn(), { disabled: true, reason: "Load failed" });
  assert.equal(owner.hidden, false);
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
  return elementStandIn(shortcuts, {
    active: false,
    context: { key: "section-a\0/repo", sectionId: "section-a", path: "/repo" },
    transportAvailable: true,
    taskStoreStatusSnapshot: null,
    codexReadiness: createCodexStatusSnapshot(),
    codexReadinessRequest: 0,
    forkDialog: () => null,
    draw() {},
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
