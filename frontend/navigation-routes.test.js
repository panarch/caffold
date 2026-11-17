import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTE_RELATION,
  parentRoute,
  parseLinkRoute,
  parseRoute,
  routeAscentSteps,
  routeDomain,
  routeEquals,
  routeMode,
  routeRelation,
  routeSurface,
  routeTab,
  routeTarget,
  routeUrl,
} from "./navigation-routes.js";

globalThis.window = {
  location: { origin: "http://caffold.test" },
};

test("parses and serializes Task-scoped routes canonically", () => {
  const cases = [
    ["/", { kind: "tasks", new: false, threadId: "", cwd: "" }, "/"],
    ["/notes", { kind: "notes", noteId: "" }, "/notes"],
    [
      "/notes/0f6c3e5a-7d52-4d1a-9f3e-5b7a1c2d3e4f",
      { kind: "notes", noteId: "0f6c3e5a-7d52-4d1a-9f3e-5b7a1c2d3e4f" },
      "/notes/0f6c3e5a-7d52-4d1a-9f3e-5b7a1c2d3e4f",
    ],
    ["/notes/note%20with%20spaces", { kind: "notes", noteId: "note with spaces" }, "/notes/note%20with%20spaces"],
    ["/settings", { kind: "settings", section: "" }, "/settings"],
    ["/settings/appearance", { kind: "settings", section: "appearance" }, "/settings/appearance"],
    ["/settings/keyboard", { kind: "settings", section: "keyboard" }, "/settings/keyboard"],
    ["/settings/files", { kind: "settings", section: "files" }, "/settings/files"],
    ["/settings/language-servers", { kind: "settings", section: "language-servers" }, "/settings/language-servers"],
    ["/settings/notifications", { kind: "settings", section: "notifications" }, "/settings/notifications"],
    ["/settings/codex", { kind: "settings", section: "codex" }, "/settings/codex"],
    ["/settings/about", { kind: "settings", section: "about" }, "/settings/about"],
    ["/tasks", { kind: "tasks", new: false, threadId: "", cwd: "" }, "/"],
    [
      "/?section=repo-1",
      {
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: "",
        sectionId: "repo-1",
        sectionSurface: "new",
        sectionTool: "",
        reviewScope: "working",
        reviewNavigator: "changes",
        reviewViewer: "diff",
        reviewFind: "",
        reviewFindAt: "",
        path: "",
        line: null,
        baseRef: "",
        headRef: "",
        page: 1,
        sha: "",
        number: null,
        files: false,
      },
      "/?section=repo-1",
    ],
    [
      "/?section=repo-1&surface=review&scope=branch&nav=files&view=source&file=src%2Flib.rs&line=17&base=main",
      {
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: "",
        sectionId: "repo-1",
        sectionSurface: "review",
        sectionTool: "",
        reviewScope: "branch",
        reviewNavigator: "files",
        reviewViewer: "source",
        reviewFind: "",
        reviewFindAt: "",
        path: "src/lib.rs",
        line: 17,
        baseRef: "main",
        headRef: "",
        page: 1,
        sha: "",
        number: null,
        files: false,
      },
      "/?section=repo-1&surface=review&scope=branch&nav=files&view=source&file=src%2Flib.rs&line=17&base=main",
    ],
    [
      "/?section=repo-1&surface=git&tool=log&page=2&sha=abcdef&file=src%2Flib.rs",
      {
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: "",
        sectionId: "repo-1",
        sectionSurface: "git",
        sectionTool: "log",
        reviewScope: "working",
        reviewNavigator: "changes",
        reviewViewer: "diff",
        reviewFind: "",
        reviewFindAt: "",
        path: "src/lib.rs",
        line: null,
        baseRef: "",
        headRef: "",
        page: 2,
        sha: "abcdef",
        number: null,
        files: false,
      },
      "/?section=repo-1&surface=git&tool=log&file=src%2Flib.rs&page=2&sha=abcdef",
    ],
    [
      "/?section=repo-1&surface=github&tool=pulls&page=2&number=12&files=true&file=src%2Flib.rs",
      {
        kind: "tasks",
        new: false,
        threadId: "",
        cwd: "",
        sectionId: "repo-1",
        sectionSurface: "github",
        sectionTool: "pulls",
        reviewScope: "working",
        reviewNavigator: "changes",
        reviewViewer: "diff",
        reviewFind: "",
        reviewFindAt: "",
        path: "src/lib.rs",
        line: null,
        baseRef: "",
        headRef: "",
        page: 2,
        sha: "",
        number: 12,
        files: true,
      },
      "/?section=repo-1&surface=github&tool=pulls&file=src%2Flib.rs&page=2&number=12&files=true",
    ],
    [
      "/tasks/new?cwd=src",
      { kind: "tasks", new: true, threadId: "", cwd: "src" },
      "/tasks/new?cwd=src",
    ],
    [
      "/tasks/thread%201",
      { kind: "tasks", new: false, threadId: "thread 1", cwd: "" },
      "/tasks/thread%201",
    ],
    [
      "/tasks/thread%201/recovery",
      { kind: "tasks", new: false, threadId: "thread 1", cwd: "", recovery: true },
      "/tasks/thread%201/recovery",
    ],
    [
      "/tasks/thread%201/review?scope=branch&nav=files&view=source&file=..%2Fshared%2Flib.rs&line=17&base=origin%2Fmain",
      {
        kind: "tasks",
        new: false,
        threadId: "thread 1",
        cwd: "",
        review: true,
        reviewScope: "branch",
        reviewNavigator: "files",
        reviewViewer: "source",
        reviewFind: "",
        reviewFindAt: "",
        path: "../shared/lib.rs",
        line: 17,
        baseRef: "origin/main",
      },
      "/tasks/thread%201/review?scope=branch&nav=files&view=source&file=..%2Fshared%2Flib.rs&line=17&base=origin%2Fmain",
    ],
    [
      "/tasks/thread/git/compare?base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
      {
        kind: "compare",
        threadId: "thread",
        baseRef: "origin/main",
        headRef: "feature/x",
        path: "src/lib.rs",
      },
      "/tasks/thread/git/compare?base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
    ],
    [
      "/tasks/thread/git/log?page=2&sha=abcdef&file=src%2Flib.rs",
      { kind: "log", threadId: "thread", page: 2, sha: "abcdef", path: "src/lib.rs" },
      "/tasks/thread/git/log?page=2&sha=abcdef&file=src%2Flib.rs",
    ],
    [
      "/tasks/thread/github/issues?page=2",
      { kind: "issues", threadId: "thread", page: 2, number: null },
      "/tasks/thread/github/issues?page=2",
    ],
    [
      "/tasks/thread/github/issues/42",
      { kind: "issues", threadId: "thread", page: 1, number: 42 },
      "/tasks/thread/github/issues/42",
    ],
    [
      "/tasks/thread/github/pulls?page=2",
      { kind: "pulls", threadId: "thread", page: 2, number: null, files: false, path: "" },
      "/tasks/thread/github/pulls?page=2",
    ],
    [
      "/tasks/thread/github/pulls/12",
      { kind: "pulls", threadId: "thread", page: 1, number: 12, files: false, path: "" },
      "/tasks/thread/github/pulls/12",
    ],
    [
      "/tasks/thread/github/pulls/12/files?page=2&file=src%2Flib.rs",
      { kind: "pulls", threadId: "thread", page: 2, number: 12, files: true, path: "src/lib.rs" },
      "/tasks/thread/github/pulls/12/files?page=2&file=src%2Flib.rs",
    ],
  ];

  for (const [url, expectedRoute, canonicalUrl] of cases) {
    const route = parseRoute(url);
    assert.deepEqual(route, expectedRoute);
    assert.equal(routeUrl(route), canonicalUrl);
  }
});

