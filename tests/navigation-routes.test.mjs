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

test("parses and serializes project route URLs canonically", () => {
  const cases = [
    ["/settings", { kind: "settings" }, "/settings"],
    [
      "/projects/prj/files",
      { kind: "files", projectId: "prj", path: "" },
      "/projects/prj/files",
    ],
    [
      "/projects/prj",
      { kind: "files", projectId: "prj", path: "" },
      "/projects/prj/files",
    ],
    [
      "/projects/prj/files/src/main.rs",
      { kind: "files", projectId: "prj", path: "src/main.rs" },
      "/projects/prj/files/src/main.rs",
    ],
    [
      "/projects/project%20id/files/src%20dir/file%23.md",
      { kind: "files", projectId: "project id", path: "src dir/file#.md" },
      "/projects/project%20id/files/src%20dir/file%23.md",
    ],
    [
      "/tasks",
      { kind: "tasks", projectId: "", new: false, threadId: "", cwd: "" },
      "/tasks",
    ],
    [
      "/tasks?cwd=Workspace%2Frust%2Fgluesql",
      {
        kind: "tasks",
        projectId: "",
        new: false,
        threadId: "",
        cwd: "Workspace/rust/gluesql",
      },
      "/tasks?cwd=Workspace%2Frust%2Fgluesql",
    ],
    [
      "/tasks?cwd=.",
      { kind: "tasks", projectId: "", new: false, threadId: "", cwd: "." },
      "/tasks?cwd=.",
    ],
    [
      "/tasks/new",
      { kind: "tasks", projectId: "", new: true, threadId: "", cwd: "" },
      "/tasks/new",
    ],
    [
      "/tasks/new?cwd=src",
      { kind: "tasks", projectId: "", new: true, threadId: "", cwd: "src" },
      "/tasks/new?cwd=src",
    ],
    [
      "/tasks/thread%201",
      { kind: "tasks", projectId: "", new: false, threadId: "thread 1", cwd: "" },
      "/tasks/thread%201",
    ],
    [
      "/tasks/thread%201?cwd=src",
      { kind: "tasks", projectId: "", new: false, threadId: "thread 1", cwd: "src" },
      "/tasks/thread%201?cwd=src",
    ],
    [
      "/projects/prj/tasks",
      { kind: "tasks", projectId: "prj", new: false, threadId: "", cwd: "" },
      "/projects/prj/tasks",
    ],
    [
      "/projects/prj/tasks/new",
      { kind: "tasks", projectId: "prj", new: true, threadId: "", cwd: "" },
      "/projects/prj/tasks/new",
    ],
    [
      "/projects/prj/tasks/task%201",
      { kind: "tasks", projectId: "prj", new: false, threadId: "task 1", cwd: "" },
      "/projects/prj/tasks/task%201",
    ],
    [
      "/files?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
      {
        kind: "files",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        path: "core/src/lib.rs",
      },
      "/files?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
    ],
    [
      "/git/diff?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
      {
        kind: "diff",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        path: "core/src/lib.rs",
      },
      "/git/diff?cwd=Workspace%2Frust%2Fgluesql&file=core%2Fsrc%2Flib.rs",
    ],
    [
      "/git/compare?cwd=Workspace%2Frust%2Fgluesql&base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
      {
        kind: "compare",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        baseRef: "origin/main",
        headRef: "feature/x",
        path: "src/lib.rs",
      },
      "/git/compare?cwd=Workspace%2Frust%2Fgluesql&base=origin%2Fmain&head=feature%2Fx&file=src%2Flib.rs",
    ],
    [
      "/git/log?cwd=Workspace%2Frust%2Fgluesql&page=2&sha=abcdef&file=src%2Flib.rs",
      {
        kind: "log",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        page: 2,
        sha: "abcdef",
        path: "src/lib.rs",
      },
      "/git/log?cwd=Workspace%2Frust%2Fgluesql&page=2&sha=abcdef&file=src%2Flib.rs",
    ],
    [
      "/github/issues?cwd=Workspace%2Frust%2Fgluesql&page=2",
      {
        kind: "issues",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        page: 2,
        number: null,
      },
      "/github/issues?cwd=Workspace%2Frust%2Fgluesql&page=2",
    ],
    [
      "/github/issues/42?cwd=Workspace%2Frust%2Fgluesql",
      {
        kind: "issues",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        page: 1,
        number: 42,
      },
      "/github/issues/42?cwd=Workspace%2Frust%2Fgluesql",
    ],
    [
      "/github/pulls/12/files?cwd=Workspace%2Frust%2Fgluesql&page=2&file=src%2Flib.rs",
      {
        kind: "pulls",
        projectId: "",
        cwd: "Workspace/rust/gluesql",
        page: 2,
        number: 12,
        files: true,
        path: "src/lib.rs",
      },
      "/github/pulls/12/files?cwd=Workspace%2Frust%2Fgluesql&page=2&file=src%2Flib.rs",
    ],
    [
      "/projects/prj/diff/src/lib.rs",
      { kind: "diff", projectId: "prj", path: "src/lib.rs" },
      "/projects/prj/diff/src/lib.rs",
    ],
    [
      "/projects/prj/compare/src/lib.rs?base=origin%2Fmain&head=feature%2Fx",
      {
        kind: "compare",
        projectId: "prj",
        baseRef: "origin/main",
        headRef: "feature/x",
        path: "src/lib.rs",
      },
      "/projects/prj/compare/src/lib.rs?base=origin%2Fmain&head=feature%2Fx",
    ],
    [
      "/projects/prj/log?page=2",
      { kind: "log", projectId: "prj", page: 2, sha: "", path: "" },
      "/projects/prj/log?page=2",
    ],
    [
      "/projects/prj/log/abcdef/src/lib.rs?page=2",
      { kind: "log", projectId: "prj", page: 2, sha: "abcdef", path: "src/lib.rs" },
      "/projects/prj/log/abcdef/src/lib.rs?page=2",
    ],
    [
      "/projects/prj/issues?page=2",
      { kind: "issues", projectId: "prj", page: 2, number: null },
      "/projects/prj/issues?page=2",
    ],
    [
      "/projects/prj/issues/42?page=2",
      { kind: "issues", projectId: "prj", page: 2, number: 42 },
      "/projects/prj/issues/42?page=2",
    ],
    [
      "/projects/prj/pulls?page=2",
      {
        kind: "pulls",
        projectId: "prj",
        page: 2,
        number: null,
        files: false,
        path: "",
      },
      "/projects/prj/pulls?page=2",
    ],
    [
      "/projects/prj/pulls/12?page=2",
      {
        kind: "pulls",
        projectId: "prj",
        page: 2,
        number: 12,
        files: false,
        path: "",
      },
      "/projects/prj/pulls/12?page=2",
    ],
    [
      "/projects/prj/pulls/12/files/src/lib.rs?page=2",
      {
        kind: "pulls",
        projectId: "prj",
        page: 2,
        number: 12,
        files: true,
        path: "src/lib.rs",
      },
      "/projects/prj/pulls/12/files/src/lib.rs?page=2",
    ],
  ];

  for (const [url, expectedRoute, expectedCanonicalUrl] of cases) {
    const route = parseRoute(url);
    assert.deepEqual(route, expectedRoute);
    assert.equal(routeUrl(route), expectedCanonicalUrl);
  }
});

