import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-viewer.js");
const fileViewer = registry.element("caffold-review-file-viewer").prototype;
after(() => registry.restore());

test("provides only the visible owned Back or close button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute(name) {
      return name === "aria-label" ? "Back to changed files" : null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    closeLabel: "Close file",
    querySelector() {
      return control;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:close",
      actionId: "navigation.parent",
      label: "Back to changed files",
      controlKind: "button",
    },
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  control = null;
  assert.equal(target.isActionable(), false);
  assert.deepEqual(fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    actionId: "navigation.parent",
  }).targets, []);
});

test("provides a direct notice representation action through its owned button", () => {
  const clipRoot = {};
  const focusOptions = [];
  let clicks = 0;
  let noticeControl = {
    dataset: { action: "view-preview" },
    disabled: false,
    textContent: "View rendered preview",
    getAttribute() {
      return null;
    },
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      if (selector.includes('data-action="close-browser-viewer"')) {
        return null;
      }
      return noticeControl;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    noticeActionId: "navigation.review.axis",
    clipRoots: [clipRoot],
  });
  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "review:viewer:notice:view-preview",
      actionId: "navigation.review.axis",
      label: "View rendered preview",
      controlKind: "button",
    },
  );
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  noticeControl = null;
  assert.equal(target.isActionable(), false);
});

test("provides file details opener and no action inside a diff's popover", () => {
  const control = {
    disabled: false,
    focus() {},
    click() {},
    getAttribute(name) {
      return name === "aria-label"
        ? "Show details for PLAN.md"
        : name === "popovertarget"
          ? "file-details"
          : null;
    },
  };
  const dialog = {};
  const hud = {};
  const selector = {};
  const presentation = {
    actionHintDialog: () => dialog,
    scrollModeHud: () => hud,
    scrollSurfaceSelector: () => selector,
  };
  const popover = {
    id: "file-details",
    matches: () => false,
    querySelector(selector) {
      return selector.includes("keyboard-navigation-presentation")
        ? presentation
        : {};
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    detailsPopover: () => popover,
    hasDetailsMetadata: () => true,
    downloadLink: () => null,
    querySelector(selector) {
      if (selector.includes("viewer-info-button")) {
        return control;
      }
      return null;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    detailsActionId: "navigation.file-details.open",
  });
  assert.equal(scope.targets[0].actionId, "navigation.file-details.open");
  assert.equal(scope.targets[0].label, "Show details for PLAN.md");
  assert.equal(scope.targets[0].isActionable(), true);

  const [context] = fileViewer.keyboardNavigationContexts.call(owner, {
    scopeId: "review:viewer",
  });
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.dialog, dialog);
  assert.deepEqual(context.actionHints.scope.targets, []);
  assert.equal(context.actionHints.sessionBound, false);
  assert.equal(context.scroll.hud, hud);
  assert.equal(context.scroll.selector, selector);
  assert.equal(context.scroll.scope.surfaces[0].scrollport, popover);
});

test("provides Download inside a source file's details popover", () => {
  const presentation = {
    actionHintDialog: () => ({}),
    scrollModeHud: () => ({}),
    scrollSurfaceSelector: () => ({}),
  };
  const popover = {
    querySelector(selector) {
      return selector.includes("keyboard-navigation-presentation")
        ? presentation
        : null;
    },
  };
  let clicks = 0;
  const link = {
    textContent: "\n  Download\n",
    focus() {},
    click() {
      clicks += 1;
    },
    getAttribute(name) {
      return name === "href" ? "/api/download?path=dist%2Fbuild.zip" : null;
    },
  };
  let currentLink = link;
  const owner = {
    hidden: false,
    isConnected: true,
    detailsPopover: () => popover,
    hasDetailsMetadata: () => true,
    downloadLink: () => currentLink,
  };

  const [context] = fileViewer.keyboardNavigationContexts.call(owner, {
    scopeId: "review:viewer",
  });
  const [target] = context.actionHints.scope.targets;
  assert.equal(context.actionHints.sessionBound, true);
  assert.equal(context.actionHints.scope.targets.length, 1);
  assert.equal(target.actionId, "link.open");
  assert.equal(target.label, "Download");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  currentLink = { ...link };
  assert.equal(target.isActionable(), false);
});