test("preserves Markdown Preview as reloadable Integrated Review state", () => {
  const urls = [
    "/tasks/thread/review?nav=files&view=preview&file=README.md",
    "/?section=repo-1&surface=review&nav=files&view=preview&file=README.md",
  ];

  for (const url of urls) {
    const route = parseRoute(url);
    assert.equal(route.reviewViewer, "preview");
    assert.equal(route.path, "README.md");
    assert.equal(routeUrl(route), url);
  }
});

test("keeps a Review find and its name's place only while it names a list", () => {
  const route = parseRoute(
    "/tasks/thread/review?nav=files&view=source&file=src%2Fmain.rs&line=12&find=references&at=src%2Flib.rs%3A3%3A8",
  );
  assert.equal(route.reviewFind, "references");
  assert.equal(route.reviewFindAt, "src/lib.rs:3:8");
  assert.equal(
    routeUrl(route),
    "/tasks/thread/review?nav=files&view=source&file=src%2Fmain.rs&line=12&find=references&at=src%2Flib.rs%3A3%3A8",
  );
  assert.equal(
    routeUrl(parentRoute(route)),
    "/tasks/thread/review?nav=files&view=source&find=references&at=src%2Flib.rs%3A3%3A8",
  );
  const section = parseRoute(
    "/?section=repo-1&surface=review&find=definitions&at=a.rs%3A1%3A1",
  );
  assert.equal(section.reviewFind, "definitions");
  assert.equal(section.reviewFindAt, "a.rs:1:1");

  const unknown = parseRoute("/tasks/thread/review?find=callers&at=a.rs%3A1%3A1");
  assert.equal(unknown.reviewFind, "");
  assert.equal(unknown.reviewFindAt, "");
  assert.equal(routeUrl(unknown), "/tasks/thread/review");
});

