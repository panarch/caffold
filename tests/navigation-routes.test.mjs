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
} from "../frontend/navigation-routes.js";

globalThis.window = {
  location: {
    origin: "http://caffold.test",
  },
};

test("parses and serializes routes canonically", () => {
  const cases = [
    ["/settings", { kind: "settings" }, "/settings"],
    [
      "/tasks?cwd=Workspace%2Frust%2Fgluesql",
      { kind: "tasks", new: false, threadId: "", cwd: "" },
      "/tasks",
    ],
    [
      "/tasks/new?cwd=src",
      { kind: "tasks", new: true, threadId: "", cwd: "src" },
      "/tasks/new?cwd=src",
    ],
    [
      "/tasks/thread%201?cwd=src",
      { kind: "tasks", new: false, threadId: "thread 1", cwd: "" },
      "/tasks/thread%201",
    ],
    [
      "/files?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
      { kind: "files", cwd: "Workspace/rust/gluesql", path: "core/src/lib.rs" },
      "/files?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
    ],
    [
      "/git/diff?cwd=repo&file=src%2Flib.rs",
      { kind: "diff", cwd: "repo", path: "src/lib.rs" },
      "/git/diff?cwd=repo&file=src%2Flib.rs",
    ],
    [
      "/git/compare?cwd=repo&base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
      {
        kind: "compare",
        cwd: "repo",
        baseRef: "origin/main",
        headRef: "feature/x",
        path: "src/lib.rs",
      },
      "/git/compare?cwd=repo&base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
    ],
    [
      "/git/log?cwd=repo&page=2&sha=abcdef&file=src%2Flib.rs",
      { kind: "log", cwd: "repo", page: 2, sha: "abcdef", path: "src/lib.rs" },
      "/git/log?cwd=repo&page=2&sha=abcdef&file=src%2Flib.rs",
    ],
    [
      "/github/issues?cwd=repo&page=2",
      { kind: "issues", cwd: "repo", page: 2, number: null },
      "/github/issues?cwd=repo&page=2",
    ],
    [
      "/github/issues/42?cwd=repo",
      { kind: "issues", cwd: "repo", page: 1, number: 42 },
      "/github/issues/42?cwd=repo",
    ],
    [
      "/github/pulls?cwd=repo&page=2",
      { kind: "pulls", cwd: "repo", page: 2, number: null, files: false, path: "" },
      "/github/pulls?cwd=repo&page=2",
    ],
    [
      "/github/pulls/12?cwd=repo",
      { kind: "pulls", cwd: "repo", page: 1, number: 12, files: false, path: "" },
      "/github/pulls/12?cwd=repo",
    ],
    [
      "/github/pulls/12/files?cwd=repo&page=2&file=src%2Flib.rs",
      { kind: "pulls", cwd: "repo", page: 2, number: 12, files: true, path: "src/lib.rs" },
      "/github/pulls/12/files?cwd=repo&page=2&file=src%2Flib.rs",
    ],
  ];

  for (const [url, expectedRoute, canonicalUrl] of cases) {
    const route = parseRoute(url);
    assert.deepEqual(route, expectedRoute);
    assert.equal(routeUrl(route), canonicalUrl);
  }
});