test("omits default page and empty compare query parameters", () => {
  assert.equal(
    routeUrl({ kind: "log", projectId: "prj", page: 1, sha: "", path: "" }),
    "/projects/prj/log",
  );
  assert.equal(
    routeUrl({ kind: "issues", projectId: "prj", page: 1, number: null }),
    "/projects/prj/issues",
  );
  assert.equal(
    routeUrl({
      kind: "compare",
      projectId: "prj",
      baseRef: "",
      headRef: "",
      path: "",
    }),
    "/projects/prj/compare",
  );
});

test("derives deterministic parent routes", () => {
  const cases = [
    ["/settings", null],
    ["/projects/prj/files/src/lib.rs", "/projects/prj/files/src"],
    ["/projects/prj/files/src", "/projects/prj/files"],
    ["/projects/prj/files", null],
    ["/projects/prj/tasks/new", "/projects/prj/tasks"],
    ["/projects/prj/tasks/task1", "/projects/prj/tasks"],
    ["/projects/prj/tasks", "/projects/prj/files"],
    ["/tasks/new", "/tasks"],
    ["/tasks/task1", "/tasks"],
    ["/tasks/new?cwd=src", "/tasks?cwd=src"],
    ["/tasks/task1?cwd=src", "/tasks?cwd=src"],
    ["/tasks", null],
    [
      "/files?cwd=Workspace%2Frust%2Fgluesql&file=src%2Flib.rs",
      "/files?cwd=Workspace%2Frust%2Fgluesql",
    ],
    [
      "/git/diff?cwd=Workspace%2Frust%2Fgluesql&file=src%2Flib.rs",
      "/git/diff?cwd=Workspace%2Frust%2Fgluesql",
    ],
    [
      "/git/diff?cwd=Workspace%2Frust%2Fgluesql",
      "/files?cwd=Workspace%2Frust%2Fgluesql",
    ],
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
    ["/github/issues/42?cwd=repo", "/github/issues?cwd=repo"],
    ["/github/issues?cwd=repo&page=2", "/files?cwd=repo"],
    [
      "/github/pulls/12/files?cwd=repo&page=2&file=src%2Flib.rs",
      "/github/pulls/12/files?cwd=repo&page=2",
    ],
    ["/github/pulls/12/files?cwd=repo&page=2", "/github/pulls/12?cwd=repo"],
    ["/github/pulls/12?cwd=repo", "/github/pulls?cwd=repo"],
    ["/github/pulls?cwd=repo&page=2", "/files?cwd=repo"],
    ["/projects/prj/diff/src/lib.rs", "/projects/prj/diff"],
    ["/projects/prj/diff", "/projects/prj/files"],
    [
      "/projects/prj/compare/src/lib.rs?base=main&head=feature",
      "/projects/prj/compare?base=main&head=feature",
    ],
    ["/projects/prj/compare?base=main&head=feature", "/projects/prj/files"],
    ["/projects/prj/log/abcdef/src/lib.rs?page=2", "/projects/prj/log/abcdef?page=2"],
    ["/projects/prj/log/abcdef?page=2", "/projects/prj/log?page=2"],
    ["/projects/prj/log?page=2", "/projects/prj/files"],
    ["/projects/prj/issues/42?page=2", "/projects/prj/issues?page=2"],
    ["/projects/prj/issues?page=2", "/projects/prj/files"],
    ["/projects/prj/pulls/12/files/src/lib.rs?page=2", "/projects/prj/pulls/12/files?page=2"],
    ["/projects/prj/pulls/12/files?page=2", "/projects/prj/pulls/12?page=2"],
    ["/projects/prj/pulls/12?page=2", "/projects/prj/pulls?page=2"],
    ["/projects/prj/pulls?page=2", "/projects/prj/files"],
  ];

  for (const [url, expectedParentUrl] of cases) {
    const parent = parentRoute(parseRoute(url));
    assert.equal(parent ? routeUrl(parent) : null, expectedParentUrl);
  }
});

