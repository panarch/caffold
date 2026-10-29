import assert from "node:assert/strict";
import test from "node:test";

import {
  DIRECTORY_FIELD_NODE,
  directoryFieldRows,
  initialDirectoryFieldState,
  reduceDirectoryField,
} from "./control.js";

const SERVER = { root: "/", homePath: "Users/me" };
const HOME = "Users/me";
const RUST = "Users/me/Workspace/rust";

function directory(path, names) {
  return {
    path,
    entries: names.map((name) => ({
      name,
      path: [path, name].filter(Boolean).join("/"),
      kind: name.endsWith(".txt") ? "file" : "directory",
    })),
  };
}

function run(state, ...events) {
  let current = state;
  const effects = [];
  for (const event of events) {
    const result = reduceDirectoryField(current, event);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

function closedAt(path) {
  return run(initialDirectoryFieldState(), {
    type: "context",
    path,
    server: SERVER,
    locked: false,
  }).state;
}

function lastRequest(effects) {
  return effects.filter((effect) => effect.type === "request").at(-1);
}

function browsingAt(path, names) {
  const opened = run(closedAt(path), { type: "toggle-list" });
  return run(opened.state, {
    type: "listing-loaded",
    generation: lastRequest(opened.effects).generation,
    directory: directory(path, names),
  }).state;
}

function editingAt(path, names) {
  const opened = run(closedAt(path), { type: "toggle-edit" });
  return run(opened.state, {
    type: "listing-loaded",
    generation: lastRequest(opened.effects).generation,
    directory: directory(path, names),
  }).state;
}

test("closed opens to browsing or editing and asks for the chosen folder", () => {
  const browsing = run(closedAt(HOME), { type: "toggle-list" });
  assert.equal(browsing.state.node, DIRECTORY_FIELD_NODE.BROWSING);
  assert.deepEqual(browsing.effects, [
    { type: "request", generation: 1, path: HOME },
  ]);

  const editing = run(closedAt(HOME), { type: "toggle-edit" });
  assert.equal(editing.state.node, DIRECTORY_FIELD_NODE.EDITING);
  assert.equal(editing.state.text, "~/");
  assert.deepEqual(editing.effects, [
    { type: "focus", target: "input" },
    { type: "request", generation: 1, path: HOME },
  ]);
});

test("closed ignores everything but opening and context", () => {
  const state = closedAt(HOME);
  for (const type of [
    "escape",
    "leave",
    "choose-row",
    "type",
    "complete",
    "move-highlight",
    "submit",
    "listing-loaded",
    "listing-failed",
    "deactivate",
  ]) {
    assert.deepEqual(reduceDirectoryField(state, { type, generation: 0 }), {
      state,
      effects: [],
    }, type);
  }
});

test("a locked field does not open", () => {
  const locked = run(closedAt(HOME), {
    type: "context",
    path: HOME,
    server: SERVER,
    locked: true,
  }).state;
  assert.equal(run(locked, { type: "toggle-list" }).state.node, "closed");
  assert.equal(run(locked, { type: "toggle-edit" }).state.node, "closed");
});

test("browsing shows the listed folders with the parent first and hidden folders last", () => {
  const state = browsingAt(HOME, [".cache", "Workspace", "notes.txt", "Applications"]);
  assert.deepEqual(directoryFieldRows(state).map((row) => row.name), [
    "..",
    "Applications",
    "Workspace",
    ".cache",
  ]);
  assert.deepEqual(directoryFieldRows(browsingAt("", ["Users"])).map((row) => row.name), [
    "Users",
  ]);
});

test("browsing ignores the keys that only typing uses", () => {
  const state = browsingAt(HOME, ["Workspace"]);
  for (const event of [
    { type: "type", text: "~/Wor" },
    { type: "complete" },
    { type: "move-highlight", delta: 1 },
    { type: "submit" },
  ]) {
    assert.deepEqual(reduceDirectoryField(state, event), { state, effects: [] }, event.type);
  }
});

test("browsing closes on toggle, Escape, leaving, and deactivation", () => {
  for (const type of ["toggle-list", "escape", "leave", "deactivate"]) {
    const state = run(browsingAt(HOME, ["Workspace"]), { type }).state;
    assert.equal(state.node, "closed", type);
    assert.equal(state.request, null, type);
  }
});

test("choosing a row in browsing chooses it once its folder is listed", () => {
  const browsing = browsingAt(HOME, ["Workspace"]);
  const asked = run(browsing, { type: "choose-row", path: `${HOME}/Workspace` });
  assert.equal(asked.state.node, "browsing");
  assert.equal(asked.state.path, HOME);
  const request = lastRequest(asked.effects);
  assert.equal(request.path, `${HOME}/Workspace`);

  const chosen = run(asked.state, {
    type: "listing-loaded",
    generation: request.generation,
    directory: directory(`${HOME}/Workspace`, ["rust"]),
  });
  assert.equal(chosen.state.node, "browsing");
  assert.equal(chosen.state.path, `${HOME}/Workspace`);
  assert.deepEqual(chosen.effects, [
    { type: "choose", path: `${HOME}/Workspace`, returnFocus: false },
  ]);
});

test("a folder that cannot be listed keeps the chosen directory and its rows", () => {
  const browsing = browsingAt(HOME, ["Library"]);
  const asked = run(browsing, { type: "choose-row", path: `${HOME}/Library` });
  const failed = run(asked.state, {
    type: "listing-failed",
    generation: lastRequest(asked.effects).generation,
    message: "permission denied",
  }).state;
  assert.equal(failed.path, HOME);
  assert.equal(failed.error, "permission denied");
  assert.deepEqual(directoryFieldRows(failed).map((row) => row.name), ["..", "Library"]);
});

test("only the answer to the request in flight counts", () => {
  const browsing = browsingAt(HOME, ["a", "b"]);
  const first = run(browsing, { type: "choose-row", path: `${HOME}/a` });
  const second = run(first.state, { type: "choose-row", path: `${HOME}/b` });
  const stale = run(second.state, {
    type: "listing-loaded",
    generation: lastRequest(first.effects).generation,
    directory: directory(`${HOME}/a`, []),
  });
  assert.equal(stale.state, second.state);
  assert.deepEqual(stale.effects, []);

  const closed = run(second.state, { type: "escape" }).state;
  const late = run(closed, {
    type: "listing-loaded",
    generation: lastRequest(second.effects).generation,
    directory: directory(`${HOME}/b`, []),
  });
  assert.equal(late.state, closed);
});

test("browsing enters editing from the chosen folder's text", () => {
  const editing = run(browsingAt(RUST, ["codger"]), { type: "toggle-edit" });
  assert.equal(editing.state.node, "editing");
  assert.equal(editing.state.text, "~/Workspace/rust/");
  assert.deepEqual(editing.effects, [{ type: "focus", target: "input" }]);
});

test("typing filters the listed folder and highlights the first match", () => {
  const editing = editingAt(RUST, ["gleam", "codger", "glues"]);
  const typed = run(editing, { type: "type", text: "~/Workspace/rust/GL" });
  assert.deepEqual(typed.effects, []);
  assert.deepEqual(directoryFieldRows(typed.state).map((row) => row.name), ["gleam", "glues"]);
  assert.equal(typed.state.highlight, `${RUST}/gleam`);

  const cleared = run(typed.state, { type: "type", text: "~/Workspace/rust/" }).state;
  assert.equal(cleared.highlight, "");
  assert.equal(directoryFieldRows(cleared)[0].name, "..");
});

test("typing another folder asks for it once and highlights when it arrives", () => {
  const editing = editingAt(HOME, ["Workspace"]);
  const moved = run(
    editing,
    { type: "type", text: "~/Workspace/rust/" },
    { type: "type", text: "~/Workspace/rust/g" },
  );
  assert.equal(moved.effects.filter((effect) => effect.type === "request").length, 1);
  assert.deepEqual(directoryFieldRows(moved.state), []);
  const loaded = run(moved.state, {
    type: "listing-loaded",
    generation: lastRequest(moved.effects).generation,
    directory: directory(RUST, ["codger", "gleam"]),
  }).state;
  assert.equal(loaded.node, "editing");
  assert.equal(loaded.path, HOME);
  assert.equal(loaded.highlight, `${RUST}/gleam`);
});

test("typed text that cannot be read shows why and asks nothing", () => {
  const typed = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "Workspace" });
  assert.equal(typed.state.error, "Start the path with / or ~.");
  assert.deepEqual(typed.effects, []);
  assert.deepEqual(directoryFieldRows(typed.state), []);
  const submitted = run(typed.state, { type: "submit" });
  assert.equal(submitted.state.node, "editing");
  assert.deepEqual(submitted.effects, []);
});

