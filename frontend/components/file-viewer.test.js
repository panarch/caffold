import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-viewer.ts");
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
    state: { status: "file" },
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
    state: { status: "notice" },
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
    state: { status: "file" },
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
    state: { status: "file" },
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
    detailsPopover: () => null,
  };
  // Each state the viewer shows is one it draws.
  owner.show = () => {
    owner.renders.push(owner.state);
    fileViewer.show.call(owner);
  };
  for (const method of [
    "setLoading",
    "finishRetainedContent",
    "cancelRetainedContent",
    "deactivate",
    "closeDetailsPopover",
    "releasePreviewFile",
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
  assert.equal(timers.size, 1, "closing the details popover, as every new state does, keeps the wait");
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

// A preview file is fetched by the viewer and moves between reading, shown,
// rechecking, and failed; these walk every move with a server whose answers
// can be held back, fail, or name another version.
// Each test fetches files of its own names: the fetch schedule is one for the
// whole page and shares a fetch of the same address.
const ORIGIN = "http://caffold.test";

function previewAddress(path) {
  return `${ORIGIN}/api/document?${new URLSearchParams({ path })}`;
}

function fileServer(files) {
  const requests = [];
  const waiting = [];
  const server = {
    requests,
    holding: false,
    letThrough() {
      server.holding = false;
      for (const resume of waiting.splice(0)) {
        resume();
      }
    },
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).searchParams.get("path");
    requests.push(path);
    if (server.holding) {
      await new Promise((resume) => waiting.push(resume));
    }
    const file = files[path];
    if (!file || file.failing) {
      return new Response(null, { status: 500 });
    }
    const bytes = new TextEncoder().encode(file.text);
    return new Response(bytes, {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        "Content-Type": file.type ?? "application/pdf",
        ETag: `"${file.version}"`,
      },
    });
  };
  after(() => {
    globalThis.fetch = previous;
  });
  return server;
}

function previewHost(status = "document") {
  const handed = [];
  const errors = [];
  const host = Object.assign(Object.create(fileViewer), {
    state: status === "image"
      ? { status, image: { path: "picture.png", name: "picture.png" } }
      : { status, document: { kind: "pdf", path: "document.pdf" } },
    previewFile: null,
    imageSource: "",
    querySelector: () => null,
    setError: (presentation, error) => errors.push(error.message),
  });
  // The document viewer is handed what the template binds; it waits for the
  // file, so a fetch let go of ends there.
  Object.defineProperty(host, "documentFile", {
    get: () => handed.at(-1) ?? null,
    set: (documentFile) => {
      if (documentFile) {
        Promise.resolve(documentFile.file).catch(() => {});
        handed.push(documentFile);
      }
    },
  });
  return { host, handed, errors };
}