test("keeps a Review file named from Caffold's root apart from the Task's files", () => {
  const route = parseRoute(
    "/tasks/thread/review?view=source&file=%2Fhome%2Fme%2F..%2F..%2Flib%2Fcore.rs&line=4",
  );
  assert.equal(route.path, "/lib/core.rs");
  assert.equal(
    routeUrl(route),
    "/tasks/thread/review?view=source&file=%2Flib%2Fcore.rs&line=4",
  );
  assert.equal(parseRoute("/tasks/thread/review?file=..%2Flib.rs").path, "../lib.rs");
});

test("preserves Visual as reloadable Integrated Review state", () => {
  const urls = [
    "/tasks/thread/review?view=visual&file=assets%2Flogo.png",
    "/?section=repo-1&surface=review&view=visual&file=assets%2Flogo.png",
  ];

  for (const url of urls) {
    const route = parseRoute(url);
    assert.equal(route.reviewViewer, "visual");
    assert.equal(route.path, "assets/logo.png");
    assert.equal(routeUrl(route), url);
  }
});

test("derives deterministic Task child parents", () => {
  const cases = [
    ["/notes", null],
    ["/notes/note-1", "/notes"],
    ["/settings", null],
    ["/settings/appearance", "/settings"],
    ["/settings/keyboard", "/settings"],
    ["/settings/files", "/settings"],
    ["/settings/language-servers", "/settings"],
    ["/settings/notifications", "/settings"],
    ["/", null],
    ["/?section=repo-1", "/"],
    [
      "/?section=repo-1&surface=review&file=src%2Flib.rs",
      "/?section=repo-1&surface=review",
    ],
    [
      "/?section=repo-1&surface=git&tool=log&page=2&sha=abcdef&file=src%2Flib.rs",
      "/?section=repo-1&surface=git&tool=log&page=2&sha=abcdef",
    ],
    [
      "/?section=repo-1&surface=github&tool=pulls&page=2&number=12&files=true&file=src%2Flib.rs",
      "/?section=repo-1&surface=github&tool=pulls&page=2&number=12&files=true",
    ],
    ["/?section=repo-1&surface=review", "/"],
    ["/?section=repo-1&surface=git&tool=compare&base=main&head=feature", "/"],
    ["/?section=repo-1&surface=git&tool=log&page=2", "/"],
    ["/?section=repo-1&surface=github&tool=issues&page=2", "/"],
    ["/?section=repo-1&surface=github&tool=pulls&page=2", "/"],
    ["/tasks/new?cwd=src", "/"],
    ["/tasks/thread", "/"],
    ["/tasks/thread/recovery", "/"],
    ["/tasks/thread/terminal", "/"],
    ["/?section=repo-1&surface=terminal", "/"],
    [
      "/tasks/thread/review?scope=branch&nav=files&view=source&file=src%2Flib.rs&line=17&base=origin%2Fmain",
      "/tasks/thread/review?scope=branch&nav=files&view=source&base=origin%2Fmain",
    ],
    ["/tasks/thread/review", "/"],
    [
      "/tasks/thread/git/compare?base=main&head=feature&file=src%2Flib.rs",
      "/tasks/thread/git/compare?base=main&head=feature",
    ],
    ["/tasks/thread/git/compare?base=main&head=feature", "/"],
    [
      "/tasks/thread/git/log?page=2&sha=abcdef&file=src%2Flib.rs",
      "/tasks/thread/git/log?page=2&sha=abcdef",
    ],
    ["/tasks/thread/git/log?page=2&sha=abcdef", "/tasks/thread/git/log?page=2"],
    ["/tasks/thread/git/log?page=2", "/"],
    ["/tasks/thread/github/issues/42?page=2", "/tasks/thread/github/issues?page=2"],
    ["/tasks/thread/github/issues?page=2", "/"],
    [
      "/tasks/thread/github/pulls/12/files?page=2&file=src%2Flib.rs",
      "/tasks/thread/github/pulls/12/files?page=2",
    ],
    [
      "/tasks/thread/github/pulls/12/files?page=2",
      "/tasks/thread/github/pulls/12?page=2",
    ],
    ["/tasks/thread/github/pulls/12?page=2", "/tasks/thread/github/pulls?page=2"],
    ["/tasks/thread/github/pulls?page=2", "/"],
  ];

  for (const [url, expectedParent] of cases) {
    const parent = parentRoute(parseRoute(url));
    assert.equal(parent ? routeUrl(parent) : null, expectedParent);
  }
});