test("a typed folder that cannot be listed shows no rows", () => {
  const moved = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "~/missing/" });
  const failed = run(moved.state, {
    type: "listing-failed",
    generation: lastRequest(moved.effects).generation,
    message: "not found",
  }).state;
  assert.equal(failed.node, "editing");
  assert.equal(failed.error, "not found");
  assert.deepEqual(directoryFieldRows(failed), []);
});

test("arrows move the highlight within the rows", () => {
  const editing = editingAt(RUST, ["codger", "gleam"]);
  const down = run(editing, { type: "move-highlight", delta: 1 }).state;
  assert.equal(down.highlight, "..");
  const further = run(
    down,
    { type: "move-highlight", delta: 1 },
    { type: "move-highlight", delta: 1 },
    { type: "move-highlight", delta: 1 },
  ).state;
  assert.equal(further.highlight, `${RUST}/gleam`);
  const up = run(further, { type: "move-highlight", delta: -1 }).state;
  assert.equal(up.highlight, `${RUST}/codger`);
});

test("Tab fills the highlighted name and lists inside it without choosing", () => {
  const typed = run(editingAt(RUST, ["gleam", "glues"]), { type: "type", text: "~/Workspace/rust/glu" });
  const completed = run(typed.state, { type: "complete" });
  assert.equal(completed.state.text, "~/Workspace/rust/glues/");
  assert.equal(completed.state.path, RUST);
  assert.equal(lastRequest(completed.effects).path, `${RUST}/glues`);

  const parent = run(editingAt(RUST, ["gleam"]), { type: "move-highlight", delta: 1 }, {
    type: "complete",
  });
  assert.equal(parent.state.text, "~/Workspace/");

  const belowRoot = run(editingAt("Users", ["me"]), { type: "move-highlight", delta: 1 });
  assert.equal(belowRoot.state.highlight, "..");
  const toRoot = run(belowRoot.state, { type: "submit" });
  assert.equal(lastRequest(toRoot.effects).path, "");

  const nothing = run(editingAt(RUST, ["gleam"]), { type: "complete" });
  assert.deepEqual(nothing.effects, []);
});

