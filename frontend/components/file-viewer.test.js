import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  elementStandIn,
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./file-viewer.js");
const fileViewer = registry.element("caffold-review-file-viewer").prototype;
after(() => registry.restore());

// A viewer whose own declarations make `ownTarget` and `ownSurface`, and
// whose drawn children are the given refs.
function viewerWith(state, children = {}) {
  const owner = elementStandIn(fileViewer, {
    state,
    hints: {
      scope: () => ({ blocked: false, targets: [{ id: "own" }], mutationRoots: [owner], scrollRoots: [] }),
    },
    surfaces: {
      scope: () => ({ blocked: false, surfaces: [{ id: "own" }], mutationRoots: [owner], resizeElements: [], scrollRoots: [] }),
    },
    codeViewer: { value: children.codeViewer },
    diffViewer: { value: children.diffViewer },
    preview: { value: children.preview },
    documentViewer: { value: children.documentViewer },
    visualDiff: { value: children.visualDiff },
    changeControl: { value: children.changeControl },
  });
  return owner;
}

test("merges the Action Hints of the Markdown preview it draws", () => {
  let received;
  const preview = {
    actionHintScope(pull) {
      received = pull;
      return { targets: [{ id: "preview-link" }] };
    },
  };
  const layout = { id: "layout" };
  const actions = { link: "link.open" };
  const owner = viewerWith({ status: "markdown" }, { preview });

  const scope = owner.actionHintScope({
    scopeId: "review:viewer",
    actions,
    clipRoots: [layout],
  });

  assert.deepEqual(scope.targets.map(({ id }) => id), ["own", "preview-link"]);
  assert.deepEqual(received, {
    scopeId: "review:viewer:preview",
    actions,
    clipRoots: [owner, layout],
  });
  assert.deepEqual(
    viewerWith({ status: "file" }).actionHintScope({ scopeId: "review:viewer" })
      .targets.map(({ id }) => id),
    ["own"],
  );
});

test("names the source surface after the file it shows", () => {
  let received;
  const codeViewer = {
    scrollSurfaceScope(pull) {
      received = pull;
      return { surfaces: [{ id: "source" }] };
    },
  };
  const owner = viewerWith(
    { status: "file", presentation: { title: "PLAN.md" } },
    { codeViewer },
  );

  assert.deepEqual(
    owner.scrollSurfaceScope({ scopeId: "review:viewer" }).surfaces.map(({ id }) => id),
    ["own", "source"],
  );
  assert.deepEqual(received, {
    scopeId: "review:viewer:source",
    label: "PLAN.md source",
    clipRoots: [owner],
  });
});

test("passes scrolling and Action Hints to the document viewer of its kind", () => {
  for (const { kind, title } of [
    { kind: "pdf", title: "manual.pdf" },
    { kind: "docx", title: "report.docx" },
    { kind: "pptx", title: "deck.pptx" },
    { kind: "xlsx", title: "budget.xlsm" },
  ]) {
    const received = {};
    const documentViewer = {
      scrollSurfaceScope(pull) {
        received.scroll = pull;
        return { surfaces: [{ id: kind }] };
      },
      actionHintScope(pull) {
        received.actions = pull;
        return { targets: [{ id: `${kind}-link` }] };
      },
    };
    const owner = viewerWith(
      { status: "document", document: { kind }, presentation: { title } },
      { documentViewer },
    );
    const actions = { link: "link.open", button: "button.activate" };

    assert.deepEqual(
      owner.scrollSurfaceScope({ scopeId: "review:viewer" }).surfaces.map(({ id }) => id),
      ["own", kind],
    );
    assert.deepEqual(received.scroll, {
      scopeId: `review:viewer:${kind}`,
      label: `${title} preview`,
      clipRoots: [owner],
    });
    assert.deepEqual(
      owner.actionHintScope({ scopeId: "review:viewer", actions }).targets.map(({ id }) => id),
      ["own", `${kind}-link`],
    );
    assert.deepEqual(received.actions, {
      scopeId: "review:viewer:document",
      actions,
      clipRoots: [owner],
    });
  }
});