test("exposes Task workspace, domain, mode, and target metadata", () => {
  const cases = [
    ["/", null, "tasks", "home"],
    ["/?section=repo-1", null, "tasks", "section"],
    ["/?section=repo-1&surface=review", null, "tasks", "review"],
    ["/?section=repo-1&surface=git&tool=log&sha=abcdef", "git", "log", "commit"],
    ["/?section=repo-1&surface=github&tool=pulls&number=12&files=true", "github", "pulls", "files"],
    ["/notes", null, "notes", "list"],
    ["/notes/note-1", null, "notes", "note"],
    ["/settings", null, "settings", "list"],
    ["/tasks/new", null, "tasks", "new"],
    ["/tasks/thread", null, "tasks", "detail"],
    ["/tasks/thread/recovery", null, "tasks", "recovery"],
    ["/tasks/thread/terminal", null, "tasks", "terminal"],
    ["/?section=repo-1&surface=terminal", null, "tasks", "terminal"],
    ["/tasks/thread/review", null, "tasks", "review"],
    ["/tasks/thread/review?file=src%2Flib.rs", null, "tasks", "review-file"],
    ["/tasks/thread/git/compare", "git", "compare", "list"],
    ["/tasks/thread/git/compare?file=src%2Flib.rs", "git", "compare", "file"],
    ["/tasks/thread/git/log", "git", "log", "list"],
    ["/tasks/thread/git/log?sha=abcdef", "git", "log", "commit"],
    ["/tasks/thread/github/issues", "github", "issues", "list"],
    ["/tasks/thread/github/issues/42", "github", "issues", "detail"],
    ["/tasks/thread/github/pulls", "github", "pulls", "list"],
    ["/tasks/thread/github/pulls/12", "github", "pulls", "detail"],
    ["/tasks/thread/github/pulls/12/files", "github", "pulls", "files"],
    ["/tasks/thread/github/pulls/12/files?file=src%2Flib.rs", "github", "pulls", "file"],
  ];

  for (const [url, domain, mode, target] of cases) {
    const route = parseRoute(url);
    assert.equal(routeSurface(route), "task-workspace");
    assert.equal(routeDomain(route), domain);
    assert.equal(routeMode(route), mode);
    assert.equal(routeTarget(route), target);
  }
});

