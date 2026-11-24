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
const { KeyboardContexts } = await import("#app/keyboard-navigation.js");
const { DrawnRef, DrawnRefs } = await import("#components/drawn-refs.js");
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

const IDLE = { type: "idle" };

// The popover's head and meta lines as Task Info draws them.
function drawnInfo(snapshot, state = {}) {
  const host = owner(info, {
    snapshot: taskInfoSnapshot(snapshot),
    pathsOpen: false,
    ...state,
  });
  host.hints = new ActionHints(host);
  host.keyboard = new KeyboardContexts(host);
  host.infoButton = new DrawnRef(host);
  host.infoPopover = new DrawnRef(host);
  host.actions = new DrawnRef(host);
  host.copies = new DrawnRefs(host);
  const markup = templateHtml(host.render()).replace(/\s+/g, " ");
  const field = (name) =>
    markup.match(
      new RegExp(`data-task-info-field="${name}"[^>]*>([^<]*)<`),
    )?.[1] ?? null;
  const location = markup.match(
    /class="task-detail-location-parts">(.*?)<\/span> <span class="task-detail-location-chevron"/,
  )?.[1];
  return {
    markup,
    field,
    location: location
      ? [...location.matchAll(/<span>([^<]*)<\/span>|>(worktree)</g)].map(
          ([, part, worktree]) => part ?? worktree,
        )
      : null,
    paths: [
      ...markup.matchAll(
        /data-task-info-path="([a-z-]+)" > <span class="task-detail-path-name">([^<]*)<\/span> <span class="task-detail-path-value">(.*?)<\/span>/g,
      ),
    ].map(([, name, label, path]) => [name, label, path.replaceAll("<wbr>", "")]),
    pathsHidden: /class="task-detail-paths" \?hidden="true"/.test(markup),
  };
}

function canonical(fields = {}) {
  return {
    threadId: "62f05222-da19-4b65-ae32-fe14543574b7",
    title: "Write the work log",
    threadStatus: IDLE,
    cwd: "/Users/me/Workspace/rust/codger",
    cwdPath: "Users/me/Workspace/rust/codger",
    relativeCwd: "",
    worktree: {
      rootPath: "Users/me/Workspace/rust/codger",
      repositoryRootPath: "Users/me/Workspace/rust/codger",
      branch: "main",
      headSha: "1fb17151a4c0ffee",
      relativeCwd: "",
      linked: false,
    },
    ...fields,
  };
}

const HOME = { root: "/", homePath: "Users/me" };
const WORKTREE = "Users/me/Library/Application Support/Caffold/data/worktrees/1737fabc";

test("heads the popover with the Task's title and status, and shows its whole Task ID", () => {
  const drawn = drawnInfo({
    task: canonical(),
    canonicalTaskAvailable: true,
    serverPaths: HOME,
  });
  assert.equal(drawn.field("title"), "Write the work log");
  assert.equal(drawn.field("status"), "idle");
  assert.equal(drawn.field("thread"), "62f05222-da19-4b65-ae32-fe14543574b7");
  assert.equal(drawn.field("claude-config-dir"), null);
  assert.match(
    drawnInfo({
      task: canonical({ claudeConfigDir: "/Users/me/.claude-work" }),
      canonicalTaskAvailable: true,
    }).field("claude-config-dir"),
    /^\/Users\/me\/\.claude-work$/,
  );
});

test("leaves where the Task works out until its details are read", () => {
  const drawn = drawnInfo({
    task: { threadId: "thread-a", title: "Listed", threadStatus: IDLE },
    canonicalTaskAvailable: false,
  });
  assert.equal(drawn.field("status"), "unavailable");
  assert.equal(drawn.location, null);
  assert.deepEqual(drawn.paths, []);
});

