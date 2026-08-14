import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../frontend/", import.meta.url);

test("bundled D2 Coding files remain explicit shell assets", () => {
  const regular = readFileSync(
    new URL("assets/fonts/D2Coding-Regular.woff2", frontendUrl),
  );
  const bold = readFileSync(new URL("assets/fonts/D2Coding-Bold.woff2", frontendUrl));
  const license = readFileSync(
    new URL("assets/fonts/D2Coding-OFL.txt", frontendUrl),
    "utf8",
  );
  const serviceWorker = readFileSync(new URL("service-worker.js", frontendUrl), "utf8");

  assert.equal(regular.subarray(0, 4).toString(), "wOF2");
  assert.equal(bold.subarray(0, 4).toString(), "wOF2");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/i);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Regular\.woff2"/);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Bold\.woff2"/);
  assert.doesNotMatch(serviceWorker, /caffold-fonts|OPTIONAL_FONT|cacheFirst/);
});
