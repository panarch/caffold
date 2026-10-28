// Unit tests run from tests/unit-build/, which has no stylesheet modules. A
// `name.css.js` import there loads the module the build writes from
// frontend/name.css, and `CSSStyleSheet`, which Node lacks, stands in as a
// sheet that keeps the text it is given as one rule, unless a test supplies
// its own.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const buildRoot = new URL("../unit-build/", import.meta.url).href;
const frontendRoot = new URL("../../", import.meta.url).href;
// Node resolves an alias such as `#app/` only to a file that exists, and no
// stylesheet module does, so the hook resolves the aliases itself.
const aliases = Object.entries(
  JSON.parse(readFileSync(new URL("package.json", frontendRoot), "utf8")).imports,
).map(([alias, target]) => [alias.slice(0, -1), new URL(target.slice(0, -1), buildRoot).href]);

globalThis.CSSStyleSheet ??= class CSSStyleSheet {
  cssRules = [];

  replaceSync(text) {
    this.text = text;
    this.cssRules = [{ cssText: text }];
  }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(".css.js")) {
      return nextResolve(specifier, context);
    }
    const [alias, target] = aliases.find(([alias]) => specifier.startsWith(alias)) ?? [];
    const url = alias
      ? new URL(specifier.slice(alias.length), target)
      : new URL(specifier, context.parentURL);
    return { url: url.href, shortCircuit: true };
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