test("provides its owned refresh button beside existing viewer actions", () => {
  let current;
  let clicks = 0;
  const refresh = {
    disabled: false,
    getAttribute: () => "Refresh file",
    focus() {},
    click() {
      clicks += 1;
    },
  };
  current = refresh;
  const owner = {
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      return selector.includes("viewer-refresh-button") ? current : null;
    },
  };

  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    refreshActionId: "button.activate",
  });
  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].id, "review:viewer:refresh");
  assert.equal(scope.targets[0].label, "Refresh file");
  scope.targets[0].activate();
  assert.equal(clicks, 1);

  current = null;
  assert.equal(scope.targets[0].isActionable(), false);
});

test("merges only the current Markdown preview Action Hint scope", () => {
  const state = { status: "markdown" };
  const previewTarget = { id: "preview-link" };
  let received;
  let preview = {
    actionHintScope(options) {
      received = options;
      return {
        blocked: false,
        targets: [previewTarget],
        mutationRoots: [this],
        scrollRoots: [this],
      };
    },
  };
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    querySelector(selector) {
      return selector.includes("caffold-markdown-preview") ? preview : null;
    },
  };
  const scope = fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
    linkActionId: "link.open",
    clipRoots: [{ id: "layout" }],
  });

  assert.deepEqual(scope.targets, [previewTarget]);
  assert.equal(received.scopeId, "review:viewer:preview");
  assert.equal(received.linkActionId, "link.open");
  assert.deepEqual(received.clipRoots, [owner, { id: "layout" }]);
  assert.equal(received.isCurrent(), true);
  preview = null;
  assert.equal(received.isCurrent(), false);
  owner.state = { status: "file" };
  assert.deepEqual(fileViewer.actionHintScope.call(owner, {
    scopeId: "review:viewer",
  }).targets, []);
});

test("delegates source scrolling and invalidates it when viewer state changes", () => {
  const state = {
    status: "file",
    presentation: { title: "PLAN.md" },
  };
  let received;
  const childScope = { surfaces: [{ id: "source" }] };
  const codeViewer = {
    scrollSurfaceScope(options) {
      received = options;
      return childScope;
    },
  };
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    querySelector: () => codeViewer,
  };

  assert.equal(fileViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer",
  }), childScope);
  assert.equal(received.scopeId, "review:viewer:source");
  assert.equal(received.label, "PLAN.md source");
  assert.equal(received.isCurrent(), true);

  owner.state = { ...state };
  assert.equal(received.isCurrent(), false);
});

test("delegates document scrolling to the retained viewer of its kind", () => {
  for (const { kind, tagName, title } of [
    { kind: "pdf", tagName: "caffold-pdf-viewer", title: "manual.pdf" },
    { kind: "docx", tagName: "caffold-docx-viewer", title: "report.docx" },
    { kind: "pptx", tagName: "caffold-pptx-viewer", title: "deck.pptx" },
    { kind: "xlsx", tagName: "caffold-xlsx-viewer", title: "budget.xlsm" },
  ]) {
    const state = {
      status: "document",
      document: { kind },
      presentation: { title },
    };
    let received;
    let selector;
    const childScope = { surfaces: [{ id: kind }] };
    let preview = {
      scrollSurfaceScope(options) {
        received = options;
        return childScope;
      },
    };
    const owner = {
      state,
      hidden: false,
      isConnected: true,
      querySelector: (query) => {
        selector = query;
        return preview;
      },
    };

    assert.equal(fileViewer.scrollSurfaceScope.call(owner, {
      scopeId: "review:viewer",
    }), childScope);
    assert.equal(selector, `:scope > .document-panel > ${tagName}`);
    assert.equal(received.scopeId, `review:viewer:${kind}`);
    assert.equal(received.label, `${title} preview`);
    assert.equal(received.isCurrent(), true);

    owner.state = { ...state };
    assert.equal(received.isCurrent(), false);
    owner.state = state;
    preview = null;
    assert.deepEqual(fileViewer.scrollSurfaceScope.call(owner, {
      scopeId: "review:viewer",
    }).surfaces, []);
  }
});