test("reads where the Task works as one line, and its paths as New Task reads a folder", () => {
  const checkout = drawnInfo({
    task: canonical(),
    canonicalTaskAvailable: true,
    serverPaths: HOME,
  });
  assert.deepEqual(checkout.location, ["codger", "main"]);
  assert.deepEqual(checkout.paths, [
    ["path", "Path", "~/Workspace/rust/codger"],
  ]);
  assert.equal(checkout.pathsHidden, true);
  assert.equal(
    drawnInfo(
      { task: canonical(), canonicalTaskAvailable: true, serverPaths: HOME },
      { pathsOpen: true },
    ).pathsHidden,
    false,
  );

  const worktree = drawnInfo({
    task: canonical({
      cwd: `/${WORKTREE}/frontend`,
      cwdPath: `${WORKTREE}/frontend`,
      worktree: {
        rootPath: WORKTREE,
        repositoryRootPath: "Users/me/Workspace/rust/codger",
        branch: "try-ai-text-detectors",
        headSha: "1290ff05",
        relativeCwd: "frontend",
        linked: true,
      },
    }),
    canonicalTaskAvailable: true,
    serverPaths: { root: "/" },
  });
  assert.deepEqual(worktree.location, [
    "codger/frontend",
    "try-ai-text-detectors",
    "worktree",
  ]);
  assert.deepEqual(worktree.paths, [
    ["repository", "Repository", "/Users/me/Workspace/rust/codger"],
    ["worktree", "Worktree", `/${WORKTREE}`],
    ["working-directory", "Working directory", `/${WORKTREE}/frontend`],
  ]);
  assert.match(worktree.markup, /\/<wbr>Workspace\/<wbr>rust/);

  const subfolder = drawnInfo({
    task: canonical({
      cwdPath: "Users/me/Workspace/rust/codger/frontend",
      worktree: { ...canonical().worktree, branch: null, relativeCwd: "frontend" },
    }),
    canonicalTaskAvailable: true,
    serverPaths: { root: "Users" },
  });
  assert.deepEqual(subfolder.location, ["codger/frontend", "1fb17151"]);
  assert.deepEqual(subfolder.paths, [
    ["repository", "Repository", "Users/me/Workspace/rust/codger"],
    [
      "working-directory",
      "Working directory",
      "Users/me/Workspace/rust/codger/frontend",
    ],
  ]);

  const outsideGit = drawnInfo({
    task: canonical({
      cwd: "/Users/me/notes",
      cwdPath: "Users/me/notes",
      worktree: null,
    }),
    canonicalTaskAvailable: true,
    serverPaths: HOME,
  });
  assert.deepEqual(outsideGit.location, ["notes"]);
  assert.deepEqual(outsideGit.paths, [["path", "Path", "~/notes"]]);

  const outsideRoot = drawnInfo({
    task: canonical({ cwd: "/Volumes/work/notes", cwdPath: null, worktree: null }),
    canonicalTaskAvailable: true,
    serverPaths: { root: "/Users/me" },
  });
  assert.deepEqual(outsideRoot.paths, [["path", "Path", "/Volumes/work/notes"]]);
});

