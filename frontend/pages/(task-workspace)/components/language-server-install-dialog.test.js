import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { languageServerInstallPrompt } = await import(
  "./language-server-install-dialog.js"
);
const Dialog = registry.element("caffold-language-server-install-dialog");
const dialog = Dialog.prototype;
const { ActionHints } = await import("#app/action-hints.js");
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const { ScrollSurfaces } = await import("#app/scroll-scope.js");
after(() => registry.restore());

const RUST = {
  serverName: "rust-analyzer",
  toolchain: "1.94-aarch64-apple-darwin",
  installCommand:
    "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin",
  checkCommand: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version",
};
const TYPESCRIPT = {
  serverName: "typescript-language-server",
  installCommand: "npm install --global typescript-language-server typescript",
  checkCommand: "typescript-language-server --version",
};
const HOME = "Users/me";

test("asks the agent to name the Task, then install and check each server", () => {
  assert.equal(
    languageServerInstallPrompt([RUST]),
    [
      "Install language servers on this host.",
      "",
      '1. Name this Task exactly "Install rust-analyzer".',
      "2. For each server below, run its install command and wait for it to finish, then run its check command and confirm it prints a version.",
      "",
      "   - rust-analyzer for the 1.94-aarch64-apple-darwin toolchain",
      "     Install: `rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin`",
      "     Check: `rustup run 1.94-aarch64-apple-darwin rust-analyzer --version`",
      "",
      "3. Report the result in one or two sentences.",
      "",
      "Do not change anything unrelated to this install.",
    ].join("\n"),
  );
  const both = languageServerInstallPrompt([RUST, TYPESCRIPT]);
  assert.match(both, /Name this Task exactly "Install language servers"\./);
  assert.match(
    both,
    /   - typescript-language-server\n     Install: `npm install --global typescript-language-server typescript`\n     Check: `typescript-language-server --version`/,
  );
});

function dialogHost({ accept = true, completion = Promise.resolve({}) } = {}) {
  const events = [];
  const closes = [];
  const host = {
    pending: false,
    error: null,
    createRequestId: 0,
    servers: [RUST],
    path: HOME,
    turnOptions: {
      value: {
        readyForSubmission: () => true,
        submissionOptions: () => ({
          provider: "codex",
          model: "gpt-6",
          effort: "high",
          speed: "default",
          permissionMode: "auto",
        }),
        resetSpeed() {},
      },
    },
    dialog: { value: { close: (value) => closes.push(value) } },
    updateSetup() {},
    dispatchEvent(event) {
      events.push(event);
      if (accept) {
        event.detail.accepted = true;
        event.detail.completion = completion;
      }
    },
  };
  return { host, events, closes };
}

test("starts the Task in the home folder through whoever creates Tasks and closes once it exists", async () => {
  const { host, events, closes } = dialogHost();

  await dialog.startInstall.call(host);

  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "caffold:task-create-intent");
  assert.equal(event.bubbles, true);
  assert.equal(event.composed, true);
  assert.equal(event.detail.type, "start");
  assert.equal(event.detail.request.cwd, HOME);
  assert.equal(event.detail.request.permissionMode, "auto");
  assert.equal(
    event.detail.request.titleSource,
    languageServerInstallPrompt([RUST]),
  );
  assert.equal(event.detail.submission.prompt, event.detail.request.titleSource);
  assert.match(
    event.detail.submission.submissionId,
    /^language-server-install:\d+:1$/,
  );
  assert.deepEqual(closes, ["started"]);
  assert.equal(host.pending, false);
});

test("stays open with the reason when the Task could not start", async () => {
  const refused = dialogHost({ accept: false });
  await dialog.startInstall.call(refused.host);
  assert.equal(refused.host.error.message, "Another Task is still being created.");
  assert.deepEqual(refused.closes, []);

  const failed = dialogHost({ completion: Promise.reject(new Error("offline")) });
  await dialog.startInstall.call(failed.host);
  assert.equal(failed.host.error.message, "offline");
  assert.equal(failed.host.pending, false);
  assert.deepEqual(failed.closes, []);
});

test("ignores a start whose dialog was opened again meanwhile", async () => {
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const { host, closes } = dialogHost({ completion });
  const started = dialog.startInstall.call(host);
  host.createRequestId += 1;
  finish({});
  await started;
  assert.deepEqual(closes, []);
});

test("never starts without a home folder", async () => {
  const { host, events } = dialogHost();
  host.path = null;
  await dialog.startInstall.call(host);
  assert.deepEqual(events, []);
});

function drawnDialog(servers, { path = HOME, error = null } = {}) {
  const owner = Object.create(
    Dialog.prototype,
    Object.getOwnPropertyDescriptors({
      servers,
      path,
      choosing: true,
      ready: true,
      pending: false,
      error,
    }),
  );
  owner.hints = new ActionHints(owner);
  owner.surfaces = new ScrollSurfaces(owner);
  owner.keyboard = new KeyboardContexts(owner);
  return templateHtml(owner.render()).replace(/\s+/g, " ");
}

test("names the server, where it goes and its command, with the agent pickers and two buttons", () => {
  const drawn = drawnDialog([RUST]);

  assert.match(
    drawn,
    /<h2 id="language-server-install-title">Install rust-analyzer<\/h2>/,
  );
  assert.match(
    drawn,
    /An agent installs rust-analyzer in a new Task in your home folder, then checks that it runs\./,
  );
  assert.match(
    drawn,
    /<li> <span>rust-analyzer for the 1\.94-aarch64-apple-darwin toolchain<\/span> <code>rustup component add rust-analyzer rust-src --toolchain 1\.94-aarch64-apple-darwin<\/code> <\/li>/,
  );
  assert.match(drawn, /<caffold-task-turn-options @caffold:task-turn-options-change="" >/);
  assert.doesNotMatch(drawn, /Full access|Allow all/);
  assert.match(drawn, /\?disabled="false" @click="" >Cancel</);
  assert.match(drawn, /\?disabled="false" >Start Install</);
  assert.equal(
    [...drawn.matchAll(/<caffold-keyboard-navigation-presentation/g)].length,
    1,
  );
});

test("lists every server when several are missing", () => {
  const drawn = drawnDialog([RUST, TYPESCRIPT]);

  assert.match(
    drawn,
    /<h2 id="language-server-install-title">Install language servers<\/h2>/,
  );
  assert.match(
    drawn,
    /An agent installs these in a new Task in your home folder, then checks that each runs\./,
  );
  assert.equal([...drawn.matchAll(/<li>/g)].length, 2);
  assert.match(
    drawn,
    /<span>typescript-language-server<\/span> <code>npm install --global typescript-language-server typescript<\/code>/,
  );
});

test("cannot start without a home folder", () => {
  const drawn = drawnDialog([RUST], {
    path: null,
    error: new Error("Caffold serves no home folder, so it has nowhere to start the install."),
  });

  assert.match(drawn, /<p role="alert">Caffold serves no home folder, so it has nowhere to start the install\.<\/p>/);
  assert.match(drawn, /\?disabled="true" >Start Install</);
});