test("derives deterministic parent routes", () => {
  const cases = [
    ["/settings", null],
    ["/tasks", null],
    ["/tasks/new?cwd=src", "/tasks"],
    ["/tasks/thread?cwd=src", "/tasks"],
    ["/files?cwd=repo&file=src%2Flib.rs", "/files?cwd=repo"],
    ["/files?cwd=repo", null],
    ["/git/diff?cwd=repo&file=src%2Flib.rs", "/git/diff?cwd=repo"],
    ["/git/diff?cwd=repo", "/files?cwd=repo"],
    [
      "/git/compare?cwd=repo&base=main&head=feature&file=src%2Flib.rs",
      "/git/compare?cwd=repo&base=main&head=feature",
    ],
    ["/git/compare?cwd=repo&base=main&head=feature", "/files?cwd=repo"],
    [
      "/git/log?cwd=repo&page=2&sha=abcdef&file=src%2Flib.rs",
      "/git/log?cwd=repo&page=2&sha=abcdef",
    ],
    ["/git/log?cwd=repo&page=2&sha=abcdef", "/git/log?cwd=repo&page=2"],
    ["/git/log?cwd=repo&page=2", "/files?cwd=repo"],
    ["/github/issues/42?cwd=repo&page=2", "/github/issues?cwd=repo&page=2"],
    ["/github/issues?cwd=repo&page=2", "/files?cwd=repo"],
    [
      "/github/pulls/12/files?cwd=repo&page=2&file=src%2Flib.rs",
      "/github/pulls/12/files?cwd=repo&page=2",
    ],
    ["/github/pulls/12/files?cwd=repo&page=2", "/github/pulls/12?cwd=repo&page=2"],
    ["/github/pulls/12?cwd=repo&page=2", "/github/pulls?cwd=repo&page=2"],
    ["/github/pulls?cwd=repo&page=2", "/files?cwd=repo"],
  ];

  for (const [url, expectedParent] of cases) {
    const parent = parentRoute(parseRoute(url));
    assert.equal(parent ? routeUrl(parent) : null, expectedParent);
  }
});

test("exposes surface, domain, mode, and target metadata", () => {
  const cases = [
    ["/settings", "settings", null, "settings", "page"],
    ["/tasks", "tasks", null, "tasks", "list"],
    ["/tasks/new", "tasks", null, "tasks", "new"],
    ["/tasks/thread", "tasks", null, "tasks", "detail"],
    ["/files?cwd=repo", "files", null, "files", "list"],
    ["/files?cwd=repo&file=src%2Flib.rs", "files", null, "files", "path"],
    ["/git/diff?cwd=repo", "review", "git", "diff", "list"],
    ["/git/diff?cwd=repo&file=src%2Flib.rs", "review", "git", "diff", "file"],
    ["/git/compare?cwd=repo", "review", "git", "compare", "list"],
    ["/git/log?cwd=repo", "review", "git", "log", "list"],
    ["/git/log?cwd=repo&sha=abcdef", "review", "git", "log", "commit"],
    ["/github/issues?cwd=repo", "review", "github", "issues", "list"],
    ["/github/issues/42?cwd=repo", "review", "github", "issues", "detail"],
    ["/github/pulls?cwd=repo", "review", "github", "pulls", "list"],
    ["/github/pulls/12?cwd=repo", "review", "github", "pulls", "detail"],
    ["/github/pulls/12/files?cwd=repo", "review", "github", "pulls", "files"],
    [
      "/github/pulls/12/files?cwd=repo&file=src%2Flib.rs",
      "review",
      "github",
      "pulls",
      "file",
    ],
  ];

  for (const [url, surface, domain, mode, target] of cases) {
    const route = parseRoute(url);
    assert.equal(routeSurface(route), surface);
    assert.equal(routeDomain(route), domain);
    assert.equal(routeMode(route), mode);
    assert.equal(routeTarget(route), target);
  }
});

test("rejects removed project routes and invalid app paths", () => {
  for (const url of [
    "/",
    "/api/health",
    "/projects",
    "/projects/prj/files",
    "/projects/prj/tasks",
    "/github/issues/not-a-number",
    "/github/pulls/not-a-number",
  ]) {
    assert.equal(parseRoute(url), null);
  }
});

test("compares routes by canonical URL", () => {
  assert.equal(
    routeEquals(
      { kind: "issues", cwd: "repo", page: 1, number: null },
      parseRoute("/github/issues?cwd=repo"),
    ),
    true,
  );
  assert.equal(
    routeEquals(
      { kind: "issues", cwd: "repo", page: 2, number: null },
      parseRoute("/github/issues?cwd=repo"),
    ),
    false,
  );
});