test("rejects obsolete standalone and invalid routes", () => {
  for (const url of [
    "/files",
    "/git/diff?cwd=repo",
    "/git/compare?cwd=repo",
    "/git/log?cwd=repo",
    "/github/issues?cwd=repo",
    "/github/pulls?cwd=repo",
    "/projects",
    "/tasks/thread/github/issues/not-a-number",
    "/tasks/thread/github/pulls/not-a-number",
  ]) {
    assert.equal(parseRoute(url), null);
  }

  const malformedLine = parseRoute(
    "/tasks/thread/review?nav=files&view=source&file=src%2Flib.rs&line=17px",
  );
  assert.equal(malformedLine.line, null);
  assert.equal(
    routeUrl(malformedLine),
    "/tasks/thread/review?nav=files&view=source&file=src%2Flib.rs",
  );

  const lineWithoutFile = parseRoute("/tasks/thread/review?line=17");
  assert.equal(lineWithoutFile.line, null);
  assert.equal(routeUrl(lineWithoutFile), "/tasks/thread/review");
});

test("compares Task-scoped routes by canonical URL", () => {
  assert.equal(
    routeEquals(
      { kind: "issues", threadId: "thread", page: 1, number: null },
      parseRoute("/tasks/thread/github/issues"),
    ),
    true,
  );
  assert.equal(
    routeEquals(
      { kind: "issues", threadId: "other", page: 1, number: null },
      parseRoute("/tasks/thread/github/issues"),
    ),
    false,
  );
});

test("assigns every route to the bottom tab that presents it", () => {
  const cases = [
    ["/", "tasks"],
    ["/tasks/new", "tasks"],
    ["/tasks/thread", "tasks"],
    ["/tasks/thread/review?file=src%2Flib.rs", "tasks"],
    ["/tasks/thread/git/log?page=2", "tasks"],
    ["/tasks/thread/github/pulls/12/files", "tasks"],
    ["/?section=repo-1&surface=github&tool=issues", "tasks"],
    ["/notes", "notes"],
    ["/notes/note-1", "notes"],
    ["/settings", "settings"],
    ["/settings/appearance", "settings"],
  ];

  for (const [url, expected] of cases) {
    assert.equal(routeTab(parseRoute(url)), expected, url);
  }
});

test("reads a link's route only while following it stays in the application", () => {
  assert.deepEqual(parseLinkRoute("/notes/note-1"), parseRoute("/notes/note-1"));
  assert.equal(parseLinkRoute(" /notes/note-1?beside=note-2 ").secondaryNoteId, "note-2");
  assert.deepEqual(parseLinkRoute("/tasks/thread"), parseRoute("/tasks/thread"));
  for (const href of [
    "notes/note-1",
    "http://caffold.test/notes/note-1",
    "https://example.com/notes/note-1",
    "//example.com/notes/note-1",
    "/\\example.com/notes/note-1",
    "/files",
    "",
    null,
  ]) {
    assert.equal(parseLinkRoute(href), null, href);
  }
});

test("counts the parents between a route and one it sits under", () => {
  const cases = [
    ["/tasks/thread/github/pulls/12/files?file=src%2Flib.rs", "/tasks/thread/github/pulls/12/files", 1],
    ["/tasks/thread/github/pulls/12/files?file=src%2Flib.rs", "/tasks/thread/github/pulls", 3],
    ["/tasks/thread/github/pulls/12/files?file=src%2Flib.rs", "/", 4],
    ["/tasks/thread/review?file=src%2Flib.rs", "/", 2],
    ["/notes/note-1", "/notes", 1],
    ["/settings/appearance", "/settings", 1],
    ["/", "/notes", null],
    ["/tasks/thread", "/tasks/other", null],
    ["/tasks/thread/github/pulls", "/tasks/thread/github/pulls/12", null],
  ];

  for (const [from, to, expected] of cases) {
    assert.equal(
      routeAscentSteps(parseRoute(from), parseRoute(to)),
      expected,
      `${from} -> ${to}`,
    );
  }
});

