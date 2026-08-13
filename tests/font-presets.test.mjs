import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../frontend/fonts.js", import.meta.url);
const frontendUrl = new URL("../frontend/", import.meta.url);

async function importFreshFonts(label) {
  const url = new URL(moduleUrl);
  url.searchParams.set("test", `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("defines the bundled default and system fallback presets", async () => {
  const { DEFAULT_TYPEFACE_PRESET, TYPEFACE_PRESETS, normalizeTypefacePreset } =
    await importFreshFonts("registry");

  assert.equal(DEFAULT_TYPEFACE_PRESET, "d2-coding");
  assert.deepEqual(Object.keys(TYPEFACE_PRESETS), ["d2-coding", "system-mono"]);
  assert.equal(TYPEFACE_PRESETS["d2-coding"].label, "D2 Coding");
  assert.equal(TYPEFACE_PRESETS["system-mono"].label, "System Mono");
  assert.equal("description" in TYPEFACE_PRESETS["d2-coding"], false);
  assert.equal("description" in TYPEFACE_PRESETS["system-mono"], false);
  assert.equal(
    normalizeTypefacePreset("noto-sans-mono-cjk-kr"),
    "d2-coding",
  );
  assert.equal(normalizeTypefacePreset("unknown"), "d2-coding");
});

test("applies UI and code roles together without collapsing their tokens", async () => {
  const { applyTypefacePreset } = await importFreshFonts("roles");
  const properties = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (name, value) => properties.set(name, value),
    },
  };

  applyTypefacePreset("system-mono", root);

  assert.equal(properties.get("--font-ui"), "ui-monospace, monospace");
  assert.equal(properties.get("--font-code"), "ui-monospace, monospace");
  assert.equal(root.dataset.typefacePreset, "system-mono");
});

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