test("exposes route metadata for surface and domain routing", () => {
  const cases = [
    ["/settings", "settings", null, "settings", "page"],
    ["/projects/prj/files", "files", null, "files", "list"],
    ["/projects/prj/files/src/lib.rs", "files", null, "files", "path"],
    ["/projects/prj/tasks", "tasks", null, "tasks", "list"],
    ["/projects/prj/tasks/new", "tasks", null, "tasks", "new"],
    ["/projects/prj/tasks/task1", "tasks", null, "tasks", "detail"],
    ["/tasks", "tasks", null, "tasks", "list"],
    ["/tasks/new", "tasks", null, "tasks", "new"],
    ["/tasks/task1", "tasks", null, "tasks", "detail"],
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
    ["/projects/prj/diff", "review", "git", "diff", "list"],
    ["/projects/prj/diff/src/lib.rs", "review", "git", "diff", "file"],
    ["/projects/prj/compare?base=main&head=feature", "review", "git", "compare", "list"],
    [
      "/projects/prj/compare/src/lib.rs?base=main&head=feature",
      "review",
      "git",
      "compare",
      "file",
    ],
    ["/projects/prj/log", "review", "git", "log", "list"],
    ["/projects/prj/log/abcdef", "review", "git", "log", "commit"],
    ["/projects/prj/log/abcdef/src/lib.rs", "review", "git", "log", "file"],
    ["/projects/prj/issues/42", "review", "github", "issues", "detail"],
    ["/projects/prj/pulls/12", "review", "github", "pulls", "detail"],
    ["/projects/prj/pulls/12/files", "review", "github", "pulls", "files"],
    ["/projects/prj/pulls/12/files/src/lib.rs", "review", "github", "pulls", "file"],
  ];

  for (const [url, expectedSurface, expectedDomain, expectedMode, expectedTarget] of cases) {
    const route = parseRoute(url);
    assert.equal(routeSurface(route), expectedSurface);
    assert.equal(routeDomain(route), expectedDomain);
    assert.equal(routeMode(route), expectedMode);
    assert.equal(routeTarget(route), expectedTarget);
  }

  assert.equal(routeSurface(null), "files");
  assert.equal(routeDomain(null), null);
  assert.equal(routeMode({ kind: "unknown" }), null);
  assert.equal(routeTarget({ kind: "unknown" }), null);
});

