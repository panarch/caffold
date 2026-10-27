import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const frontendUrl = new URL("../../", import.meta.url);
const fontsUrl = new URL("assets/fonts/", frontendUrl);

function bundledFiles(suffix) {
  return readdirSync(fontsUrl).filter((name) => name.endsWith(suffix));
}

test("bundled font files remain explicit shell assets", () => {
  const serviceWorker = readFileSync(
    new URL("service-worker.ts", frontendUrl),
    "utf8",
  );
  const faces = bundledFiles(".woff2");

  assert.ok(faces.length > 0, "expected bundled woff2 faces");
  for (const name of faces) {
    assert.equal(
      readFileSync(new URL(name, fontsUrl)).subarray(0, 4).toString(),
      "wOF2",
      `${name} must be a woff2 face`,
    );
    assert.ok(
      serviceWorker.includes(`/assets/fonts/${name}`),
      `${name} must stay in the app shell asset inventory`,
    );
  }

  for (const name of bundledFiles("-OFL.txt")) {
    assert.match(
      readFileSync(new URL(name, fontsUrl), "utf8"),
      /SIL OPEN FONT LICENSE Version 1\.1/i,
      `${name} must carry the SIL Open Font License 1.1`,
    );
  }

  // Precaching is covered by the service-worker asset inventory; what is only
  // checked here is that these stay ordinary shell assets rather than moving to
  // a separate font cache with its own strategy.
  assert.doesNotMatch(serviceWorker, /caffold-fonts|OPTIONAL_FONT|cacheFirst/);
});
