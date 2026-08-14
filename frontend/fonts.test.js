import assert from "node:assert/strict";
import test from "node:test";

const moduleUrl = new URL("./fonts.js", import.meta.url);

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