test("merges the Action Hint scope of the retained viewer of the document's kind", () => {
  for (const { kind, tagName } of [
    { kind: "pdf", tagName: "caffold-pdf-viewer" },
    { kind: "docx", tagName: "caffold-docx-viewer" },
    { kind: "pptx", tagName: "caffold-pptx-viewer" },
    { kind: "xlsx", tagName: "caffold-xlsx-viewer" },
  ]) {
    const state = { status: "document", document: { kind } };
    const documentTarget = { id: `${kind}-link` };
    let received;
    let selector;
    let preview = {
      actionHintScope(options) {
        received = options;
        return {
          blocked: false,
          targets: [documentTarget],
          mutationRoots: [this],
          scrollRoots: [],
        };
      },
    };
    const owner = {
      state,
      hidden: false,
      isConnected: true,
      querySelector(query) {
        if (query.includes(".document-panel")) {
          selector = query;
          return preview;
        }
        return null;
      },
      documentActionHintScope(...args) {
        return fileViewer.documentActionHintScope.call(this, ...args);
      },
    };

    const scope = fileViewer.actionHintScope.call(owner, {
      scopeId: "review:viewer",
      linkActionId: "link.open",
      buttonActionId: "button.activate",
      clipRoots: [{ id: "layout" }],
    });

    assert.deepEqual(scope.targets, [documentTarget]);
    assert.equal(selector, `:scope > .document-panel > ${tagName}`);
    assert.equal(received.scopeId, "review:viewer:document");
    assert.equal(received.linkActionId, "link.open");
    assert.equal(received.buttonActionId, "button.activate");
    assert.deepEqual(received.clipRoots, [owner, { id: "layout" }]);
    assert.equal(received.isCurrent(), true);
    owner.state = { ...state };
    assert.equal(received.isCurrent(), false);
    owner.state = state;
    preview = null;
    assert.equal(received.isCurrent(), false);
    assert.deepEqual(fileViewer.actionHintScope.call(owner, {
      scopeId: "review:viewer",
    }).targets, []);
  }
});

test("keeps an owned image surface bound to its exact retained scrollport", () => {
  const state = { status: "image", image: { name: "shot.png" } };
  const scrollport = {
    isConnected: true,
    clientHeight: 100,
    scrollHeight: 260,
    getClientRects: () => [{}],
  };
  let current = scrollport;
  const owner = {
    state,
    hidden: false,
    isConnected: true,
    getClientRects: () => [{}],
    querySelector: () => current,
    ownScrollSurfaceScope(options) {
      return fileViewer.ownScrollSurfaceScope.call(this, options);
    },
  };

  const scope = fileViewer.scrollSurfaceScope.call(owner, {
    scopeId: "review:viewer",
  });
  assert.equal(scope.surfaces[0].scrollport, scrollport);
  assert.deepEqual(scope.surfaces[0].axes, ["vertical", "horizontal"]);
  assert.equal(scope.surfaces[0].isEligible(), true);
  current = { ...scrollport };
  assert.equal(scope.surfaces[0].isEligible(), false);
});

// Load requests, the retained-content timer, and arriving states reach the
// viewer separately; these cover every transition of that model.
function retainingViewer(state) {
  const timers = new Map();
  let nextTimerId = 0;
  globalThis.window = {
    setTimeout(callback, delay) {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay });
      return nextTimerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const owner = {
    state,
    retainedContent: null,
    renders: [],
    render() {
      this.renders.push(this.state);
    },
    detailsPopover: () => null,
  };
  for (const method of [
    "setLoading",
    "finishRetainedContent",
    "cancelRetainedContent",
    "deactivate",
    "closeDetailsPopover",
    "setNotice",
    "setEmpty",
  ]) {
    owner[method] = fileViewer[method].bind(owner);
  }
  const runTimers = () => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.callback();
    }
  };
  return { owner, timers, runTimers };
}

