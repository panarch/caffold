import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("./fonts.js", import.meta.url);

async function importFreshFonts(label) {
  const url = new URL(moduleUrl);
  url.searchParams.set("test", `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("defines the bundled presets and the system fallback", async () => {
  const { DEFAULT_TYPEFACE_PRESET, TYPEFACE_PRESETS, normalizeTypefacePreset } =
    await importFreshFonts("registry");

  assert.equal(DEFAULT_TYPEFACE_PRESET, "d2-coding");
  assert.deepEqual(Object.keys(TYPEFACE_PRESETS), [
    "d2-coding",
    "0xproto",
    "geist-mono",
    "ibm-plex-mono",
    "jetbrains-mono",
    "monaspace-neon",
    "system-mono",
  ]);
  assert.equal(TYPEFACE_PRESETS["d2-coding"].label, "D2 Coding");
  assert.equal(TYPEFACE_PRESETS["system-mono"].label, "System Mono");
  for (const preset of Object.values(TYPEFACE_PRESETS)) {
    assert.equal("description" in preset, false);
  }
  assert.equal(
    normalizeTypefacePreset("noto-sans-mono-cjk-kr"),
    "d2-coding",
  );
  assert.equal(normalizeTypefacePreset("unknown"), "d2-coding");
});

test("backs every bundled preset with font faces and bundled files", async () => {
  const { TYPEFACE_PRESETS } = await importFreshFonts("faces");
  const stylesheet = await readFile(
    new URL("./styles.css", import.meta.url),
    "utf8",
  );
  const faces = [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
    ([, body]) => body,
  );

  for (const preset of Object.values(TYPEFACE_PRESETS)) {
    const [family] = preset.stack.split(", ");
    if (!family.startsWith('"')) {
      continue;
    }

    for (const weight of ["400", "700"]) {
      const face = faces.find(
        (body) =>
          body.includes(`font-family: ${family};`) &&
          body.includes(`font-weight: ${weight};`),
      );
      assert.ok(face, `${family} is missing a ${weight} @font-face`);

      const [, file] = face.match(/url\("\.\/fonts\/([^"]+)"\)/);
      assert.ok(
        existsSync(new URL(`./assets/fonts/${file}`, import.meta.url)),
        `${file} is not bundled`,
      );
    }
  }
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
