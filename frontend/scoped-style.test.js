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
  assert.equal(document.adoptedStyleSheets.length, 0);
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

test("a Light DOM owner adopts each scope once beside the document's sheets", async (t) => {
  const { adoptScopedStyle, style } = await styleEnvironment(t);
  const previous = {};
  document.adoptedStyleSheets.push(previous);
  adoptScopedStyle(style, "caffold-one", "> .button");
  adoptScopedStyle(style, "caffold-one", ">   .button");
  adoptScopedStyle(style, "caffold-two", "> .panel > header > .actions > .button");
  assert.equal(document.adoptedStyleSheets.length, 3);
  assert.equal(document.adoptedStyleSheets[0], previous);
  assert.match(
    document.adoptedStyleSheets[2].text,
    /@scope \(caffold-two > \.panel > header > \.actions > \.button\)/,
  );
});

test("a child path step may carry the owner's state classes", async (t) => {
  const { adoptScopedStyle, style } = await styleEnvironment(t);
  adoptScopedStyle(style, "caffold-owner", "> .panel > .button.is-busy > .icon");
  adoptScopedStyle(style, "caffold-owner", "> button.is-refreshing > span > .icon");
  assert.match(
    document.adoptedStyleSheets[0].text,
    /@scope \(caffold-owner > \.panel > \.button\.is-busy > \.icon\)/,
  );
  assert.match(
    document.adoptedStyleSheets[1].text,
    /@scope \(caffold-owner > button\.is-refreshing > span > \.icon\)/,
  );
});

test("Light DOM registration rejects descendant lists, selector injection and explicit custom-element paths", async (t) => {
  const { adoptScopedStyle, style } = await styleEnvironment(t);
  for (const target of [
    ".button",
    "> .panel .button",
    "> .panel > caffold-child > .button",
    "> .panel > caffold-child.is-busy > .button",
    "> .button.is-busy .icon",
    "> .button, button",
    "> .button) {}",
  ])
    assert.throws(() => adoptScopedStyle(style, "caffold-owner", target), /child path/);
  assert.throws(() => adoptScopedStyle(style, "button", "> .button"), /custom-element/);
  assert.equal(document.adoptedStyleSheets.length, 0);
});

test("a browser without native @scope gets no empty sheet", async (t) => {
  const { adoptScopedStyle, style } = await styleEnvironment(t);
  CSSStyleSheet.prototype.replaceSync = function (text) {
    this.text = text;
    this.cssRules = [{ cssRules: [] }];
  };
  assert.throws(() => adoptScopedStyle(style, "caffold-owner", "> .button"), /native @scope/);
  assert.equal(document.adoptedStyleSheets.length, 0);
});

async function styleEnvironment(t) {
  const originals = new Map(["document", "CSSStyleSheet"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.document = { adoptedStyleSheets: [] };
  // A rule keeps its text; the sheet a scope wraps parses as a layer holding
  // a scope holding one rule.
  globalThis.CSSStyleSheet = class {
    cssRules = [];

    replaceSync(text) {
      this.text = text;
      this.cssRules = [{ cssText: text, cssRules: [{ cssRules: [{}] }] }];
    }
  };
  const style = new CSSStyleSheet();
  style.replaceSync(":scope { display: grid; }");
  return {
    ...(await import(`./scoped-style.js?environment=${++environmentId}`)),
    style,
  };
}
