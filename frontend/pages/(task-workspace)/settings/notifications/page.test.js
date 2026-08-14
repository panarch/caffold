import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("notification permission is requested only by the explicit Enable action", () => {
  const pagePath = fileURLToPath(new URL("./page.js", import.meta.url));
  const source = readFileSync(pagePath, "utf8");
  const enableBranch = source.slice(
    source.indexOf('if (action === "enable")'),
    source.indexOf('if (action === "disable")'),
  );
  assert.equal(source.match(/Notification\.requestPermission\(\)/g)?.length, 1);
  assert.match(enableBranch, /Notification\.requestPermission\(\)/);
});