test("names where the leaf it shows was last read", () => {
  const code = { anchor: { page: 30, fraction: 0.25 }, left: 0 };
  const scroll = { top: 40, left: 0 };
  const anchor = { page: 2, fraction: 0.5 };
  const workbook = { sheet: "Q2", scrolls: new Map() };
  const leaf = (position) => ({ readingPosition: () => position });
  for (const [state, children, expected] of [
    [{ status: "file" }, { codeViewer: leaf(code) }, code],
    [{ status: "diff" }, { diffViewer: leaf(code) }, code],
    [{ status: "markdown" }, { preview: leaf(scroll) }, scroll],
    [{ status: "document", document: { kind: "pdf" } }, { documentViewer: leaf(anchor) }, anchor],
    [{ status: "document", document: { kind: "xlsx" } }, { documentViewer: leaf(workbook) }, workbook],
    [{ status: "visual" }, { visualDiff: leaf(anchor) }, anchor],
    [{ status: "image" }, {}, null],
    [{ status: "loading" }, { codeViewer: leaf(code) }, null],
  ]) {
    assert.equal(viewerWith(state, children).readingPosition(), expected, state.status);
  }
});

test("opens source or a diff where its owner kept it, and ignores another kind of place", () => {
  const owner = viewerWith({ status: "empty" });
  owner.previewFiles = {};
  owner.detailsPopover = { value: null };
  const file = { path: "a.js", content: "a" };
  const kept = { anchor: { page: 40, fraction: 0.5 }, left: 3 };

  owner.setFile(file, { position: kept });
  assert.deepEqual(owner.state.position, { scroll: kept, line: undefined });

  for (const other of [{ page: 1, fraction: 0.5 }, { top: 40, left: 3 }]) {
    owner.setFile(file, { position: other });
    assert.deepEqual(owner.state.position, { scroll: null, line: undefined });
  }

  owner.setDiff({ path: "a.js", diff: "" }, { position: kept });
  assert.deepEqual(owner.state.position, { scroll: kept, line: undefined });
});

