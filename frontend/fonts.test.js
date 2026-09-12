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

async function readFontFaces() {
  const stylesheet = await readFile(
    new URL("./styles.css", import.meta.url),
    "utf8",
  );
  return [...stylesheet.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(
    ([, body]) => body,
  );
}

function bundledFamily(preset) {
  const [family] = preset.stack.split(", ");
  return family.startsWith('"') ? family : null;
}

function assertBundledFile(face, family) {
  const [, file] = face.match(/url\("\.\/fonts\/([^"]+)"\)/);
  assert.ok(
    existsSync(new URL(`./assets/fonts/${file}`, import.meta.url)),
    `${family} names ${file}, which is not bundled`,
  );
}

test("defines an interface and a code registry with separate defaults", async () => {
  const {
    CODE_TYPEFACE_PRESETS,
    DEFAULT_CODE_TYPEFACE_PRESET,
    DEFAULT_UI_TYPEFACE_PRESET,
    UI_TYPEFACE_PRESETS,
  } = await importFreshFonts("registry");

  assert.equal(DEFAULT_UI_TYPEFACE_PRESET, "geist-sans");
  assert.equal(DEFAULT_CODE_TYPEFACE_PRESET, "geist-mono");
  assert.deepEqual(Object.keys(UI_TYPEFACE_PRESETS), [
    "geist-sans",
    "inter",
    "pretendard",
    "system",
  ]);
  assert.deepEqual(Object.keys(CODE_TYPEFACE_PRESETS), [
    "d2-coding",
    "0xproto",
    "geist-mono",
    "ibm-plex-mono",
    "jetbrains-mono",
    "monaspace-neon",
    "system-mono",
  ]);
  assert.equal(UI_TYPEFACE_PRESETS["system"].stack, "system-ui, sans-serif");
  assert.equal(
    CODE_TYPEFACE_PRESETS["system-mono"].stack,
    "ui-monospace, monospace",
  );
  for (const presets of [UI_TYPEFACE_PRESETS, CODE_TYPEFACE_PRESETS]) {
    for (const preset of Object.values(presets)) {
      assert.equal("description" in preset, false);
    }
  }
});

test("normalizes each axis to its own registry", async () => {
  const { normalizeCodeTypefacePreset, normalizeUiTypefacePreset } =
    await importFreshFonts("normalize");

  assert.equal(normalizeUiTypefacePreset("pretendard"), "pretendard");
  assert.equal(normalizeCodeTypefacePreset("d2-coding"), "d2-coding");
  assert.equal(normalizeUiTypefacePreset("unknown"), "geist-sans");
  assert.equal(normalizeCodeTypefacePreset("unknown"), "geist-mono");
  assert.equal(normalizeUiTypefacePreset("d2-coding"), "geist-sans");
  assert.equal(normalizeCodeTypefacePreset("pretendard"), "geist-mono");
});

test("backs every bundled interface preset with one variable face", async () => {
  const { UI_TYPEFACE_PRESETS } = await importFreshFonts("ui-faces");
  const faces = await readFontFaces();

  for (const preset of Object.values(UI_TYPEFACE_PRESETS)) {
    const family = bundledFamily(preset);
    if (!family) {
      continue;
    }

    const matching = faces.filter((body) =>
      body.includes(`font-family: ${family};`),
    );
    assert.equal(matching.length, 1, `${family} needs exactly one @font-face`);
    assert.match(
      matching[0],
      /font-weight: \d+ \d+;/,
      `${family} must declare a weight range`,
    );
    assertBundledFile(matching[0], family);
  }
});

test("backs every bundled code preset with static regular and bold faces", async () => {
  const { CODE_TYPEFACE_PRESETS } = await importFreshFonts("code-faces");
  const faces = await readFontFaces();

  for (const preset of Object.values(CODE_TYPEFACE_PRESETS)) {
    const family = bundledFamily(preset);
    if (!family) {
      continue;
    }

    for (const weight of ["400", "700"]) {
      const face = faces.find(
        (body) =>
          body.includes(`font-family: ${family};`) &&
          body.includes(`font-weight: ${weight};`),
      );
      assert.ok(face, `${family} is missing a ${weight} @font-face`);
      assertBundledFile(face, family);
    }
  }
});

test("applies each axis to its own token without touching the other", async () => {
  const { applyCodeTypefacePreset, applyUiTypefacePreset } =
    await importFreshFonts("roles");
  const properties = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (name, value) => properties.set(name, value),
    },
  };

  applyUiTypefacePreset("pretendard", root);

  assert.deepEqual([...properties.keys()], ["--font-ui"]);
  assert.equal(
    properties.get("--font-ui"),
    '"Caffold Pretendard", system-ui, sans-serif',
  );
  assert.equal(root.dataset.uiTypefacePreset, "pretendard");
  assert.equal(root.dataset.codeTypefacePreset, undefined);

  applyCodeTypefacePreset("system-mono", root);

  assert.equal(properties.get("--font-code"), "ui-monospace, monospace");
  assert.equal(properties.get("--font-ui"), '"Caffold Pretendard", system-ui, sans-serif');
  assert.equal(root.dataset.codeTypefacePreset, "system-mono");
});
