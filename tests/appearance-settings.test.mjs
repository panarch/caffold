import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}

test("appearance settings assets stay in the application shell", () => {
  assert.match(readFrontend("app.js"), /import "\.\/settings\.js";/);
  assert.match(
    readFrontend("styles.css"),
    /@import "\.\/pages\/settings\/page\.css";/,
  );

  const serviceWorker = readFrontend("service-worker.js");
  assert.match(serviceWorker, /"\/assets\/settings\.js"/);
  assert.match(serviceWorker, /"\/assets\/pages\/settings\/page\.js"/);
  assert.match(serviceWorker, /"\/assets\/pages\/settings\/page\.css"/);
});
