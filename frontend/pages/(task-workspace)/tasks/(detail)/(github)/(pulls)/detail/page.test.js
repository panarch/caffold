import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const page = registry.element("caffold-github-pull-detail-page").prototype;
after(() => registry.restore());

test("provides current Pull actions and direct links through their native controls", () => {
  const clipRoot = {};
  const focusOptions = [];
  const clicks = [];
  const start = {
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Start Task for pull request #7" : null;
    },
    focus(options) {
      focusOptions.push(["start", options]);
    },
    click() {
      clicks.push("start");
    },
    getClientRects: () => [{}],
  };
  let files = {
    dataset: { pullNumber: "7" },
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Open files for PR #7" : null;
    },
    focus(options) {
      focusOptions.push(["files", options]);
    },
    click() {
      clicks.push("files");
    },
    getClientRects: () => [{}],
  };
  const link = (href) => ({
    getAttribute: (name) => ({
      href,
      target: "_blank",
      rel: "noreferrer",
    })[name] ?? null,
    focus() {},
    click() {},
    getClientRects: () => [{}],
  });
  const github = link("https://github.com/example/repo/pull/7");
  const comment = {
    url: "https://github.com/example/repo/pull/7#issuecomment-1",
  };
  const commentLink = link(comment.url);
  const commit = {
    sha: "abcdef1234567890",
    shortSha: "abcdef1",
    url: "https://github.com/example/repo/commit/abcdef1234567890",
  };
  const commitLink = link(commit.url);
  const scrollport = { getClientRects: () => [{}] };
  const owner = {
    hidden: false,
    isConnected: true,
    state: {
      status: "ready",
      payload: {
        pull: {
          number: 7,
          url: "https://github.com/example/repo/pull/7",
          conversationComments: [comment],
          commitSummaries: [commit],
        },
      },
    },
    querySelector(selector) {
      if (selector.includes("github-pull-start-button")) return start;
      if (selector.includes("github-pull-files-button")) return files;
      if (selector.includes("a.github-pull-link")) return github;
      if (selector.includes("data-github-pull-comment-index")) {
        return commentLink;
      }
      if (selector.includes("data-github-pull-commit-index")) {
        return commitLink;
      }
      if (selector.includes("github-pull-viewer-scroll")) return scrollport;
      return null;
    },
    querySelectorAll: () => [],
  };

  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:pull:detail",
    clipRoots: [clipRoot],
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label, controlKind }) => ({
      id,
      actionId,
      label,
      controlKind,
    })),
    [
      {
        id: "github:pull:detail:7:start-task",
        actionId: "task.github.start",
        label: "Start Task for pull request #7",
        controlKind: "button",
      },
      {
        id: "github:pull:detail:7:files",
        actionId: "navigation.pull.files",
        label: "Open files for PR #7",
        controlKind: "button",
      },
      {
        id: "github:pull:detail:7:github",
        actionId: "link.open",
        label: "Open pull request #7 on GitHub in a new tab",
        controlKind: "link",
      },
      {
        id: "github:pull:detail:7:comment:0",
        actionId: "link.open",
        label: "Open conversation comment 1 on GitHub in a new tab",
        controlKind: "link",
      },
      {
        id: "github:pull:detail:7:commit:abcdef1234567890",
        actionId: "link.open",
        label: "Open commit abcdef1 on GitHub in a new tab",
        controlKind: "link",
      },
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
  for (const target of scope.targets.slice(0, 3)) {
    assert.deepEqual(target.clipRoots, [owner, clipRoot]);
  }
  for (const target of scope.targets.slice(3)) {
    assert.deepEqual(target.clipRoots, [owner, scrollport, clipRoot]);
  }
  assert.deepEqual(scope.scrollRoots, [scrollport]);
  scope.targets[0].activate();
  scope.targets[1].activate();
  assert.deepEqual(focusOptions, [
    ["start", { preventScroll: true }],
    ["files", { preventScroll: true }],
  ]);
  assert.deepEqual(clicks, ["start", "files"]);

  files = null;
  assert.equal(scope.targets[0].isActionable(), true);
  assert.equal(scope.targets[1].isActionable(), false);
  owner.state = {
    status: "ready",
    payload: {
      pull: {
        number: 8,
        url: "https://github.com/example/repo/pull/8",
      },
    },
  };
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});

test("merges current Pull Markdown child scopes through the retained scrollport", () => {
  const state = {
    status: "ready",
    payload: {
      pull: {
        number: 7,
        url: "https://github.com/example/repo/pull/7",
      },
    },
  };
  const scrollport = { getClientRects: () => [{}] };
  const generated = { id: "generated-link" };
  let received;
  const markdown = {
    dataset: { markdownIndex: "2" },
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
  const owner = {
    hidden: false,
    isConnected: true,
    state,
    querySelector(selector) {
      if (selector.includes("github-pull-viewer-scroll")) return scrollport;
      return null;
    },
    querySelectorAll: () => [markdown],
  };
  const scope = page.actionHintScope.call(owner, {
    scopeId: "github:pull:detail",
  });

  assert.deepEqual(scope.targets, [generated]);
  assert.equal(
    received.scopeId,
    "github:pull:detail:7:markdown:2",
  );
  assert.deepEqual(received.clipRoots, [owner, scrollport]);
  assert.equal(received.isCurrent(), false);
  owner.querySelector = (selector) =>
    selector.includes('data-markdown-index="2"')
      ? markdown
      : selector.includes("github-pull-viewer-scroll") ? scrollport : null;
  assert.equal(received.isCurrent(), true);
  owner.state = { ...state };
  assert.equal(received.isCurrent(), false);
});

test("provides the retained Pull Request detail scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 440,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state: { status: "ready", payload: { pull: { number: 7 } } },
    getClientRects: () => [{}],
    querySelector: () => scrollport,
    querySelectorAll: () => [],
  };
  const scope = page.scrollSurfaceScope.call(owner);
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.equal(scope.surfaces[0].isEligible(), true);
  owner.hidden = true;
  assert.equal(scope.surfaces[0].isEligible(), false);
});

test("merges current Pull Markdown scroll scopes through the retained detail scrollport", () => {
  const state = {
    status: "ready",
    payload: { pull: { number: 7 } },
  };
  const scrollport = { getClientRects: () => [{}] };
  const generated = { id: "generated-scroll" };
  let received;
  const markdown = {
    dataset: { markdownIndex: "2" },
    scrollSurfaceScope(options) {
      received = options;
      return {
        blocked: false,
        surfaces: [generated],
        mutationRoots: [this],
        resizeElements: [this],
        scrollRoots: [this],
      };
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    state,
    getClientRects: () => [{}],
    querySelector(selector) {
      return selector.includes("github-pull-viewer-scroll")
        ? scrollport
        : null;
    },
    querySelectorAll: () => [markdown],
  };

  const scope = page.scrollSurfaceScope.call(owner, {
    scopeId: "github:pull:detail",
  });

  assert.deepEqual(scope.surfaces.slice(1), [generated]);
  assert.equal(received.scopeId, "github:pull:detail:7:markdown:2");
  assert.equal(received.label, "Pull request Markdown 3");
  assert.deepEqual(received.clipRoots, [owner, scrollport]);
  assert.equal(received.isCurrent(), false);
  owner.querySelector = (selector) =>
    selector.includes('data-markdown-index="2"')
      ? markdown
      : selector.includes("github-pull-viewer-scroll") ? scrollport : null;
  assert.equal(received.isCurrent(), true);
  owner.state = { ...state };
  assert.equal(received.isCurrent(), false);
});
