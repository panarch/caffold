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
  const host = elementStandIn(fileViewer, {
    state: status === "image"
      ? { status, image: { path: "picture.png", name: "picture.png" } }
      : { status, document: { kind: "pdf", path: "document.pdf" } },
    previewFile: null,
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