test("folds its paths when the popover closes or another Task takes its place", () => {
  const host = owner(info, {
    snapshot: taskInfoSnapshot({ task: canonical(), canonicalTaskAvailable: true }),
    pathsOpen: true,
    infoPopover: { value: null },
    infoButton: { value: null },
    actions: { value: { setPopoverOpen() {} } },
  });
  info.handleBeforeToggle.call(host, {
    target: host.infoPopover.value,
    newState: "open",
  });
  assert.equal(host.pathsOpen, true);
  info.handleBeforeToggle.call(host, {
    target: host.infoPopover.value,
    newState: "closed",
  });
  assert.equal(host.pathsOpen, false);

  host.pathsOpen = true;
  const previous = host.snapshot;
  host.snapshot = taskInfoSnapshot({
    task: canonical({ threadId: "thread-b" }),
    canonicalTaskAvailable: true,
  });
  info.willUpdate.call(host, new Map([["snapshot", previous]]));
  assert.equal(host.pathsOpen, false);
});

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
  host.rowIcons = new DrawnRefs(host);
  const markup = templateHtml(host.render()).replace(/\s+/g, " ");
  // A row's label, description, and whether it is disabled, or null when the
  // list leaves it out.
  const row = (type) => {
    const found = markup.match(
      new RegExp(
        `data-task-info-action="${type}"([^>]*)>.*?<span class="task-detail-action-label"[^>]*>([^<]*)</span ?> ?<span class="task-detail-action-description"[^>]*>([^<]*)</span ?>`,
      ),
    );
    return found
      ? {
          label: found[2].trim(),
          description: found[3].trim(),
          disabled: found[1].includes('?disabled="true"'),
        }
      : null;
  };
  // What hangs under the row whose action is `type`.
  const under = (type) =>
    markup
      .split(`data-task-info-action="${type}"`)[1]
      ?.match(/^.*?<\/(?:button|label)> (?:<div class="task-detail-action-under">(.*?)<\/div>)?/)?.[1] ??
    "";
  return { markup, row, under };
}

test("keeps Archive available through stale transport unless canonical status is active, and says why", () => {
  const task = {
    threadId: "thread-a",
    threadStatus: { type: "active", activeFlags: [] },
  };
  assert.deepEqual(
    drawnActions({ task, transportState: "unavailable" }).row("archive"),
    {
      label: "Archive task",
      description: "Removes it from the active list.",
      disabled: false,
    },
  );
  assert.deepEqual(
    drawnActions({
      task,
      transportState: "unavailable",
      archiveBlockedByActive: true,
    }).row("archive"),
    {
      label: "Archive task",
      description: "Available when the Task is idle.",
      disabled: true,
    },
  );
  const archiving = drawnActions({
    task,
    archiveState: { loading: true, error: null },
  });
  assert.deepEqual(archiving.row("archive"), {
    label: "Archiving...",
    description: "Removes it from the active list.",
    disabled: true,
  });
  assert.match(archiving.markup, /task-detail-action-icon is-busy/);
});

test("says Archive removes the worktree Caffold prepared and keeps its branch", () => {
  assert.equal(
    drawnActions({
      task: { threadId: "thread-a", threadStatus: IDLE },
      worktreePrepared: true,
    }).row("archive").description,
    "Removes its worktree and keeps the branch.",
  );
});

test("offers Discard changes and archive under Archive when its refusal allows it", () => {
  const error = Object.assign(
    new Error("managed worktree has uncommitted changes: /tmp/worktree"),
    { allowedActions: ["forceArchive"], worktreeId: "worktree-1" },
  );
  const under = drawnActions({
    task: { threadId: "thread-a", threadStatus: IDLE },
    archiveState: { loading: false, error },
  }).under("archive");
  assert.match(
    under,
    /task-detail-archive-error" role="alert" >managed worktree has uncommitted changes: \/tmp\/worktree</,
  );
  assert.match(
    under,
    /data-task-info-action="force-archive".*<span>Discard changes and archive<\/span>/,
  );
});

test("leaves Fork out for an agent that cannot fork, and says why another cannot fork now", () => {
  const task = { threadId: "thread-a", threadStatus: IDLE };
  const fork = (snapshot) =>
    drawnActions({
      task,
      canonicalTaskAvailable: true,
      transportState: "ready",
      provider: "codex",
      ...snapshot,
    }).row("fork");

  assert.equal(fork({ provider: "antigravity" }), null);
  assert.equal(fork({ provider: "" }), null);
  assert.deepEqual(fork({ provider: "", canonicalTaskAvailable: false }), {
    label: "Fork task",
    description: "Available once Task details load.",
    disabled: true,
  });
  for (const provider of ["codex", "claude", "grok", "copilot"]) {
    assert.deepEqual(fork({ provider }), {
      label: "Fork task",
      description: "Copies the conversation, not the files, into a new Task.",
      disabled: false,
    });
  }
  assert.deepEqual(fork({ canonicalTaskAvailable: false }), {
    label: "Fork task",
    description: "Available once Task details load.",
    disabled: true,
  });
  assert.equal(
    fork({ transportState: "unavailable" }).description,
    "Unavailable while the Task connection is interrupted.",
  );
  assert.equal(
    fork({ archiveState: { loading: true, error: null } }).description,
    "Unavailable while the Task is archiving.",
  );
  assert.equal(
    fork({ task: { threadId: "thread-a", threadStatus: { type: "active", activeFlags: [] } } })
      .description,
    "Available when the Task is idle.",
  );
});

