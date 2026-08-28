import assert from "node:assert/strict";
import test from "node:test";
import {
  parentRoute,
  parseRoute,
  routeDomain,
  routeEquals,
  routeMode,
  routeSurface,
  routeTarget,
  routeUrl,
} from "./navigation-routes.js";

globalThis.window = {
  location: { origin: "http://caffold.test" },
};

test("parses and serializes Task-scoped routes canonically", () => {
  const cases = [
    ["/", { kind: "tasks", new: false, threadId: "", cwd: "" }, "/"],
    ["/settings", { kind: "settings", section: "" }, "/settings"],
    ["/settings/appearance", { kind: "settings", section: "appearance" }, "/settings/appearance"],
    ["/settings/files", { kind: "settings", section: "files" }, "/settings/files"],
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

test("derives deterministic Task child parents", () => {
  const cases = [
    ["/settings", null],
    ["/settings/appearance", "/settings"],
    ["/settings/files", "/settings"],
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
    ["/tasks/new?cwd=src", "/"],
    ["/tasks/thread", "/"],
    ["/tasks/thread/recovery", "/"],
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
    ["/settings", null, "settings", "list"],
    ["/tasks/new", null, "tasks", "new"],
    ["/tasks/thread", null, "tasks", "detail"],
    ["/tasks/thread/recovery", null, "tasks", "recovery"],
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