test("keeps Wrap as the device's choice and tells every file viewer on the page", () => {
  const stored = new Map();
  const sent = [];
  let storageWorks = true;
  globalThis.window = {
    localStorage: {
      setItem(key, value) {
        if (!storageWorks) {
          throw new Error("storage unavailable");
        }
        stored.set(key, value);
      },
    },
    dispatchEvent: (event) => sent.push(event),
  };
  const owner = elementStandIn(fileViewer, { wrap: false });

  fileViewer.toggleWrap.call(owner);
  assert.equal(stored.get("caffold:file-viewer-wrap"), "true");
  assert.equal(sent[0].type, "caffold:file-viewer-wrap-change");
  assert.deepEqual(sent[0].detail, { wrap: true });
  assert.equal(owner.wrap, false, "the viewer follows the event like the rest");

  owner.wrap = true;
  storageWorks = false;
  fileViewer.toggleWrap.call(owner);
  assert.equal(stored.get("caffold:file-viewer-wrap"), "true");
  assert.deepEqual(sent[1].detail, { wrap: false });
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
    detailsPopover: { value: null },
    previewFiles: {},
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
    "releasePreviewFiles",
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
    // A blob is named by its id; any other file by its path.
    const query = new URL(url).searchParams;
    const path = query.get("oid") ?? query.get("path");
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
  const host = elementStandIn(fileViewer, {
    state: status === "image"
      ? { status, image: { path: "picture.png", name: "picture.png" } }
      : { status, document: { kind: "pdf", path: "document.pdf" } },
    previewFiles: {},
    imageSource: "",
    detailsPopover: { value: null },
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

  host.showPreviewFile("file", previewAddress("a1.pdf"));
  assert.equal(host.previewFiles.file.phase, "reading");
  assert.equal(handed.length, 1, "the viewer is handed the fetch itself");
  await until(() => host.previewFiles.file.phase === "shown");

  assert.equal(await blobText(handed[0].file), "first");
  assert.equal(host.previewFiles.file.version, "v1");
  host.showPreviewFile("file", previewAddress("a1.pdf"));
  assert.deepEqual(server.requests, ["a1.pdf"], "showing the same file again fetches nothing");
  assert.equal(handed.length, 1);
});

test("hands the document viewer where the next file opens, and none for a file kept nowhere", async () => {
  fileServer({ "p1.pdf": { text: "first", version: "v1" } });
  const { host } = previewHost();
  globalThis.window = { location: new URL(ORIGIN) };
  const anchor = { page: 3, fraction: 0.2 };

  host.setDocument({ kind: "pdf", path: "p1.pdf" }, { position: anchor });
  assert.equal(host.documentPosition, anchor);
  await until(() => host.previewFiles.file.phase === "shown");

  host.setDocument({ kind: "pdf", path: "p1.pdf" });
  assert.equal(host.documentPosition, null);
});

test("a recheck keeps a file the server answers with the same version", async () => {
  const server = fileServer({ "a2.pdf": { text: "first", version: "v1" } });
  const { host, handed } = previewHost();
  host.showPreviewFile("file", previewAddress("a2.pdf"));
  await until(() => host.previewFiles.file.phase === "shown");

  host.recheckPreviewFile("file");
  assert.equal(host.previewFiles.file.phase, "rechecking");
  await until(() => host.previewFiles.file.phase === "shown");

  assert.deepEqual(server.requests, ["a2.pdf", "a2.pdf"]);
  assert.equal(handed.length, 1, "nothing is drawn again");
});

test("a recheck hands over a newer version as a newer copy", async () => {
  const files = { "a3.pdf": { text: "first", version: "v1" } };
  fileServer(files);
  const { host, handed } = previewHost();
  host.showPreviewFile("file", previewAddress("a3.pdf"));
  await until(() => host.previewFiles.file.phase === "shown");

  files["a3.pdf"] = { text: "second", version: "v2" };
  host.recheckPreviewFile("file");
  await until(() => host.previewFiles.file.phase === "shown" && handed.length === 2);

  assert.equal(await blobText(handed[1].file), "second");
  assert.equal(handed[1].newerCopy, true);
  assert.equal(host.previewFiles.file.version, "v2");
});

test("a recheck asked for during a fetch asks once more after it", async () => {
  const files = { "a4.pdf": { text: "first", version: "v1" } };
  const server = fileServer(files);
  const { host, handed } = previewHost();
  server.holding = true;
  host.showPreviewFile("file", previewAddress("a4.pdf"));
  host.recheckPreviewFile("file");
  host.recheckPreviewFile("file");
  assert.equal(host.previewFiles.file.phase, "reading", "a fetch on its way is not doubled");

  files["a4.pdf"] = { text: "second", version: "v2" };
  server.letThrough();
  await until(() => server.requests.length === 2 && host.previewFiles.file.phase === "shown");

  assert.equal(host.previewFiles.file.version, "v2");
  assert.equal(await blobText(handed.at(-1).file), "second");

  server.holding = true;
  host.recheckPreviewFile("file");
  host.recheckPreviewFile("file");
  assert.equal(host.previewFiles.file.phase, "rechecking");
  server.letThrough();
  await until(() => server.requests.length === 4 && host.previewFiles.file.phase === "shown");
  assert.equal(server.requests.length, 4, "one recheck while rechecking asks once more");
});

test("a failed first fetch shows its failure and the next showing fetches again", async () => {
  const files = { "a5.png": { text: "png", version: "v1", type: "image/png", failing: true } };
  const server = fileServer(files);
  const { host, errors } = previewHost("image");

  host.showPreviewFile("file", previewAddress("a5.png"));
  await until(() => host.previewFiles.file.phase === "failed");
  assert.deepEqual(errors, ["Image preview failed to load."]);

  host.recheckPreviewFile("file");
  assert.equal(host.previewFiles.file.phase, "failed", "a recheck of a failed file does nothing");
  files["a5.png"].failing = false;
  host.showPreviewFile("file", previewAddress("a5.png"));
  await until(() => host.previewFiles.file.phase === "shown");
  assert.deepEqual(server.requests, ["a5.png", "a5.png"]);
});

test("a failed recheck keeps the copy already drawn", async () => {
  const files = { "a6.pdf": { text: "first", version: "v1" } };
  fileServer(files);
  const { host, handed } = previewHost();
  host.showPreviewFile("file", previewAddress("a6.pdf"));
  await until(() => host.previewFiles.file.phase === "shown");

  files["a6.pdf"].failing = true;
  host.recheckPreviewFile("file");
  await until(() => host.previewFiles.file.phase === "shown" && host.previewFiles.file.fetching === null);

  assert.equal(host.previewFiles.file.version, "v1");
  assert.equal(handed.length, 1);
});

test("an image is drawn from its copy, again only for a newer version", async () => {
  const files = { "a7.png": { text: "png", version: "v1", type: "image/png" } };
  fileServer(files);
  const { host } = previewHost("image");
  host.showPreviewFile("file", previewAddress("a7.png"));
  await until(() => host.imageSource !== "");
  const first = host.imageSource;
  assert.match(first, /^blob:/);

  host.imageSource = "";
  host.drawPreviewImage();
  assert.equal(host.imageSource, first, "a picture shown anew takes the same copy");

  host.recheckPreviewFile("file");
  await until(() => host.previewFiles.file.phase === "shown");
  assert.equal(host.imageSource, first, "the same version is not drawn again");

  files["a7.png"] = { text: "png2", version: "v2", type: "image/png" };
  host.recheckPreviewFile("file");
  await until(() => host.previewFiles.file.version === "v2");
  assert.notEqual(host.imageSource, first);
  assert.match(host.imageSource, /^blob:/);
});

test("deactivation lets go of the preview file and its fetch", () => {
  const server = fileServer({});
  const { host } = previewHost();
  host.cancelRetainedContent = () => {};
  host.closeDetailsPopover = () => {};
  server.holding = true;

  host.showPreviewFile("file", previewAddress("a8.pdf"));
  const fetching = host.previewFiles.file.fetching;
  host.deactivate();

  assert.equal(fetching.signal.aborted, true);
  assert.equal(host.previewFiles.file, undefined);
  server.letThrough();
});

test("another file, or letting go, ends the fetch of the one before", () => {
  const server = fileServer({});
  const { host } = previewHost();
  server.holding = true;

  host.showPreviewFile("file", previewAddress("a9.pdf"));
  const first = host.previewFiles.file.fetching;
  host.showPreviewFile("file", previewAddress("b9.pdf"));
  assert.equal(first.signal.aborted, true);
  assert.equal(host.previewFiles.file.url, previewAddress("b9.pdf"));

  const second = host.previewFiles.file.fetching;
  host.releasePreviewFile("file");
  assert.equal(second.signal.aborted, true);
  assert.equal(host.previewFiles.file, undefined);
  server.letThrough();
});

test("a recheck applies only to a preview held before the new state", async () => {
  const server = fileServer({ "a10.pdf": { text: "first", version: "v1" } });
  const { host } = previewHost();
  globalThis.window = { location: new URL(ORIGIN) };

  host.setDocument({ kind: "pdf", path: "a10.pdf" }, { recheck: true });
  await until(() => host.previewFiles.file.phase === "shown");
  assert.deepEqual(server.requests, ["a10.pdf"], "a file shown for the first time is fetched once");

  host.setDocument({ kind: "pdf", path: "a10.pdf" }, { recheck: true });
  await until(() => server.requests.length === 2 && host.previewFiles.file.phase === "shown");
  host.setDocument({ kind: "pdf", path: "a10.pdf" });
  assert.equal(server.requests.length, 2, "a load without recheck shows the file held");
});

test("Visual fetches each side once and asks again only for the working tree side", async () => {
  const kept = "b".repeat(40);
  const gone = "c".repeat(40);
  const server = fileServer({
    [kept]: { text: "before", version: kept, type: "image/png" },
    "repo/v1.png": { text: "after", version: "v1", type: "image/png" },
  });
  const { host, errors } = previewHost("image");
  globalThis.window = { location: new URL(ORIGIN) };
  const handed = [];
  Object.defineProperty(host, "visualDiffElement", {
    get: () => ({ setComparison: ({ sides }) => handed.push(sides) }),
  });
  const presentation = { title: "v1.png" };
  const versions = {
    path: "repo/v1.png",
    repository: { rootPath: "repo" },
    before: { source: "blob", oid: kept },
    after: { source: "workingTree" },
  };
  const fetched = () =>
    handed.at(-1)?.before?.status === "fetched" &&
    handed.at(-1)?.after?.status === "fetched";

  host.setVisual(versions, { presentation });
  assert.deepEqual(handed.at(-1), {
    before: { status: "loading" },
    after: { status: "loading" },
  });
  await until(fetched);
  assert.deepEqual([...server.requests].sort(), [kept, "repo/v1.png"]);
  assert.equal(handed.at(-1).before.bytes, 6);

  host.setVisual(versions, { recheck: true, presentation });
  await until(() => server.requests.length === 3 && host.previewFiles.after.phase === "shown");
  assert.equal(server.requests.at(-1), "repo/v1.png", "a blob is never asked again");

  host.setVisual({ ...versions, before: { source: "blob", oid: gone } }, { presentation });
  await until(() => handed.at(-1)?.before?.status === "failed");
  assert.equal(handed.at(-1).after.status, "fetched", "the other side stays");
  assert.deepEqual(errors, [], "one side failing is not the viewer's error");

  host.setVisual({ ...versions, before: null }, { presentation });
  assert.equal(handed.at(-1).before, null);
  assert.equal(host.previewFiles.before, undefined, "a side the change lacks is let go");
});

test("Visual opens a change where its owner says it was read, and a later load keeps the place", async () => {
  fileServer({ "repo/v2.png": { text: "after", version: "v1", type: "image/png" } });
  const { host } = previewHost("image");
  globalThis.window = { location: new URL(ORIGIN) };
  const handed = [];
  Object.defineProperty(host, "visualDiffElement", {
    get: () => ({ setComparison: (comparison) => handed.push(comparison) }),
  });
  const versions = { path: "repo/v2.png", before: null, after: { source: "workingTree" } };
  const presentation = { title: "v2.png" };
  const anchor = { page: 1, fraction: 0.3 };

  host.setVisual(versions, { presentation, position: anchor });
  assert.equal(handed.at(-1).position, anchor);
  await until(() => host.previewFiles.after.phase === "shown");
  assert.equal(handed.at(-1).position, undefined, "a side that arrives keeps the place");

  host.setVisual(versions, { presentation, recheck: true });
  assert.equal(handed.at(-1).position, undefined);
  host.setVisual(versions, { presentation, position: { top: 4, left: 0 } });
  assert.equal(handed.at(-1).position, null, "a place another kind of leaf kept opens at the top");
});

test("offers the change choices its owner names and hands a choice back", () => {
  const owner = viewerWith({ status: "visual" });
  const intents = [];
  owner.dispatchEvent = (event) => intents.push([event.type, event.detail]);
  let stopped = false;

  owner.setChangeChoices({
    choices: [
      { value: "diff", label: "Diff" },
      { value: "visual", label: "Visual" },
    ],
    selected: "diff",
  });
  owner.chooseChange({
    detail: { value: "visual" },
    stopPropagation: () => {
      stopped = true;
    },
  });

  assert.equal(owner.changeChoices.selected, "diff");
  assert.equal(owner.changeChoices.choices.length, 2);
  assert.equal(stopped, true);
  assert.deepEqual(intents, [
    ["caffold:file-viewer-change-intent", { representation: "visual" }],
  ]);
});

test("merges the Action Hints and scrolling of Visual and the change choices", () => {
  const pulls = {};
  const visualDiff = {
    actionHintScope(pull) {
      pulls.visual = pull;
      return { targets: [{ id: "mode" }] };
    },
    scrollSurfaceScope(pull) {
      pulls.scroll = pull;
      return { surfaces: [{ id: "visual" }] };
    },
  };
  const changeControl = {
    actionHintScope(pull) {
      pulls.change = pull;
      return { targets: [{ id: "change" }] };
    },
  };
  const owner = viewerWith(
    { status: "visual", presentation: { title: "logo.svg" } },
    { visualDiff, changeControl },
  );
  const actions = { axis: "review.axis", button: "button.activate" };

  assert.deepEqual(
    owner.actionHintScope({ scopeId: "git:viewer", actions }).targets.map(({ id }) => id),
    ["own", "change", "mode"],
  );
  assert.equal(pulls.change.actionId, "review.axis");
  assert.equal(pulls.visual.scopeId, "git:viewer:visual");
  assert.deepEqual(
    owner.scrollSurfaceScope({ scopeId: "git:viewer" }).surfaces.map(({ id }) => id),
    ["own", "visual"],
  );
  assert.equal(pulls.scroll.label, "logo.svg visual");
});

test("keeps the way Visual compares while files change", () => {
  const handed = [];
  const owner = viewerWith({
    status: "visual",
    versions: { before: null, after: null },
  });
  owner.previewFiles = {};
  Object.defineProperty(owner, "visualDiffElement", {
    get: () => ({ setComparison: (comparison) => handed.push(comparison) }),
  });

  owner.chooseVisualMode({ detail: { mode: "difference" } });
  owner.drawVisualSides();

  assert.equal(owner.visualMode, "difference");
  assert.deepEqual(
    handed.map(({ mode }) => mode),
    ["difference", "difference"],
  );
});

test("hands its owner the adjacent file the person chose", () => {
  const events = [];
  const viewer = elementStandIn(fileViewer, {
    dispatchEvent: (event) => events.push(event),
  });

  viewer.setAdjacentFiles({
    previous: { path: "/repo/src/a.rs", name: "a.rs", folder: "src" },
    next: undefined,
  });
  assert.deepEqual(viewer.adjacentFiles, {
    previous: { path: "/repo/src/a.rs", name: "a.rs", folder: "src" },
    next: null,
  });

  viewer.openAdjacent({ currentTarget: { dataset: { adjacentPath: "/repo/src/a.rs" } } });
  viewer.openAdjacent({ currentTarget: { dataset: {} } });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:file-viewer-open-adjacent");
  assert.deepEqual(events[0].detail, { path: "/repo/src/a.rs" });
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].composed, true);
});
