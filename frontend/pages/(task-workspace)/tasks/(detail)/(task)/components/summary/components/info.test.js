import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { taskInfoSnapshot } = await import("./info.js");
const info = registry.element("caffold-task-detail-info").prototype;
const actions = registry.element(
  "caffold-task-detail-info-actions",
).prototype;
const { ActionHints } = await import("#app/action-hints.js");
after(() => registry.restore());

// One of the components with the state and stand-ins a test gives it, drawn
// by nothing until the test asks.
function owner(prototype, state) {
  return Object.create(prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    performUpdate() {},
    ...state,
  }));
}

function drawnActions(snapshot, languageServers = {}) {
  const host = owner(actions, {
    snapshot: taskInfoSnapshot(snapshot),
    languageServers: {
      repository: null,
      fresh: false,
      turning: null,
      error: null,
      ...languageServers,
    },
  });
  host.hints = new ActionHints(host);
  const markup = templateHtml(host.render()).replace(/\s+/g, " ");
  const button = (type) =>
    markup.match(new RegExp(`data-task-info-action="${type}"[^>]*>`))?.[0] ?? "";
  return {
    markup,
    disabled: (type) => button(type).includes('?disabled="true"'),
  };
}

test("hides what a Task's prompts settled outside the reviewed mode", () => {
  const task = { threadId: "thread-a", threadStatus: { type: "idle" } };
  const hidden = (permissionMode) =>
    /data-task-info-permission-instructions \?hidden="true"/.test(
      drawnActions({ task, permissionMode }).markup,
    );

  assert.equal(hidden("approveForMe"), true);
  assert.equal(hidden("caffold:ask-jev-first"), false);
});

test("keeps Archive available through stale transport unless canonical status is active", () => {
  const task = {
    threadId: "thread-a",
    threadStatus: { type: "active", activeFlags: [] },
  };

  assert.equal(
    drawnActions({ task, transportState: "unavailable" }).disabled("archive"),
    false,
  );
  assert.equal(
    drawnActions({
      task,
      transportState: "unavailable",
      archiveBlockedByActive: true,
    }).disabled("archive"),
    true,
  );
});

test("keeps Fork unavailable without canonical Detail", () => {
  const drawn = drawnActions({
    task: { threadId: "thread-a", threadStatus: { type: "idle" } },
    canonicalTaskAvailable: false,
    transportState: "ready",
    provider: "codex",
  });

  assert.equal(drawn.disabled("fork"), true);
  assert.match(
    drawn.markup,
    /task-detail-fork-availability" \?hidden="false" >Fork is unavailable until Task details load\.</,
  );
});

test("offers Pin or Unpin only for a Task the list has placed", () => {
  const task = { threadId: "thread-a", threadStatus: { type: "idle" } };
  const pinBlock = (snapshot) =>
    drawnActions({ task, ...snapshot }).markup.match(
      /task-detail-pin-action"[^>]*\?hidden="(true|false)" > <p>([^<]*)<\/p>.*?data-task-info-action="(pin|unpin)"[^>]*>.*?<span>([^<]*)<\/span> ?<\/button>/,
    )?.slice(1);

  assert.equal(pinBlock({ pinned: null })[0], "true");
  assert.deepEqual(pinBlock({ pinned: false }), [
    "false",
    "Pinned Tasks stay at the top of the Task list and the Task Switcher.",
    "pin",
    "Pin task",
  ]);
  assert.deepEqual(pinBlock({ pinned: true }), [
    "false",
    "This Task is pinned. Unpinning returns it to the top of its Section.",
    "unpin",
    "Unpin task",
  ]);
  assert.equal(
    pinBlock({ pinned: false, pinState: { loading: true, error: null } })[3],
    "Pinning...",
  );
  assert.equal(
    drawnActions({
      task,
      pinned: true,
      pinState: { loading: true, error: null },
    }).disabled("unpin"),
    true,
  );
  assert.match(
    drawnActions({
      task,
      pinned: false,
      pinState: { loading: false, error: new Error("Pin failed.") },
    }).markup,
    /task-detail-pin-error" role="alert" \?hidden="false" >Pin failed\.</,
  );
});

function server(language, state, fields = {}) {
  return {
    repositoryPath: "repo",
    language,
    languageName: language === "rust" ? "Rust" : "TypeScript/JavaScript",
    serverName:
      language === "rust" ? "rust-analyzer" : "typescript-language-server",
    state,
    ...fields,
  };
}