async function until(condition) {
  for (let turn = 0; turn < 100 && !condition(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(condition(), "the awaited state arrived");
}

async function blobText(file) {
  return (await file).text();
}

test("fetches a preview once, hands a document viewer that fetch, and keeps the copy", async () => {
  const server = fileServer({ "a1.pdf": { text: "first", version: "v1" } });
  const { host, handed } = previewHost();

  host.showPreviewFile(previewAddress("a1.pdf"));
  assert.equal(host.previewFile.phase, "reading");
  assert.equal(handed.length, 1, "the viewer is handed the fetch itself");
  await until(() => host.previewFile.phase === "shown");

  assert.equal(await blobText(handed[0].file), "first");
  assert.equal(host.previewFile.version, "v1");
  host.showPreviewFile(previewAddress("a1.pdf"));
  assert.deepEqual(server.requests, ["a1.pdf"], "showing the same file again fetches nothing");
  assert.equal(handed.length, 1);
});

test("a recheck keeps a file the server answers with the same version", async () => {
  const server = fileServer({ "a2.pdf": { text: "first", version: "v1" } });
  const { host, handed } = previewHost();
  host.showPreviewFile(previewAddress("a2.pdf"));
  await until(() => host.previewFile.phase === "shown");

  host.recheckPreviewFile();
  assert.equal(host.previewFile.phase, "rechecking");
  await until(() => host.previewFile.phase === "shown");

  assert.deepEqual(server.requests, ["a2.pdf", "a2.pdf"]);
  assert.equal(handed.length, 1, "nothing is drawn again");
});

test("a recheck hands over a newer version as a newer copy", async () => {
  const files = { "a3.pdf": { text: "first", version: "v1" } };
  fileServer(files);
  const { host, handed } = previewHost();
  host.showPreviewFile(previewAddress("a3.pdf"));
  await until(() => host.previewFile.phase === "shown");

  files["a3.pdf"] = { text: "second", version: "v2" };
  host.recheckPreviewFile();
  await until(() => host.previewFile.phase === "shown" && handed.length === 2);

  assert.equal(await blobText(handed[1].file), "second");
  assert.equal(handed[1].newerCopy, true);
  assert.equal(host.previewFile.version, "v2");
});

test("a recheck asked for during a fetch asks once more after it", async () => {
  const files = { "a4.pdf": { text: "first", version: "v1" } };
  const server = fileServer(files);
  const { host, handed } = previewHost();
  server.holding = true;
  host.showPreviewFile(previewAddress("a4.pdf"));
  host.recheckPreviewFile();
  host.recheckPreviewFile();
  assert.equal(host.previewFile.phase, "reading", "a fetch on its way is not doubled");

  files["a4.pdf"] = { text: "second", version: "v2" };
  server.letThrough();
  await until(() => server.requests.length === 2 && host.previewFile.phase === "shown");

  assert.equal(host.previewFile.version, "v2");
  assert.equal(await blobText(handed.at(-1).file), "second");

  server.holding = true;
  host.recheckPreviewFile();
  host.recheckPreviewFile();
  assert.equal(host.previewFile.phase, "rechecking");
  server.letThrough();
  await until(() => server.requests.length === 4 && host.previewFile.phase === "shown");
  assert.equal(server.requests.length, 4, "one recheck while rechecking asks once more");
});

test("a failed first fetch shows its failure and the next showing fetches again", async () => {
  const files = { "a5.png": { text: "png", version: "v1", type: "image/png", failing: true } };
  const server = fileServer(files);
  const { host, errors } = previewHost("image");

  host.showPreviewFile(previewAddress("a5.png"));
  await until(() => host.previewFile.phase === "failed");
  assert.deepEqual(errors, ["Image preview failed to load."]);

  host.recheckPreviewFile();
  assert.equal(host.previewFile.phase, "failed", "a recheck of a failed file does nothing");
  files["a5.png"].failing = false;
  host.showPreviewFile(previewAddress("a5.png"));
  await until(() => host.previewFile.phase === "shown");
  assert.deepEqual(server.requests, ["a5.png", "a5.png"]);
});

test("a failed recheck keeps the copy already drawn", async () => {
  const files = { "a6.pdf": { text: "first", version: "v1" } };
  fileServer(files);
  const { host, handed } = previewHost();
  host.showPreviewFile(previewAddress("a6.pdf"));
  await until(() => host.previewFile.phase === "shown");

  files["a6.pdf"].failing = true;
  host.recheckPreviewFile();
  await until(() => host.previewFile.phase === "shown" && host.previewFile.fetching === null);

  assert.equal(host.previewFile.version, "v1");
  assert.equal(handed.length, 1);
});

test("an image is drawn from its copy, again only for a newer version", async () => {
  const files = { "a7.png": { text: "png", version: "v1", type: "image/png" } };
  fileServer(files);
  const { host } = previewHost("image");
  host.showPreviewFile(previewAddress("a7.png"));
  await until(() => host.imageSource !== "");
  const first = host.imageSource;
  assert.match(first, /^blob:/);

  host.imageSource = "";
  host.drawPreviewImage();
  assert.equal(host.imageSource, first, "a picture shown anew takes the same copy");

  host.recheckPreviewFile();
  await until(() => host.previewFile.phase === "shown");
  assert.equal(host.imageSource, first, "the same version is not drawn again");

  files["a7.png"] = { text: "png2", version: "v2", type: "image/png" };
  host.recheckPreviewFile();
  await until(() => host.previewFile.version === "v2");
  assert.notEqual(host.imageSource, first);
  assert.match(host.imageSource, /^blob:/);
});

test("deactivation lets go of the preview file and its fetch", () => {
  const server = fileServer({});
  const { host } = previewHost();
  host.cancelRetainedContent = () => {};
  host.closeDetailsPopover = () => {};
  server.holding = true;

  host.showPreviewFile(previewAddress("a8.pdf"));
  const fetching = host.previewFile.fetching;
  host.deactivate();

  assert.equal(fetching.signal.aborted, true);
  assert.equal(host.previewFile, null);
  server.letThrough();
});

test("another file, or letting go, ends the fetch of the one before", () => {
  const server = fileServer({});
  const { host } = previewHost();
  server.holding = true;

  host.showPreviewFile(previewAddress("a9.pdf"));
  const first = host.previewFile.fetching;
  host.showPreviewFile(previewAddress("b9.pdf"));
  assert.equal(first.signal.aborted, true);
  assert.equal(host.previewFile.url, previewAddress("b9.pdf"));

  const second = host.previewFile.fetching;
  host.releasePreviewFile();
  assert.equal(second.signal.aborted, true);
  assert.equal(host.previewFile, null);
  server.letThrough();
});

test("a recheck applies only to a preview held before the new state", async () => {
  const server = fileServer({ "a10.pdf": { text: "first", version: "v1" } });
  const { host } = previewHost();
  globalThis.window = { location: new URL(ORIGIN) };

  host.setDocument({ kind: "pdf", path: "a10.pdf" }, { recheck: true });
  await until(() => host.previewFile.phase === "shown");
  assert.deepEqual(server.requests, ["a10.pdf"], "a file shown for the first time is fetched once");

  host.setDocument({ kind: "pdf", path: "a10.pdf" }, { recheck: true });
  await until(() => server.requests.length === 2 && host.previewFile.phase === "shown");
  host.setDocument({ kind: "pdf", path: "a10.pdf" });
  assert.equal(server.requests.length, 2, "a load without recheck shows the file held");
});
