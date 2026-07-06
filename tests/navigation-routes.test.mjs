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
    ["/projects/prj/files/src/lib.rs", "/projects/prj/files/src"],
    ["/projects/prj/files/src", "/projects/prj/files"],
    ["/projects/prj/files", null],
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
    ["/projects/prj/files", "files", null, "files", "list"],
    ["/projects/prj/files/src/lib.rs", "files", null, "files", "path"],
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

test("rejects unknown app routes and keeps malformed segments non-fatal", () => {
  assert.equal(parseRoute("/"), null);
  assert.equal(parseRoute("/api/health"), null);
  assert.equal(parseRoute("/projects"), null);
  assert.equal(parseRoute("/projects/prj/unknown"), null);
  assert.equal(parseRoute("/projects/prj/issues/not-a-number"), null);
  assert.equal(parseRoute("/projects/prj/pulls/not-a-number"), null);

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
