import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const apiHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../api.js") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const getNotes=(...a)=>globalThis.notesApi.getNotes(...a);export const getNote=(...a)=>globalThis.notesApi.getNote(...a);",
      };
    }
    return nextResolve(specifier, context);
  },
});
const registry = installCustomElementUnitRegistry();
await import("./layout.js");
const workspace = registry.element("caffold-notes-workspace").prototype;
after(() => {
  registry.restore();
  apiHook.deregister();
  delete globalThis.notesApi;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readingOwner() {
  const owner = {
    noteId: "",
    active: true,
    levels: new Map(),
    levelReads: new Map(),
    noteRead: { generation: 0, controller: null },
    noteState: { state: "idle", note: null, message: "" },
    renders: 0,
    navigatorSyncs: 0,
    renderDetail() {
      this.renders += 1;
    },
    syncNavigator() {
      this.navigatorSyncs += 1;
    },
    syncPresentation() {},
    ensureRendered() {},
    info: () => null,
  };
  for (const method of [
    "loadLevel",
    "loadNote",
    "cancelNoteRead",
    "cancelLevelReads",
    "reload",
    "deactivate",
  ]) {
    owner[method] = workspace[method].bind(owner);
  }
  return owner;
}

function recordingApi() {
  const calls = [];
  globalThis.notesApi = {
    getNotes: (directoryId) => {
      calls.push(`level:${directoryId}`);
      return new Promise(() => {});
    },
    getNote: (noteId) => {
      calls.push(`note:${noteId}`);
      return new Promise(() => {});
    },
  };
  return calls;
}

function listing(noteNames) {
  return {
    directories: [],
    notes: noteNames.map((name) => ({ id: name, name, updatedAtMs: 1 })),
  };
}

test("a Note read that another route superseded never replaces the Note shown", async () => {
  const reads = new Map();
  globalThis.notesApi = {
    getNote(noteId, signal) {
      const read = deferred();
      reads.set(noteId, { ...read, signal });
      return read.promise;
    },
  };
  const owner = readingOwner();

  workspace.prepareRoute.call(owner, { kind: "notes", noteId: "first" });
  const first = reads.get("first");
  assert.equal(owner.noteState.state, "loading");
  workspace.prepareRoute.call(owner, { kind: "notes", noteId: "second" });
  assert.equal(first.signal.aborted, true, "the superseded read is cancelled");

  reads.get("second").resolve({ id: "second", name: "Second", content: "two", location: [] });
  await new Promise((resolve) => setImmediate(resolve));
  first.resolve({ id: "first", name: "First", content: "one", location: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(owner.noteState.state, "ready");
  assert.equal(owner.noteState.note.id, "second");
});

test("a level answer arriving after Notes was left is dropped", async () => {
  const read = deferred();
  globalThis.notesApi = { getNotes: () => read.promise };
  const owner = readingOwner();

  const loading = owner.loadLevel("");
  workspace.deactivate.call(owner);
  read.resolve(listing(["Late"]));
  await loading;

  assert.equal(owner.levels.get("").state, "loading");
  assert.equal(owner.levels.get("").listing, null);
});

test("each directory's read keeps its own generation", async () => {
  const reads = [];
  globalThis.notesApi = {
    getNotes(directoryId, signal) {
      const read = deferred();
      reads.push({ directoryId, signal, ...read });
      return read.promise;
    },
  };
  const owner = readingOwner();

  const firstProjects = owner.loadLevel("projects");
  const drafts = owner.loadLevel("drafts");
  const secondProjects = owner.loadLevel("projects");
  assert.equal(reads[0].signal.aborted, true, "reading a directory again cancels its earlier read");
  assert.equal(reads[1].signal.aborted, false, "another directory's read goes on");

  reads[1].resolve(listing(["Draft"]));
  reads[0].resolve(listing(["Stale"]));
  reads[2].resolve(listing(["Current"]));
  await Promise.all([firstProjects, drafts, secondProjects]);

  assert.deepEqual(owner.levels.get("drafts").listing, listing(["Draft"]));
  assert.deepEqual(owner.levels.get("projects").listing, listing(["Current"]));
});

test("a directory that no longer exists is dropped, and a failed read keeps what was shown", async () => {
  const owner = readingOwner();
  owner.levels.set("kept", { state: "ready", listing: listing(["Kept"]), message: "" });
  owner.levels.set("gone", { state: "ready", listing: listing(["Gone"]), message: "" });
  globalThis.notesApi = {
    getNotes: (directoryId) => Promise.reject(
      directoryId === "gone"
        ? Object.assign(new Error("No Note directory has the id `gone`."), { status: 404 })
        : Object.assign(new Error("Request failed with HTTP 500"), { status: 500 }),
    ),
  };

  await owner.loadLevel("gone");
  await owner.loadLevel("kept");

  assert.equal(owner.levels.has("gone"), false);
  assert.deepEqual(owner.levels.get("kept"), {
    state: "failed",
    listing: listing(["Kept"]),
    message: "Request failed with HTTP 500",
  });
});

test("a missing Note and a failed read are told apart, and a failure keeps the Note shown", async () => {
  const owner = readingOwner();
  owner.noteId = "gone";
  globalThis.notesApi = {
    getNote: () => Promise.reject(Object.assign(new Error("No Note has the id `gone`."), { status: 404 })),
  };
  await owner.loadNote("gone");
  assert.equal(owner.noteState.state, "missing");

  owner.noteId = "kept";
  owner.noteState = {
    state: "ready",
    note: { id: "kept", name: "Kept", content: "text", location: [] },
    message: "",
  };
  globalThis.notesApi = {
    getNote: () => Promise.reject(Object.assign(new Error("Request failed with HTTP 500"), { status: 500 })),
  };
  await owner.loadNote("kept");
  assert.equal(owner.noteState.state, "failed");
  assert.equal(owner.noteState.note.id, "kept");
  assert.equal(owner.noteState.message, "Request failed with HTTP 500");
});

test("entering Notes reads the top, every directory already read, and the routed Note once, until Notes is left", () => {
  const calls = recordingApi();
  const owner = readingOwner();
  owner.active = false;
  owner.levels.set("projects", { state: "ready", listing: listing([]), message: "" });

  workspace.prepareRoute.call(owner, { kind: "notes", noteId: "storage" });
  assert.deepEqual(calls, [], "a route alone reads nothing while Notes is hidden");
  workspace.activate.call(owner);
  workspace.activate.call(owner);
  assert.deepEqual(calls, ["level:", "level:projects", "note:storage"]);

  workspace.deactivate.call(owner);
  workspace.activate.call(owner);
  assert.deepEqual(calls, [
    "level:",
    "level:projects",
    "note:storage",
    "level:",
    "level:projects",
    "note:storage",
  ]);
});

test("foreground recovery reads Notes again after a disconnection deactivated it", () => {
  const calls = recordingApi();
  const owner = readingOwner();
  workspace.prepareRoute.call(owner, { kind: "notes", noteId: "storage" });
  workspace.deactivate.call(owner);
  calls.length = 0;

  workspace.reload.call(owner);
  workspace.prepareRoute.call(owner, { kind: "notes", noteId: "inbox" });

  assert.deepEqual(calls, ["level:", "note:storage", "note:inbox"]);
});

test("opening a Note reads the directories that hold it that have not been read", async () => {
  const calls = recordingApi();
  const owner = readingOwner();
  owner.noteId = "storage";
  owner.levels.set("", { state: "ready", listing: listing([]), message: "" });
  owner.levels.set("projects", { state: "ready", listing: listing([]), message: "" });
  globalThis.notesApi.getNote = () => Promise.resolve({
    id: "storage",
    name: "Storage",
    content: "text",
    location: [
      { id: "projects", name: "Projects" },
      { id: "decisions", name: "Decisions" },
    ],
  });

  await owner.loadNote("storage");

  assert.deepEqual(calls, ["level:decisions"]);
});

test("the navigator is told to open the directories that hold the open Note", () => {
  const snapshots = [];
  const owner = {
    noteId: "storage",
    levels: new Map([["", { state: "ready", listing: listing([]), message: "" }]]),
    noteState: {
      state: "ready",
      note: {
        id: "storage",
        location: [
          { id: "projects", name: "Projects" },
          { id: "decisions", name: "Decisions" },
        ],
      },
      message: "",
    },
    connectedNotesNavigator: { setSnapshot: (snapshot) => snapshots.push(snapshot) },
  };

  workspace.syncNavigator.call(owner);
  owner.noteId = "inbox";
  workspace.syncNavigator.call(owner);

  assert.deepEqual(snapshots.map(({ selectedNoteId, reveal }) => ({ selectedNoteId, reveal })), [
    {
      selectedNoteId: "storage",
      reveal: { noteId: "storage", keys: ["directory:projects", "directory:decisions"] },
    },
    { selectedNoteId: "inbox", reveal: { noteId: "inbox", keys: [] } },
  ]);
  assert.notEqual(snapshots[0].levels, owner.levels, "the snapshot is a copy");
});

test("picking the open Note rereads it, another Note asks for its route, and the tree's intents read levels", () => {
  const loads = [];
  const routes = [];
  const owner = {
    noteId: "open",
    loadNote: (noteId) => loads.push(`note:${noteId}`),
    loadLevel: (directoryId) => loads.push(`level:${directoryId}`),
    requestNote: (noteId) => routes.push(noteId),
  };

  workspace.handleNavigatorIntent.call(owner, { type: "open-note", noteId: "open" });
  workspace.handleNavigatorIntent.call(owner, { type: "open-note", noteId: "other" });
  workspace.handleNavigatorIntent.call(owner, { type: "retry" });
  workspace.handleNavigatorIntent.call(owner, { type: "load-directory", directoryId: "projects" });
  workspace.handleNavigatorIntent.call(owner, { type: "load-directory" });
  workspace.handleNavigatorIntent.call(owner, { type: "open-note" });

  assert.deepEqual(loads, ["note:open", "level:", "level:projects"]);
  assert.deepEqual(routes, ["other"]);
});

test("the details owner in the Note header provides the Notes keyboard contexts while Notes is shown", () => {
  const context = { id: "notes:storage:details" };
  const scopeIds = [];
  const owner = {
    hidden: false,
    ensureRendered() {},
    info: () => ({
      keyboardNavigationContexts({ scopeId }) {
        scopeIds.push(scopeId);
        return [context];
      },
    }),
  };

  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), [context]);
  owner.hidden = true;
  assert.deepEqual(workspace.keyboardNavigationContexts.call(owner), []);
  assert.deepEqual(scopeIds, ["notes"]);
});
