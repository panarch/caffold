import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { installCustomElementUnitRegistry } from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./task-fork-dialog.js");
const dialog = registry.element("caffold-task-fork-dialog").prototype;
const { ActionHints } = await import("#app/action-hints.js");
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const { DrawnRef } = await import("#components/drawn-refs.js");

const previousWindow = globalThis.window;
const previousFetch = globalThis.fetch;
afterEach(() => {
  globalThis.window = previousWindow;
  globalThis.fetch = previousFetch;
});
after(() => registry.restore());

const SERVER = { root: "/", homePath: "Users/me" };
const SOURCE = {
  taskId: "source",
  folder: "Users/me/repo",
  worktree: false,
  server: SERVER,
};

// The dialog with the stand-ins a test gives it.
function owner(state = {}) {
  const effects = [];
  const host = Object.create(
    dialog,
    Object.getOwnPropertyDescriptors({
      state: { phase: "closed" },
      generation: 0,
      opener: null,
      created: null,
      isConnected: true,
      requestUpdate() {},
      performUpdate() {},
      dispatched: [],
      dispatchEvent(event) {
        this.dispatched.push(event);
        if (event.type === "caffold:task-created") {
          event.detail.adopted = this.adopts ?? true;
        }
        return true;
      },
      effects,
      field: {
        value: {
          setContext: (context) => effects.push(["field", context]),
          deactivate: () => effects.push(["field", "deactivate"]),
        },
      },
      dialog: {
        value: {
          open: false,
          showModal() {
            this.open = true;
            effects.push(["dialog", "showModal"]);
          },
          close(value) {
            this.open = false;
            effects.push(["dialog", "close", value]);
          },
        },
      },
      ...state,
    }),
  );
  return host;
}

function choosing(folder = SOURCE.folder, source = SOURCE) {
  return { phase: "choosing", source, folder, error: null };
}

function created(threadId = "child") {
  return {
    detail: { threadId, task: { threadId, title: "Fork of Source" } },
    activeTask: { threadId },
    activeTopPlacement: { section: { id: "section-other" } },
  };
}

// The server answers each fork request with the next answer.
function serve(...answers) {
  const requests = [];
  globalThis.window = {
    location: { origin: "http://127.0.0.1" },
    setTimeout,
    clearTimeout,
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url: `${url}`, body: JSON.parse(options.body) });
    const answer = answers.shift();
    return typeof answer === "function" ? answer() : answer;
  };
  return requests;
}

function ok(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function drawn(state) {
  const host = owner({ state });
  host.hints = new ActionHints(host);
  host.keyboard = new KeyboardContexts(host);
  host.dialog = new DrawnRef(host);
  host.field = new DrawnRef(host);
  host.body = new DrawnRef(host);
  return templateHtml(host.render()).replace(/\s+/g, " ");
}

test("opens on the Task's folder with its folder list kept open", () => {
  const host = owner();
  const opener = {};
  dialog.open.call(host, SOURCE, opener);
  assert.deepEqual(host.state, choosing());
  assert.deepEqual(host.effects, [
    ["field", { path: SOURCE.folder, server: SERVER, keepListOpen: true }],
    ["dialog", "showModal"],
  ]);
});

test("the second line says what the new Task will not have", () => {
  assert.match(
    drawn(choosing()),
    /<p>Copies this Task's conversation into a new Task in the folder you choose.<\/p> <p>Files are not copied.<\/p>/,
  );
  assert.match(
    drawn(choosing(SOURCE.folder, { ...SOURCE, worktree: true })),
    /<p>The new Task won't have the changes in this Task's worktree.<\/p>/,
  );
  const forking = drawn({ ...choosing(), phase: "forking" });
  assert.match(forking, /data-task-fork-action="fork" \?disabled="true"[^>]*>Forking…</);
  assert.match(forking, /<caffold-task-directory-field[^>]*\?inert="true"/);
});

test("one transition owner accepts the declared lifecycle and rejects forking from closed", () => {
  const host = owner();
  assert.throws(() =>
    dialog.transition.call(host, { ...choosing(), phase: "forking" }),
  );
  for (const phase of ["choosing", "choosing", "forking", "choosing", "forking", "closed", "choosing", "closed"]) {
    dialog.transition.call(
      host,
      phase === "closed" ? { phase } : { ...choosing(), phase },
    );
    assert.equal(host.state.phase, phase);
  }
  assert.throws(() => dialog.transition.call(host, { phase: "closed" }));
});

test("a chosen folder becomes the fork's folder, and is ignored while forking", () => {
  const event = (path) => ({ stopPropagation() {}, detail: { path } });
  const host = owner({ state: choosing() });
  dialog.folderChosen.call(host, event("Users/me/other"));
  assert.equal(host.state.folder, "Users/me/other");
  assert.deepEqual(host.effects.at(-1), [
    "field",
    { path: "Users/me/other", server: SERVER, keepListOpen: true },
  ]);

  const forking = owner({ state: { ...choosing(), phase: "forking" } });
  dialog.folderChosen.call(forking, event("Users/me/elsewhere"));
  assert.equal(forking.state.folder, SOURCE.folder);
  assert.deepEqual(forking.effects, []);
});

test("forks into the chosen folder and closes once the Task screen opens the child", async () => {
  const requests = serve(ok(created()));
  const host = owner({ state: choosing("Users/me/other"), generation: 1 });
  await dialog.fork.call(host);
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1/api/tasks/source/fork",
      body: { cwd: "Users/me/other" },
    },
  ]);
  assert.equal(host.state.phase, "closed");
  assert.deepEqual(
    host.dispatched.map((event) => event.type),
    ["caffold:task-created"],
  );
  assert.deepEqual(host.dispatched[0].detail.submission, null);
  assert.deepEqual(host.effects.at(-1), ["dialog", "close", "forked"]);
});

