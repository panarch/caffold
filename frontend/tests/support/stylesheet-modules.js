// Unit tests run from tests/unit-build/, which has no stylesheet modules. A
// `name.css.js` import there loads the module the build writes from
// frontend/name.css, and `CSSStyleSheet`, which Node lacks, stands in as a
// sheet that keeps the text it is given as one rule, unless a test supplies
// its own.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const buildRoot = new URL("../unit-build/", import.meta.url).href;
const frontendRoot = new URL("../../", import.meta.url).href;

globalThis.CSSStyleSheet ??= class CSSStyleSheet {
  cssRules = [];

  replaceSync(text) {
    this.text = text;
    this.cssRules = [{ cssText: text }];
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith(".css.js")
      ? { url: new URL(specifier, context.parentURL).href, shortCircuit: true }
      : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".css.js")) {
      return nextLoad(url, context);
    }
    const stylesheet = new URL(url.slice(0, -".js".length).replace(buildRoot, frontendRoot));
    const text = JSON.stringify(readFileSync(stylesheet, "utf8"));
    return {
      format: "module",
      source: `const sheet = new CSSStyleSheet();\nsheet.replaceSync(${text});\nexport default sheet;\n`,
      shortCircuit: true,
    };
  },
});
