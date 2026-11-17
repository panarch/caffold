import assert from "node:assert/strict";
import test from "node:test";

import { codeNamesFor, languageServersGettingReady } from "./code-names.js";

function server(language, extensions, state, fields = {}) {
  return { language, extensions, state, ...fields };
}

function repository(servers, { enabled = true, path = "work/app" } = {}) {
  return { path, enabled, servers };
}

test("names can be pressed in a file a ready server of the repository reads", () => {
  const repo = repository([
    server("rust", ["rs"], "ready"),
    server("typescript", ["ts", "tsx"], "starting", { progress: "Indexing 3/9" }),
  ]);

  assert.deepEqual(codeNamesFor(repo, "work/app/src/main.rs"), {
    status: "ready",
  });
  assert.deepEqual(codeNamesFor(repo, "work/app/web/page.tsx"), {
    status: "starting",
    progress: "Indexing 3/9",
  });
  assert.equal(codeNamesFor(repo, "work/app/README.md"), null);
  assert.equal(codeNamesFor(repo, "work/app/Makefile"), null);
});

test("a sleeping server reads as getting ready, and a failed or off one leaves names plain", () => {
  const repo = repository([
    server("rust", ["rs"], "sleeping"),
    server("typescript", ["ts"], "failed"),
  ]);

  assert.deepEqual(codeNamesFor(repo, "work/app/lib.rs"), {
    status: "starting",
  });
  assert.equal(codeNamesFor(repo, "work/app/lib.ts"), null);
  assert.equal(
    codeNamesFor(repository([server("rust", ["rs"], "off")]), "work/app/a.rs"),
    null,
  );
});

test("names stay plain outside the repository and where its servers are off", () => {
  const ready = [server("rust", ["rs"], "ready")];

  assert.equal(codeNamesFor(repository(ready), "work/application/a.rs"), null);
  assert.equal(codeNamesFor(repository(ready), "/opt/rust/core.rs"), null);
  assert.equal(
    codeNamesFor(repository(ready, { enabled: false }), "work/app/a.rs"),
    null,
  );
  assert.equal(codeNamesFor(null, "work/app/a.rs"), null);
  assert.equal(codeNamesFor(repository(ready), ""), null);
  assert.deepEqual(
    codeNamesFor(repository(ready, { path: "" }), "anywhere/a.rs"),
    { status: "ready" },
  );
});

test("a repository is getting ready while one of its servers starts or sleeps", () => {
  assert.equal(
    languageServersGettingReady(
      repository([server("rust", ["rs"], "ready"), server("typescript", ["ts"], "starting")]),
    ),
    true,
  );
  assert.equal(
    languageServersGettingReady(repository([server("rust", ["rs"], "sleeping")])),
    true,
  );
  assert.equal(
    languageServersGettingReady(
      repository([server("rust", ["rs"], "ready"), server("typescript", ["ts"], "failed")]),
    ),
    false,
  );
  assert.equal(
    languageServersGettingReady(
      repository([server("rust", ["rs"], "starting")], { enabled: false }),
    ),
    false,
  );
  assert.equal(languageServersGettingReady(null), false);
});