// The Language servers section's paragraphs and its buttons' labels, with
// whether each button is disabled.
function languageServersBlock(languageServers) {
  const task = { threadId: "thread-a", threadStatus: { type: "idle" } };
  const markup = drawnActions({ task, pinned: false }, languageServers).markup;
  const block = markup.match(
    /task-detail-language-servers-action" \?hidden="(true|false)" >(.*?)<p class="task-detail-action-error/,
  );
  return {
    hidden: block[1] === "true",
    paragraphs: [...block[2].matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map(
      ([, text]) => text,
    ),
    buttons: [
      ...block[2].matchAll(
        /data-task-info-action="([a-z-]+)"[^>]*?(?:\?disabled="(true|false)"[^>]*)?>.*?<span>([^<]*)<\/span> ?<\/button>/g,
      ),
    ].map(([, action, disabled, label]) => [action, label, disabled === "true"]),
    markup,
  };
}

const ABOUT =
  "Language servers answer Go to definition and Find references in this repository's code.";

test("leaves the Language servers section out until the repository lists a server", () => {
  assert.equal(languageServersBlock({}).hidden, true);
  assert.equal(
    languageServersBlock({
      repository: { path: "repo", enabled: false, servers: [] },
      fresh: true,
    }).hidden,
    true,
  );
});

test("offers to turn a repository's language servers on, and says nothing more while off", () => {
  const block = languageServersBlock({
    repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
    fresh: true,
  });
  assert.equal(block.hidden, false);
  assert.deepEqual(block.paragraphs, [ABOUT]);
  assert.deepEqual(block.buttons, [
    ["turn-on-language-servers", "Turn on language servers", false],
  ]);
  assert.match(block.markup, /task-detail-pin-action.*task-detail-language-servers-action.*task-detail-fork-action/);
});

test("tells each language's state while on, with progress and memory when known", () => {
  const block = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [
        server("rust", "ready", { memoryBytes: 3_006_477_107 }),
        server("typescript", "sleeping"),
      ],
    },
    fresh: true,
  });
  assert.deepEqual(block.paragraphs, [
    ABOUT,
    "Rust: ready · rust-analyzer · 2.8 GB",
    "TypeScript/JavaScript: sleeping",
  ]);
  assert.deepEqual(block.buttons, [
    ["turn-off-language-servers", "Turn off language servers", false],
  ]);
  assert.deepEqual(
    languageServersBlock({
      repository: {
        path: "repo",
        enabled: true,
        servers: [server("rust", "ready", { memoryBytes: 671_088_640 })],
      },
      fresh: true,
    }).paragraphs[1],
    "Rust: ready · rust-analyzer · 640 MB",
  );
  assert.deepEqual(
    languageServersBlock({
      repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
      fresh: true,
    }).paragraphs[1],
    "Rust: ready · rust-analyzer",
  );
});

test("holds the button busy while a server gets ready or the switch turns", () => {
  const starting = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [server("rust", "starting", { progress: "Indexing 402/407 (caffold)" })],
    },
    fresh: true,
  });
  assert.deepEqual(starting.paragraphs, [
    ABOUT,
    "Rust: getting ready · Indexing 402/407 (caffold)",
  ]);
  assert.deepEqual(starting.buttons, [
    ["turn-off-language-servers", "Starting language servers...", true],
  ]);
  assert.match(starting.markup, /task-detail-action-icon is-busy/);

  const turningOn = languageServersBlock({
    repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
    fresh: true,
    turning: "on",
  });
  assert.deepEqual(turningOn.buttons, [
    ["turn-on-language-servers", "Starting language servers...", true],
  ]);
  const turningOff = languageServersBlock({
    repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
    fresh: true,
    turning: "off",
  });
  assert.deepEqual(turningOff.buttons, [
    ["turn-off-language-servers", "Turning off language servers...", true],
  ]);
});

const RUST_NOT_INSTALLED = {
  kind: "notInstalled",
  toolchain: "1.94-aarch64-apple-darwin",
  installCommand:
    "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin",
  checkCommand: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version",
};
const TYPESCRIPT_NOT_INSTALLED = {
  kind: "notInstalled",
  installCommand: "npm install --global typescript-language-server typescript",
  checkCommand: "typescript-language-server --version",
};

test("says which check failed for each language, with what a server that could not start printed, and offers one install", () => {
  const block = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [
        server("rust", "failed", { failure: RUST_NOT_INSTALLED }),
        server("typescript", "failed", { failure: { kind: "stopped" } }),
      ],
    },
    fresh: true,
  });
  assert.deepEqual(block.paragraphs, [
    ABOUT,
    "Rust: rust-analyzer is not installed for the 1.94-aarch64-apple-darwin toolchain.",
    "TypeScript/JavaScript: typescript-language-server stopped.",
  ]);
  assert.deepEqual(block.buttons, [
    ["install-language-servers", "Ask an agent to install rust-analyzer", false],
    ["turn-off-language-servers", "Turn off language servers", false],
  ]);

  const couldNotStart = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [
        server("rust", "failed", {
          failure: { kind: "couldNotStart", reason: "could not load the sysroot" },
        }),
      ],
    },
    fresh: true,
  });
  assert.deepEqual(couldNotStart.paragraphs, [
    ABOUT,
    "Rust: rust-analyzer could not start.",
    "could not load the sysroot",
  ]);
  assert.deepEqual(couldNotStart.buttons, [
    ["turn-off-language-servers", "Turn off language servers", false],
  ]);
});