test("offers Pin or Unpin only for a Task the list has placed", () => {
  const task = { threadId: "thread-a", threadStatus: IDLE };
  assert.equal(drawnActions({ task, pinned: null }).row("pin"), null);
  assert.deepEqual(drawnActions({ task, pinned: false }).row("pin"), {
    label: "Pin task",
    description: "Keep it at the top of the Task list.",
    disabled: false,
  });
  assert.deepEqual(drawnActions({ task, pinned: true }).row("unpin"), {
    label: "Unpin task",
    description: "Return it to its Section.",
    disabled: false,
  });
  assert.deepEqual(
    drawnActions({
      task,
      pinned: false,
      pinState: { loading: true, error: null },
    }).row("pin"),
    {
      label: "Pinning...",
      description: "Keep it at the top of the Task list.",
      disabled: true,
    },
  );
  assert.equal(
    drawnActions({
      task,
      pinned: true,
      pinState: { loading: true, error: null },
    }).row("unpin").disabled,
    true,
  );
  assert.match(
    drawnActions({
      task,
      pinned: false,
      pinState: { loading: false, error: new Error("Pin failed.") },
    }).under("pin"),
    /task-detail-pin-error" role="alert" >Pin failed\.</,
  );
});

test("lists the rows in the popover's order, with Archive set off by its own line", () => {
  const markup = drawnActions(
    {
      task: { threadId: "thread-a", threadStatus: IDLE },
      canonicalTaskAvailable: true,
      provider: "codex",
      pinned: false,
    },
    {
      repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
      fresh: true,
    },
  ).markup;
  assert.match(
    markup,
    /^ ?<hr class="task-detail-actions-divider">.*"pin".*"turn-on-language-servers".*"fork".*<hr class="task-detail-actions-divider">.*"archive"/,
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

// The Language servers row: its description, its switch's action and whether
// it is disabled, and what hangs under it.
function languageServersBlock(languageServers, snapshot = {}) {
  const task = { threadId: "thread-a", threadStatus: IDLE };
  const { markup } = drawnActions(
    { task, pinned: false, ...snapshot },
    languageServers,
  );
  const row = markup.match(
    /class="task-detail-action task-detail-language-servers-action" >(.*?)<\/label>(?: <div class="task-detail-action-under">(.*?)<\/div>)?/,
  );
  if (!row) {
    return { present: false };
  }
  const switchControl = row[1].match(
    /role="switch".*?data-task-info-action="([a-z-]+)".*?\?disabled="(true|false)"/,
  );
  const under = row[2] ?? "";
  return {
    present: true,
    description: row[1].match(
      /task-detail-action-description"[^>]*>([^<]*)</,
    )[1],
    switch: [switchControl[1], switchControl[2] === "true"],
    notes: [...under.matchAll(/<p class="task-detail-action-note[^"]*"[^>]*>([^<]*)<\/p>/g)].map(
      ([, text]) => text,
    ),
    buttons: [
      ...under.matchAll(
        /data-task-info-action="([a-z-]+)".*?<span>([^<]*)<\/span> ?<\/button>/g,
      ),
    ].map(([, action, label]) => [action, label]),
    under,
    busy: /task-detail-action-icon is-busy/.test(row[1]),
  };
}

const DESCRIPTION = "Go to definition and Find references.";

test("leaves the Language servers row out until the repository lists a server", () => {
  assert.equal(languageServersBlock({}).present, false);
  assert.equal(
    languageServersBlock({
      repository: { path: "repo", enabled: false, servers: [] },
      fresh: true,
    }).present,
    false,
  );
});

test("offers a switch that turns a repository's language servers on, and says nothing more while off", () => {
  const block = languageServersBlock({
    repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
    fresh: true,
  });
  assert.equal(block.description, DESCRIPTION);
  assert.deepEqual(block.switch, ["turn-on-language-servers", false]);
  assert.deepEqual(block.notes, []);
  assert.deepEqual(block.buttons, []);
});

test("tells each language's state under the row while on, with progress and memory when known", () => {
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
  assert.equal(block.description, DESCRIPTION);
  assert.deepEqual(block.switch, ["turn-off-language-servers", false]);
  assert.deepEqual(block.notes, [
    "Rust: ready · rust-analyzer · 2.8 GB",
    "TypeScript/JavaScript: sleeping",
  ]);
  assert.deepEqual(
    languageServersBlock({
      repository: {
        path: "repo",
        enabled: true,
        servers: [server("rust", "ready", { memoryBytes: 671_088_640 })],
      },
      fresh: true,
    }).notes,
    ["Rust: ready · rust-analyzer · 640 MB"],
  );
  assert.deepEqual(
    languageServersBlock({
      repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
      fresh: true,
    }).notes,
    ["Rust: ready · rust-analyzer"],
  );
});

test("holds the switch while a server gets ready or the switch turns, and says so", () => {
  const starting = languageServersBlock({
    repository: {
      path: "repo",
      enabled: true,
      servers: [server("rust", "starting", { progress: "Indexing 402/407 (caffold)" })],
    },
    fresh: true,
  });
  assert.equal(starting.description, "Starting language servers...");
  assert.deepEqual(starting.switch, ["turn-off-language-servers", true]);
  assert.deepEqual(starting.notes, [
    "Rust: getting ready · Indexing 402/407 (caffold)",
  ]);
  assert.equal(starting.busy, true);

  const turningOn = languageServersBlock({
    repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
    fresh: true,
    turning: "on",
  });
  assert.equal(turningOn.description, "Starting language servers...");
  assert.deepEqual(turningOn.switch, ["turn-on-language-servers", true]);
  const turningOff = languageServersBlock({
    repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
    fresh: true,
    turning: "off",
  });
  assert.equal(turningOff.description, "Turning off language servers...");
  assert.deepEqual(turningOff.switch, ["turn-off-language-servers", true]);
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

test("says which check failed for each language, with what a server that could not start printed, and offers one install under the row", () => {
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
  assert.deepEqual(block.notes, [
    "Rust: rust-analyzer is not installed for the 1.94-aarch64-apple-darwin toolchain.",
    "TypeScript/JavaScript: typescript-language-server stopped.",
  ]);
  assert.deepEqual(block.buttons, [
    ["install-language-servers", "Ask an agent to install rust-analyzer"],
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
  assert.deepEqual(couldNotStart.notes, [
    "Rust: rust-analyzer could not start.",
    "could not load the sysroot",
  ]);
  assert.match(
    couldNotStart.under,
    /task-detail-language-server-said" data-language-server-said="rust" >could not load the sysroot/,
  );
  assert.deepEqual(couldNotStart.buttons, []);
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
  assert.deepEqual(block.notes, [
    "Rust: rust-analyzer is not installed for the 1.94-aarch64-apple-darwin toolchain.",
    "TypeScript/JavaScript: typescript-language-server is not installed.",
  ]);
  assert.deepEqual(block.buttons, [
    ["install-language-servers", "Ask an agent to install 2 servers"],
  ]);
});

test("shows only the reason under the row, and holds the switch, while the last answer could not be read again", () => {
  const block = languageServersBlock({
    repository: { path: "repo", enabled: true, servers: [server("rust", "ready")] },
    fresh: false,
    error: new Error("The server did not answer."),
  });
  assert.deepEqual(block.notes, []);
  assert.deepEqual(block.switch, ["turn-off-language-servers", true]);
  assert.match(
    block.under,
    /task-detail-language-servers-error" role="alert" >The server did not answer\.</,
  );
});

const ARCHIVING = "Unavailable while the Task is archiving.";

test("holds every other action while the Task archives, and says why", () => {
  const archiving = {
    task: { threadId: "thread-a", threadStatus: IDLE },
    canonicalTaskAvailable: true,
    transportState: "ready",
    provider: "codex",
    pinned: false,
    archiveState: { loading: true, error: null },
  };
  const missingServer = {
    repository: {
      path: "repo",
      enabled: true,
      servers: [server("rust", "failed", { failure: RUST_NOT_INSTALLED })],
    },
    fresh: true,
  };
  const drawn = drawnActions(archiving, missingServer);
  assert.deepEqual(drawn.row("pin"), {
    label: "Pin task",
    description: ARCHIVING,
    disabled: true,
  });
  assert.deepEqual(drawn.row("fork"), {
    label: "Fork task",
    description: ARCHIVING,
    disabled: true,
  });

  const servers = languageServersBlock(missingServer, archiving);
  assert.equal(servers.description, ARCHIVING);
  assert.deepEqual(servers.switch, ["turn-off-language-servers", true]);
  // What the servers report stays readable; only what acts on them waits.
  assert.deepEqual(servers.notes, [
    "Rust: rust-analyzer is not installed for the 1.94-aarch64-apple-darwin toolchain.",
  ]);
  assert.match(
    servers.under,
    /data-task-info-action="install-language-servers"[^>]*\?disabled="true"/,
  );

  // A request already running keeps saying so.
  assert.deepEqual(
    drawnActions({ ...archiving, pinState: { loading: true, error: null } }).row(
      "pin",
    ),
    {
      label: "Pinning...",
      description: "Keep it at the top of the Task list.",
      disabled: true,
    },
  );
  assert.equal(
    languageServersBlock(
      {
        repository: { path: "repo", enabled: false, servers: [server("rust", "off")] },
        fresh: true,
        turning: "on",
      },
      archiving,
    ).description,
    "Starting language servers...",
  );
});

test("asks nothing of its language servers while the Task archives", () => {
  const turned = [];
  const events = [];
  const host = owner(actions, {
    snapshot: taskInfoSnapshot({
      task: { threadId: "thread-a", threadStatus: IDLE },
      archiveState: { loading: true, error: null },
    }),
    languageServers: {
      repository: {
        path: "Users/me/repo",
        enabled: true,
        servers: [server("rust", "failed", { failure: RUST_NOT_INSTALLED })],
      },
      fresh: true,
      turning: null,
      error: null,
    },
    languageServersLifecycle: { turn: (enabled) => turned.push(enabled) },
    detailsButton: null,
    dispatchEvent: (event) => events.push(event),
  });
  actions.turnLanguageServers.call(host);
  actions.requestLanguageServerInstall.call(host);
  assert.deepEqual(turned, []);
  assert.deepEqual(events, []);

  host.snapshot = taskInfoSnapshot({
    task: { threadId: "thread-a", threadStatus: IDLE },
  });
  actions.turnLanguageServers.call(host);
  actions.requestLanguageServerInstall.call(host);
  assert.deepEqual(turned, [false]);
  assert.equal(events.length, 1);
});

test("asks for every missing server's install and returns focus to the details button", () => {
  const events = [];
  const detailsButton = {};
  const host = owner(actions, {
    snapshot: taskInfoSnapshot({
      task: { threadId: "thread-a", threadStatus: IDLE },
    }),
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
    pathsOpen: false,
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