after(() => {
  delete globalThis.window;
});

const shown = { status: "notice", message: "README.md", actionLabel: "", action: "", title: "" };

test("keeps shown content while another file loads and replaces it when that file arrives", () => {
  const { owner, timers } = retainingViewer(shown);

  owner.setLoading({ title: "next.md" });
  assert.equal(owner.state, shown, "the previous content stays");
  assert.deepEqual(owner.renders, []);
  assert.deepEqual([...timers.values()].map((timer) => timer.delay), [180]);

  owner.setNotice("next.md");
  assert.equal(timers.size, 0, "an arriving state ends the wait");
  assert.equal(owner.retainedContent, null);
  assert.equal(owner.state.message, "next.md");
  assert.equal(owner.renders.length, 1);
});

test("a wait past its deadline shows the latest request's loading state at once", () => {
  const { owner, timers, runTimers } = retainingViewer(shown);

  owner.setLoading({ title: "first.md" });
  owner.setLoading({ title: "second.md" });
  assert.equal(timers.size, 1, "a later request keeps the first deadline");
  assert.equal(owner.state, shown);

  runTimers();
  assert.deepEqual(owner.state, {
    status: "loading",
    presentation: { title: "second.md" },
    waited: true,
  });
  assert.equal(owner.retainedContent, null);
  assert.equal(owner.renders.length, 1);

  owner.setLoading({ title: "third.md" });
  assert.deepEqual(owner.state, {
    status: "loading",
    presentation: { title: "third.md" },
    waited: true,
  });
  assert.equal(timers.size, 0, "a request while loading stays in the loading state");
});

test("with nothing shown, a request loads at once and leaves the phrase its own delay", () => {
  const { owner, timers } = retainingViewer({ status: "empty" });

  owner.setLoading({ title: "first.md" });
  assert.deepEqual(owner.state, {
    status: "loading",
    presentation: { title: "first.md" },
    waited: false,
  });
  assert.equal(timers.size, 0);
  assert.equal(owner.renders.length, 1);

  owner.setNotice("first.md");
  assert.equal(owner.state.status, "notice", "an arriving state replaces the loading state");
});

test("deactivation ends the wait and leaves the previous content shown", () => {
  const { owner, timers } = retainingViewer(shown);

  owner.setLoading({ title: "next.md" });
  owner.closeDetailsPopover();
  assert.equal(timers.size, 1, "closing the details popover, as every render does, keeps the wait");
  owner.deactivate();
  assert.equal(timers.size, 0);
  assert.equal(owner.retainedContent, null);
  assert.equal(owner.state, shown);

  owner.setLoading({ title: "next.md" });
  assert.equal(timers.size, 1, "a request after reactivation waits again");
});

test("a deadline whose wait already ended changes nothing", () => {
  const { owner, timers } = retainingViewer(shown);

  owner.setLoading({ title: "next.md" });
  const [stale] = [...timers.values()];
  owner.setEmpty();
  stale.callback();
  assert.deepEqual(owner.state, { status: "empty" });
  assert.equal(owner.renders.length, 1);
});

test("the loading state keeps its phrase when only the header changes", () => {
  let header = null;
  let html = "";
  const panel = {};
  const owner = {
    state: { status: "loading", presentation: { title: "next.md" }, waited: true },
    querySelector: () => panel,
    replacePresentationHeader(target, presentation) {
      header = { target, presentation };
    },
    set innerHTML(value) {
      html = value;
    },
  };
  fileViewer.renderLoading.call(owner);
  assert.deepEqual(header, { target: panel, presentation: { title: "next.md" } });
  assert.equal(html, "", "the phrase element is left in place");

  owner.querySelector = () => null;
  owner.renderPresentationHeader = () => "<header></header>";
  fileViewer.renderLoading.call(owner);
  assert.match(html, /<caffold-loading-text immediate>Loading file\.\.\.<\/caffold-loading-text>/);

  owner.state = { ...owner.state, waited: false };
  fileViewer.renderLoading.call(owner);
  assert.match(html, /<caffold-loading-text>Loading file\.\.\.<\/caffold-loading-text>/);
});
