import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  CODE_TYPEFACE_PRESETS,
  DEFAULT_CODE_TYPEFACE_PRESET,
  DEFAULT_UI_TYPEFACE_PRESET,
  UI_TYPEFACE_PRESETS,
} from "../../fonts.js";

const frontendUrl = new URL("../../", import.meta.url);
const fontsUrl = new URL("assets/fonts/", frontendUrl);

function bundledFiles(suffix) {
  return readdirSync(fontsUrl).filter((name) => name.endsWith(suffix));
}

function facesByFamily() {
  const stylesheet = readFileSync(new URL("styles.css", frontendUrl), "utf8");
  const faces = new Map();
  for (const [, body] of stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = body.match(/font-family:\s*("[^"]+")/)?.[1];
    const file = body.match(/url\("\.\/fonts\/([^"]+)"\)/)?.[1];
    if (family && file) {
      faces.set(family, [...(faces.get(family) ?? []), file]);
    }
  }
  return faces;
}

test("bundled font files remain explicit shell assets", () => {
  const serviceWorker = readFileSync(
    new URL("service-worker.js", frontendUrl),
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

test("the index preloads exactly the faces the default presets name", () => {
  const index = readFileSync(new URL("index.html", frontendUrl), "utf8");
  const faces = facesByFamily();
  const expected = [
    UI_TYPEFACE_PRESETS[DEFAULT_UI_TYPEFACE_PRESET],
    CODE_TYPEFACE_PRESETS[DEFAULT_CODE_TYPEFACE_PRESET],
  ].flatMap((preset) => faces.get(preset.stack.split(", ")[0]) ?? []);

  assert.ok(expected.length > 0, "default presets must name bundled faces");
  assert.deepEqual(
    [...index.matchAll(/href="\/assets\/fonts\/([^"]+)"/g)].map(
      ([, name]) => name,
    ),
    expected,
  );
});