test("Enter chooses the highlighted row or the typed path and closes once listed", () => {
  const typed = run(editingAt(RUST, ["gleam", "glues"]), { type: "type", text: "~/Workspace/rust/glu" });
  const submitted = run(typed.state, { type: "submit" });
  assert.equal(lastRequest(submitted.effects).path, `${RUST}/glues`);
  const chosen = run(submitted.state, {
    type: "listing-loaded",
    generation: lastRequest(submitted.effects).generation,
    directory: directory(`${RUST}/glues`, []),
  });
  assert.equal(chosen.state.node, "closed");
  assert.equal(chosen.state.path, `${RUST}/glues`);
  assert.equal(chosen.state.text, "");
  assert.deepEqual(chosen.effects, [
    { type: "choose", path: `${RUST}/glues`, returnFocus: true },
  ]);

  const pasted = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "/private/tmp" }, {
    type: "submit",
  });
  assert.equal(lastRequest(pasted.effects).path, "private/tmp");
});

test("Enter on a path that cannot be listed stays editing with the reason", () => {
  const submitted = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "~/nowhere" }, {
    type: "submit",
  });
  const failed = run(submitted.state, {
    type: "listing-failed",
    generation: lastRequest(submitted.effects).generation,
    message: "not found",
  }).state;
  assert.equal(failed.node, "editing");
  assert.equal(failed.path, HOME);
  assert.equal(failed.error, "not found");
});

test("editing returns to browsing on Escape and both toggles, dropping the typed text", () => {
  for (const type of ["escape", "toggle-edit", "toggle-list"]) {
    const typed = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "~/Wor" }).state;
    const back = run(typed, { type });
    assert.equal(back.state.node, "browsing", type);
    assert.equal(back.state.text, "", type);
    assert.equal(back.state.highlight, "", type);
    assert.deepEqual(back.effects, [{ type: "focus", target: "toggle" }], type);
  }

  const pending = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "~/Workspace/" });
  assert.deepEqual(run(pending.state, { type: "escape" }).effects, [
    { type: "focus", target: "toggle" },
  ]);

  const elsewhere = run(pending.state, {
    type: "listing-loaded",
    generation: lastRequest(pending.effects).generation,
    directory: directory(`${HOME}/Workspace`, ["rust"]),
  });
  const back = run(elsewhere.state, { type: "escape" });
  assert.equal(lastRequest(back.effects).path, HOME);
});

test("editing chooses a clicked row as browsing does", () => {
  const editing = editingAt(HOME, ["Workspace"]);
  const clicked = run(editing, { type: "choose-row", path: `${HOME}/Workspace` });
  assert.equal(clicked.state.node, "browsing");
  assert.equal(clicked.state.text, "");
  assert.equal(lastRequest(clicked.effects).path, `${HOME}/Workspace`);
});

test("editing closes on leaving and deactivation without choosing", () => {
  for (const type of ["leave", "deactivate"]) {
    const typed = run(editingAt(HOME, ["Workspace"]), { type: "type", text: "~/Wor" }).state;
    const left = run(typed, { type });
    assert.equal(left.state.node, "closed", type);
    assert.equal(left.state.path, HOME, type);
    assert.equal(left.state.text, "", type);
    assert.deepEqual(left.effects, [], type);
  }
});

test("the field closes when the directory changes from outside or it is locked", () => {
  for (const state of [browsingAt(HOME, ["a"]), editingAt(HOME, ["a"])]) {
    const moved = run(state, { type: "context", path: RUST, server: SERVER, locked: false }).state;
    assert.equal(moved.node, "closed");
    assert.equal(moved.path, RUST);
    const locked = run(state, { type: "context", path: HOME, server: SERVER, locked: true }).state;
    assert.equal(locked.node, "closed");
  }
});

test("the field's own choice handed back is not a change of context", () => {
  const asked = run(browsingAt(HOME, ["Workspace"]), {
    type: "choose-row",
    path: `${HOME}/Workspace`,
  });
  const chosen = run(asked.state, {
    type: "listing-loaded",
    generation: lastRequest(asked.effects).generation,
    directory: directory(`${HOME}/Workspace`, []),
  }).state;
  const echoed = run(chosen, {
    type: "context",
    path: `${HOME}/Workspace`,
    server: SERVER,
    locked: false,
  });
  assert.equal(echoed.state.node, "browsing");
  assert.deepEqual(echoed.effects, []);
});