test("one install button covers every server that is not installed", () => {
  const block = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [
        server("rust", "failed", { failure: RUST_NOT_INSTALLED }),
        server("typescript", "failed", { failure: TYPESCRIPT_NOT_INSTALLED }),
      ],
    },
    fresh: true,
  });
  assert.deepEqual(block.paragraphs, [
    ABOUT,
    "Rust: rust-analyzer is not installed for the 1.94-aarch64-apple-darwin toolchain.",
    "TypeScript/JavaScript: typescript-language-server is not installed.",
  ]);
  assert.deepEqual(block.buttons, [
    ["install-language-servers", "Ask an agent to install 2 servers", false],
    ["turn-off-language-servers", "Turn off language servers", false],
  ]);
});

test("shows only the reason, and no choice, while the last answer could not be read again", () => {
  const block = languageServersBlock({
    repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
    fresh: false,
    error: new Error("The server did not answer."),
  });
  assert.deepEqual(block.paragraphs, [ABOUT]);
  assert.deepEqual(block.buttons, [
    ["turn-off-language-servers", "Turn off language servers", true],
  ]);
  assert.match(
    block.markup,
    /task-detail-language-servers-error" role="alert" \?hidden="false" >The server did not answer\.</,
  );
});

test("asks for every missing server's install and returns focus to the details button", () => {
  const events = [];
  const detailsButton = {};
  const host = owner(actions, {
    languageServers: {
      repository: {
        path: "Users/me/repo",
        enabled: true,
        servers: [
          server("rust", "failed", { failure: RUST_NOT_INSTALLED }),
          server("typescript", "ready"),
        ],
      },
      fresh: true,
      turning: null,
      error: null,
    },
    detailsButton,
    dispatchEvent: (event) => events.push(event),
  });
  actions.requestLanguageServerInstall.call(host);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:language-server-install-intent");
  assert.equal(events[0].bubbles, true);
  assert.equal(events[0].composed, true);
  assert.deepEqual(events[0].detail, {
    servers: [
      {
        serverName: "rust-analyzer",
        toolchain: "1.94-aarch64-apple-darwin",
        installCommand: RUST_NOT_INSTALLED.installCommand,
        checkCommand: RUST_NOT_INSTALLED.checkCommand,
      },
    ],
    opener: detailsButton,
  });

  host.languageServers.repository.servers[1] = server("typescript", "failed", {
    failure: TYPESCRIPT_NOT_INSTALLED,
  });
  actions.requestLanguageServerInstall.call(host);
  assert.deepEqual(events[1].detail.servers[1], {
    serverName: "typescript-language-server",
    installCommand: TYPESCRIPT_NOT_INSTALLED.installCommand,
    checkCommand: TYPESCRIPT_NOT_INSTALLED.checkCommand,
  });
});

test("reads the language servers of the open Task's worktree while the popover is open, and once ahead while it is closed", () => {
  const calls = [];
  const host = owner(actions, {
    snapshot: taskInfoSnapshot({
      task: {
        threadId: "thread-a",
        cwdPath: "Users/me/repo/src",
        worktree: { rootPath: "Users/me/repo" },
      },
      canonicalTaskAvailable: true,
    }),
    isConnected: true,
    languageServersLifecycle: {
      show: (path) => calls.push(["show", path]),
      hide: () => calls.push(["hide"]),
      stop: () => calls.push(["stop"]),
      preload: (path) => calls.push(["preload", path]),
    },
  });
  actions.setPopoverOpen.call(host, true, null);
  actions.setPopoverOpen.call(host, false, null);
  host.snapshot = taskInfoSnapshot({
    task: { threadId: "thread-a", cwdPath: "Users/me/plain", worktree: null },
    canonicalTaskAvailable: true,
  });
  actions.setPopoverOpen.call(host, true, null);
  host.snapshot = taskInfoSnapshot({
    task: { threadId: "thread-a", cwdPath: null, worktree: null },
    canonicalTaskAvailable: true,
  });
  actions.setPopoverOpen.call(host, true, null);
  host.snapshot = taskInfoSnapshot({
    task: { threadId: "thread-a", cwdPath: "Users/me/plain" },
    canonicalTaskAvailable: false,
  });
  actions.setPopoverOpen.call(host, true, null);
  assert.deepEqual(calls, [
    ["show", "Users/me/repo"],
    ["hide"],
    ["preload", "Users/me/repo"],
    ["show", "Users/me/plain"],
    ["stop"],
    ["stop"],
  ]);
});

test("closes the Task details popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const infoOwner = owner(info, { infoPopover: { value: popover } });
  info.handleDismiss.call(infoOwner, { target: {} });
  assert.equal(hidden, 0);
  info.handleDismiss.call(infoOwner, { target: popover });
  assert.equal(hidden, 1);
});

test("tells its actions when its own popover opens and closes", () => {
  const calls = [];
  const popover = {};
  const button = {};
  const infoOwner = owner(info, {
    infoPopover: { value: popover },
    infoButton: { value: button },
    actions: {
      value: {
        setPopoverOpen: (open, detailsButton) => calls.push([open, detailsButton]),
      },
    },
  });
  const toggle = (target, newState) =>
    info.handleBeforeToggle.call(infoOwner, {
      target,
      currentTarget: null,
      newState,
    });
  toggle({}, "open");
  toggle(popover, "open");
  toggle(popover, "closed");
  assert.deepEqual(calls, [
    [true, button],
    [false, button],
  ]);
});