test("derives route metadata from partial route objects", () => {
  const cases = [
    [{ kind: "settings" }, "settings", null, "settings", "page"],
    [{ kind: "files", path: "" }, "files", null, "files", "list"],
    [{ kind: "files", path: "src/lib.rs" }, "files", null, "files", "path"],
    [{ kind: "tasks", new: false, threadId: "" }, "tasks", null, "tasks", "list"],
    [{ kind: "tasks", new: true, threadId: "" }, "tasks", null, "tasks", "new"],
    [{ kind: "tasks", new: false, threadId: "task1" }, "tasks", null, "tasks", "detail"],
    [{ kind: "diff", path: "" }, "review", "git", "diff", "list"],
    [{ kind: "diff", path: "src/lib.rs" }, "review", "git", "diff", "file"],
    [{ kind: "compare", path: "" }, "review", "git", "compare", "list"],
    [{ kind: "compare", path: "src/lib.rs" }, "review", "git", "compare", "file"],
    [{ kind: "log", page: 1, sha: "", path: "" }, "review", "git", "log", "list"],
    [{ kind: "log", page: 1, sha: "abcdef", path: "" }, "review", "git", "log", "commit"],
    [{ kind: "log", page: 1, sha: "abcdef", path: "src/lib.rs" }, "review", "git", "log", "file"],
    [{ kind: "issues", page: 1, number: null }, "review", "github", "issues", "list"],
    [{ kind: "issues", page: 1, number: 42 }, "review", "github", "issues", "detail"],
    [
      { kind: "pulls", page: 1, number: null, files: false, path: "" },
      "review",
      "github",
      "pulls",
      "list",
    ],
    [
      { kind: "pulls", page: 1, number: 12, files: false, path: "" },
      "review",
      "github",
      "pulls",
      "detail",
    ],
    [
      { kind: "pulls", page: 1, number: 12, files: true, path: "" },
      "review",
      "github",
      "pulls",
      "files",
    ],
    [
      { kind: "pulls", page: 1, number: 12, files: true, path: "src/lib.rs" },
      "review",
      "github",
      "pulls",
      "file",
    ],
  ];

  for (const [route, expectedSurface, expectedDomain, expectedMode, expectedTarget] of cases) {
    assert.equal(routeSurface(route), expectedSurface);
    assert.equal(routeDomain(route), expectedDomain);
    assert.equal(routeMode(route), expectedMode);
    assert.equal(routeTarget(route), expectedTarget);
  }
});

test("rejects unknown app routes and keeps malformed segments non-fatal", () => {
  assert.equal(parseRoute("/"), null);
  assert.equal(parseRoute("/api/health"), null);
  assert.equal(parseRoute("/projects"), null);
  assert.equal(parseRoute("/projects/prj/unknown"), null);
  assert.equal(parseRoute("/projects/prj/issues/not-a-number"), null);
  assert.equal(parseRoute("/projects/prj/pulls/not-a-number"), null);
  assert.equal(parseRoute("/github/issues/not-a-number"), null);
  assert.equal(parseRoute("/github/pulls/not-a-number"), null);

  assert.deepEqual(parseRoute("/projects/prj/files/%E0%A4%A"), {
    kind: "files",
    projectId: "prj",
    path: "%E0%A4%A",
  });
});

test("compares routes by canonical URL", () => {
  assert.equal(
    routeEquals(
      { kind: "issues", projectId: "prj", page: 1, number: null },
      parseRoute("/projects/prj/issues"),
    ),
    true,
  );
  assert.equal(
    routeEquals(
      { kind: "issues", projectId: "prj", page: 2, number: null },
      parseRoute("/projects/prj/issues"),
    ),
    false,
  );
});