test("reads how one route stands to another from their declared parents", () => {
  const cases = [
    // 들어간다
    ["/", "/tasks/thread", ROUTE_RELATION.DESCEND],
    ["/tasks/thread/github/issues", "/tasks/thread/github/issues/42", ROUTE_RELATION.DESCEND],
    ["/tasks/thread/review", "/tasks/thread/review?file=src%2Flib.rs", ROUTE_RELATION.DESCEND],
    ["/notes", "/notes/note-1", ROUTE_RELATION.DESCEND],
    ["/settings", "/settings/appearance", ROUTE_RELATION.DESCEND],
    // 나온다
    ["/tasks/thread", "/", ROUTE_RELATION.ASCEND],
    ["/tasks/thread/review?file=src%2Flib.rs", "/tasks/thread/review", ROUTE_RELATION.ASCEND],
    ["/notes/note-1", "/notes", ROUTE_RELATION.ASCEND],
    ["/settings/appearance", "/settings", ROUTE_RELATION.ASCEND],
    // 바꾼다
    ["/tasks/thread", "/tasks/other", ROUTE_RELATION.SWAP],
    ["/tasks/thread", "/tasks/thread/review", ROUTE_RELATION.SWAP],
    ["/tasks/thread", "/tasks/thread/terminal", ROUTE_RELATION.SWAP],
    ["/tasks/thread/terminal", "/tasks/thread/git/log", ROUTE_RELATION.SWAP],
    ["/?section=repo-1", "/?section=repo-1&surface=terminal", ROUTE_RELATION.SWAP],
    ["/tasks/thread/review", "/tasks/thread/git/log", ROUTE_RELATION.SWAP],
    ["/tasks/thread/github/issues/42", "/tasks/thread/github/issues/43", ROUTE_RELATION.SWAP],
    ["/tasks/thread/git/log?page=1", "/tasks/thread/git/log?page=2", ROUTE_RELATION.SWAP],
    ["/notes/note-1", "/notes/note-2", ROUTE_RELATION.SWAP],
    ["/settings/appearance", "/settings/keyboard", ROUTE_RELATION.SWAP],
    // 탭을 옮긴다
    ["/", "/notes", ROUTE_RELATION.TAB],
    ["/tasks/thread/review", "/settings/appearance", ROUTE_RELATION.TAB],
    ["/notes/note-1", "/", ROUTE_RELATION.TAB],
  ];

  for (const [from, to, expected] of cases) {
    assert.equal(
      routeRelation(parseRoute(from), parseRoute(to)),
      expected,
      `${from} -> ${to}`,
    );
  }

  assert.equal(routeRelation(null, parseRoute("/")), null);
  assert.equal(routeRelation(parseRoute("/"), null), null);
});

test("a Task or Section terminal is a route of its own", () => {
  const task = parseRoute("/tasks/thread%201/terminal");
  assert.deepEqual(task, {
    kind: "tasks",
    new: false,
    threadId: "thread 1",
    cwd: "",
    terminal: true,
  });
  assert.equal(routeUrl(task), "/tasks/thread%201/terminal");
  assert.equal(routeTab(task), "tasks");
  assert.equal(routeUrl({ kind: "tasks", threadId: "thread" }), "/tasks/thread");

  const section = parseRoute("/?section=plain&surface=terminal");
  assert.equal(section.sectionSurface, "terminal");
  assert.equal(section.sectionTool, "");
  assert.equal(section.path, "");
  assert.equal(routeUrl(section), "/?section=plain&surface=terminal");
});

test("a Notes pair is reloadable, shares the single-note parent, and rejects duplicate ids", () => {
  const pair = parseRoute("/notes/A?beside=B");
  assert.deepEqual(pair, { kind: "notes", noteId: "A", secondaryNoteId: "B" });
  assert.equal(routeUrl(pair), "/notes/A?beside=B");
  assert.deepEqual(parentRoute(pair), { kind: "notes", noteId: "" });
  assert.equal(routeRelation(pair, parseRoute("/notes/C?beside=B")), ROUTE_RELATION.SWAP);
  assert.equal(routeEquals(pair, parseRoute("/notes/A")), false);
  assert.equal(routeUrl(parseRoute("/notes/A?beside=A")), "/notes/A");
  assert.equal(routeUrl(parseRoute("/notes?beside=B")), "/notes");
});
