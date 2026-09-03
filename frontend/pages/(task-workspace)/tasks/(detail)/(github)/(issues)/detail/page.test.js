import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-issue-detail-page").prototype;
after(() => registry.restore());

test("provides Start Task and the GitHub link through current Issue controls", () => {
  const focusOptions = [];
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute: (name) =>
      name === "aria-label" ? "Start Task for issue #42" : null,
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
    getClientRects: () => [{}],
  };
  const link = {
    getAttribute: (name) => ({
      href: "https://github.com/example/repo/issues/42",
      target: "_blank",
      rel: "noreferrer",
    })[name] ?? null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: {
      status: "ready",
      payload: {
        issue: {
          number: 42,
          url: "https://github.com/example/repo/issues/42",
        },
      },
    },
    querySelector: (selector) =>
      selector.includes("github-issue-start-button") ? control : link,
  };
  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:issue:detail",
    clipRoots: [{}],
  });
  const target = scope.targets[0];
  const github = scope.targets[1];

  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "github:issue:detail:42:start-task",
      actionId: "task.github.start",
      label: "Start Task for issue #42",
      controlKind: "button",
    },
  );
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);
  assert.deepEqual(
    {
      id: github.id,
      actionId: github.actionId,
      label: github.label,
      controlKind: github.controlKind,
    },
    {
      id: "github:issue:detail:42:github",
      actionId: "link.open",
      label: "Open issue #42 on GitHub in a new tab",
      controlKind: "link",
    },
  );
  assert.equal(github.isActionable(), true);

  control = null;
  assert.equal(target.isActionable(), false);
  control = {
    disabled: false,
    getAttribute() {},
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  owner.state = {
    status: "ready",
    payload: {
      issue: {
        number: 43,
        url: "https://github.com/example/repo/issues/43",
      },
    },
  };
  assert.equal(target.isActionable(), false);
  assert.equal(github.isActionable(), false);
});

test("delegates Markdown body scrolling and owns the raw fallback", () => {
  const delegatedSurface = { id: "markdown" };
  const markdownBody = {
    scrollSurfaceScope(options) {
      assert.equal(options.scopeId, "github:issue:42:body");
      return { surfaces: [delegatedSurface] };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready", payload: { issue: { number: 42 } } },
    getClientRects: () => [{}],
    querySelector: () => markdownBody,
  };
  assert.deepEqual(
    page.scrollSurfaceScope.call(owner, { scopeId: "github:issue:42" }).surfaces,
    [delegatedSurface],
  );

  const rawBody = {
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  owner.querySelector = () => rawBody;
  const scope = page.scrollSurfaceScope.call(owner, { scopeId: "github:issue:42" });
  assert.equal(scope.surfaces[0].scrollport, rawBody);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.state = { status: "ready", payload: { issue: { number: 43 } } };
  assert.equal(scope.surfaces[0].isEligible(), false);
});

test("merges only the current Issue Markdown Action Hint scope", () => {
  const start = {
    disabled: false,
    getAttribute: () => "Start Task for issue #42",
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const github = {
    getAttribute: (name) => ({
      href: "https://github.com/example/repo/issues/42",
      target: "_blank",
      rel: "noreferrer",
    })[name] ?? null,
    getClientRects: () => [{}],
    focus() {},
    click() {},
  };
  const generated = { id: "generated-link" };
  let received;
  const body = {
    actionHintScope(options) {
      received = options;
      return {
        blocked: false,
        targets: [generated],
        mutationRoots: [this],
        scrollRoots: [this],
      };
    },
  };
  const state = {
    status: "ready",
    payload: {
      issue: {
        number: 42,
        url: "https://github.com/example/repo/issues/42",
      },
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state,
    querySelector(selector) {
      if (selector.includes("github-issue-start-button")) return start;
      if (selector.includes("a.github-issue-link")) return github;
      return body;
    },
  };
  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:issue:detail",
  });

  assert.equal(scope.targets.at(-1), generated);
  assert.equal(received.scopeId, "github:issue:detail:42:body");
  assert.equal(received.isCurrent(), true);
  owner.state = { ...state };
  assert.equal(received.isCurrent(), false);
});
