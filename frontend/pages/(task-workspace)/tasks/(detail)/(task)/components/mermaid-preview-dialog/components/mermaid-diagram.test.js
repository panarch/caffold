import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { setImmediate } from "node:timers/promises";

import { elementStandIn, installCustomElementUnitRegistry } from "../../../../../../../../tests/support/custom-element-unit.js";

// The diagram loads Mermaid from jsDelivr when it first draws. This stand-in
// answers that address, so each test decides when the library arrives and
// when and how each render settles.
const MERMAID_ADDRESS = "https://cdn.jsdelivr.net/npm/mermaid@12.3.0/dist/mermaid.esm.min.mjs";
const library = { failingLoads: 0, addresses: [], configs: [], fontLoads: [], renders: [] };
globalThis.mermaidStandIn = {
  initialize: (config) => library.configs.push(config),
  render: (id, source) =>
    new Promise((resolve, reject) => library.renders.push({ id, source, resolve, reject })),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.startsWith(MERMAID_ADDRESS)
      ? { url: specifier, shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith(MERMAID_ADDRESS)) {
      return nextLoad(url, context);
    }
    library.addresses.push(url);
    if (library.failingLoads > 0) {
      library.failingLoads -= 1;
      throw new Error("Failed to fetch Mermaid");
    }
    return { format: "module", source: "export default globalThis.mermaidStandIn;", shortCircuit: true };
  },
});

const registry = installCustomElementUnitRegistry();
globalThis.document.fonts = {
  load: async (font, text) => {
    library.fontLoads.push([font, text]);
    return [];
  },
};
await import("./mermaid-diagram.js");
const { applyThemeMode, getThemeState } = await import("#app/theme.js");
const { getSettings } = await import("#app/settings.js");
const { UI_TYPEFACE_PRESETS } = await import("#app/fonts.js");
const prototype = registry.element("caffold-task-mermaid-diagram").prototype;
after(() => registry.restore());

function diagram() {
  return elementStandIn(prototype, {
    source: "flowchart LR\nA --> B", active: true, isConnected: true,
    renderState: { kind: "inactive", result: null },
  });
}

// Renders run one after another through module loading and promise steps,
// so a test waits for the exact signal it needs, within a bound.
async function until(check) {
  for (let turn = 0; turn < 100 && !check(); turn += 1) {
    await setImmediate();
  }
  assert.ok(check(), "the awaited render step did not happen");
}

// Runs first: the library is loaded once for the page and kept afterwards.
test("asks for a library that failed to arrive again under a new address", async () => {
  library.failingLoads = 1;
  const owner = diagram();
  owner.transition({ type: "input" });
  await until(() => owner.renderState.kind === "error");
  assert.equal(owner.renderState.message, "Failed to fetch Mermaid");
  assert.equal(library.renders.length, 0);

  owner.transition({ type: "retry" });
  await until(() => library.renders.length === 1);
  assert.deepEqual(library.addresses, [MERMAID_ADDRESS, `${MERMAID_ADDRESS}#retry-1`]);
  library.renders[0].resolve({ svg: "<svg>recovered</svg>" });
  await until(() => owner.renderState.kind === "ready");
  assert.equal(owner.renderState.result.svg, "<svg>recovered</svg>");
  library.renders.length = 0;
});

test("same input is a no-op and a closed dialog keeps only the current diagram", async () => {
  const owner = diagram();
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "pending");
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 1);
  library.renders[0].resolve({ svg: "<svg>current</svg>" });
  await until(() => owner.renderState.kind === "ready");
  const result = owner.renderState.result;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.result, result);
  owner.active = false;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "inactive");
  assert.equal(owner.renderState.result, result);
  owner.active = true;
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "ready");
  assert.equal(owner.renderState.result, result);
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "pending");
  await until(() => library.renders.length === 2);
  assert.equal(library.renders[1].source, "flowchart LR\nA --> B\nB --> C");
  library.renders[1].resolve({ svg: "<svg>next</svg>" });
  await until(() => owner.renderState.kind === "ready");
  library.renders.length = 0;
});

test("draws one render at a time, and only the current one is shown", async () => {
  const owner = diagram();
  owner.transition({ type: "input" });
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 1);
  await setImmediate();
  assert.equal(library.renders.length, 1);
  library.renders[0].resolve({ svg: "<svg>old</svg>" });
  await until(() => library.renders.length === 2);
  assert.equal(owner.renderState.kind, "pending");
  assert.notEqual(library.renders[0].id, library.renders[1].id);

  owner.isConnected = false;
  owner.transition({ type: "input" });
  library.renders[1].reject(new Error("late error"));
  await setImmediate();
  assert.deepEqual(owner.renderState, { kind: "inactive", result: null });

  owner.isConnected = true;
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 3);
  library.renders[2].resolve({ svg: "<svg>new</svg>" });
  await until(() => owner.renderState.kind === "ready");
  assert.equal(owner.renderState.result.svg, "<svg>new</svg>");
  library.renders.length = 0;
});

test("errors stay local, reject unchanged input, and retry or recover on new input", async () => {
  const owner = diagram();
  owner.transition({ type: "retry" });
  assert.equal(owner.renderState.kind, "inactive");
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 1);
  library.renders[0].reject(new Error("Parse error on line 2"));
  await until(() => owner.renderState.kind === "error");
  assert.equal(owner.renderState.message, "Parse error on line 2");
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "error");
  owner.transition({ type: "retry" });
  await until(() => library.renders.length === 2);
  library.renders[1].reject(new Error("offline"));
  await until(() => owner.renderState.kind === "error" && owner.renderState.message === "offline");
  owner.source += "\nB --> C";
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 3);
  library.renders[2].resolve({ svg: "<svg>recovered</svg>" });
  await until(() => owner.renderState.kind === "ready");
  assert.equal(owner.renderState.result.svg, "<svg>recovered</svg>");
  library.renders.length = 0;
});

test("applies the theme and fonts just before each render, after the fonts load", async () => {
  const settings = getSettings();
  const fontFamily = UI_TYPEFACE_PRESETS[settings.uiTypefacePreset].stack;
  const fontSize = settings.conversationTextPx;
  applyThemeMode("light");
  library.configs.length = 0;
  library.fontLoads.length = 0;
  const owner = diagram();
  owner.transition({ type: "input" });
  await until(() => library.renders.length === 1);
  assert.deepEqual(library.fontLoads, [[`${fontSize}px ${fontFamily}`, owner.source]]);
  assert.deepEqual(library.configs, [{
    startOnLoad: false,
    theme: "default",
    fontFamily,
    themeVariables: { fontFamily, fontSize: `${fontSize}px` },
    suppressErrorRendering: true,
  }]);
  library.renders[0].resolve({ svg: "<svg>light</svg>" });
  await until(() => owner.renderState.kind === "ready");

  applyThemeMode("dark");
  assert.equal(getThemeState().resolvedTheme, "dark");
  owner.transition({ type: "input" });
  assert.equal(owner.renderState.kind, "pending");
  await until(() => library.renders.length === 2);
  assert.equal(library.configs[1].theme, "dark");
  library.renders[1].resolve({ svg: "<svg>dark</svg>" });
  await until(() => owner.renderState.kind === "ready");
  assert.equal(owner.renderState.result.svg, "<svg>dark</svg>");
  applyThemeMode("light");
  library.renders.length = 0;
});