test("a child the screen could not open is opened again without forking again", async () => {
  const requests = serve(ok(created()));
  const host = owner({ state: choosing(), generation: 1, adopts: false });
  await dialog.fork.call(host);
  assert.equal(host.state.phase, "choosing");
  assert.match(host.state.error.message, /Retry to open the same Task/);
  assert.equal(host.created.activeTask.threadId, "child");

  host.adopts = true;
  await dialog.fork.call(host);
  assert.equal(requests.length, 1);
  assert.equal(host.state.phase, "closed");
});

test("a child that is not a distinct Task is refused", async () => {
  serve(ok(created("source")));
  const host = owner({ state: choosing(), generation: 1 });
  await dialog.fork.call(host);
  assert.equal(host.state.phase, "choosing");
  assert.match(host.state.error.message, /did not return a distinct forked Task/);
  assert.equal(host.created, null);
});

test("a refusal stays in the dialog and goes to the Task screen to tell if the Task is gone", async () => {
  serve({
    ok: false,
    status: 404,
    json: async () => ({
      error: { code: "task_moved", message: "The Task is gone." },
    }),
  });
  const host = owner({ state: choosing(), generation: 1 });
  await dialog.fork.call(host);
  assert.equal(host.state.phase, "choosing");
  assert.equal(host.state.error.message, "The Task is gone.");
  const failed = host.dispatched.find(
    (event) => event.type === "caffold:task-fork-failed",
  );
  assert.equal(failed.detail.taskId, "source");
  assert.equal(failed.detail.error, host.state.error);
});

test("a fork with no answer says its result is unknown", async () => {
  serve(() => {
    throw new TypeError("Failed to fetch");
  });
  const host = owner({ state: choosing(), generation: 1 });
  await dialog.fork.call(host);
  assert.match(
    host.state.error.message,
    /The fork result is unknown. Check the Task list before retrying.$/,
  );
});

test("deactivation drops a completion that arrives after it", async () => {
  let answer;
  serve(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const host = owner({ state: choosing(), generation: 1 });
  const pending = dialog.fork.call(host);
  assert.equal(host.state.phase, "forking");
  dialog.deactivate.call(host);
  answer(ok(created()));
  await pending;
  assert.equal(host.state.phase, "closed");
  assert.equal(host.created, null);
  assert.deepEqual(host.dispatched, []);
});

test("dismissal waits while the fork runs", () => {
  const host = owner({ state: { ...choosing(), phase: "forking" } });
  let prevented = false;
  dialog.handleCancel.call(host, {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  dialog.cancel.call(host);
  dialog.handleClose.call(host);
  assert.equal(host.state.phase, "forking");
  assert.deepEqual(host.effects, []);
});

test("closing gives focus back to the button that opened it", () => {
  let focused = 0;
  const opener = {
    isConnected: true,
    focus() {
      focused += 1;
    },
  };
  const host = owner({ state: choosing(), opener, generation: 3 });
  dialog.handleClose.call(host);
  assert.equal(host.state.phase, "closed");
  assert.equal(host.generation, 4);
  assert.equal(focused, 1);
  assert.deepEqual(host.effects, [["field", "deactivate"]]);
});
