import assert from "node:assert/strict";
import test from "node:test";

let environmentId = 0;

test("a shadow root takes one sheet per target and refuses anything but a local class path", async (t) => {
  const { scopedStyle, style } = await styleEnvironment(t);
  const button = scopedStyle(style, ".pagination-button");
  assert.equal(scopedStyle(style, ".pagination-button"), button);
  assert.notEqual(scopedStyle(style, ".is-refreshing .refresh-icon"), button);
  assert.match(
    button.text,
    /^@layer component-styles \{\s*@scope \(\.pagination-button\) \{\s*:scope \{ display: grid; \}/,
  );
  assert.match(
    scopedStyle(style, "button.is-refreshing > span > .refresh-icon").text,
    /^@layer component-styles \{\s*@scope \(button\.is-refreshing > span > \.refresh-icon\) \{/,
  );
  for (const target of [
    "> .button",
    ".button, button",
    ".button) {}",
    "caffold-child .button",
    ".panel button",
  ])
    assert.throws(() => scopedStyle(style, target), /class path/);
});

test("each shared style keeps its own sheets", async (t) => {
  const { scopedStyle, style } = await styleEnvironment(t);
  const other = new CSSStyleSheet();
  other.replaceSync(":scope { animation: none; }");
  const first = scopedStyle(style, ".button");
  const second = scopedStyle(other, ".button");
  assert.notEqual(first, second);
  assert.match(second.text, /:scope \{ animation: none; \}/);
});

async function styleEnvironment(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "CSSStyleSheet");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "CSSStyleSheet", original);
    else delete globalThis.CSSStyleSheet;
  });
  // A sheet keeps its text, and its one rule is that text.
  globalThis.CSSStyleSheet = class {
    cssRules = [];

    replaceSync(text) {
      this.text = text;
      this.cssRules = [{ cssText: text }];
    }
  };
  const style = new CSSStyleSheet();
  style.replaceSync(":scope { display: grid; }");
  return {
    ...(await import(`./scoped-style.js?environment=${++environmentId}`)),
    style,
  };
}
