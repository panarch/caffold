import assert from "node:assert/strict";
import test from "node:test";

let environmentId = 0;
const source = new URL("./component-styles/compact-icon-button.css", import.meta.url);
const busySpinSource = new URL("./component-styles/busy-spin.css", import.meta.url);

test("consumers wait for one CSS request and install each scope once", async (t) => {
  const pending = Promise.withResolvers();
  const requests = [];
  const { compactIconButton: style } = await styleEnvironment(t, (url) => {
    requests.push(url.href);
    return pending.promise;
  });
  const previous = {};
  document.adoptedStyleSheets.push(previous);
  const first = style.register("caffold-one", "> .button");
  assert.equal(style.register("caffold-one", "> .button"), first);
  const second = style.register("caffold-two", "> .panel > header > .actions > .button");
  assert.deepEqual(requests, [source.href]);
  assert.deepEqual(document.adoptedStyleSheets, [previous]);
  pending.resolve(new Response(":scope { display: grid; }"));
  await Promise.all([first, second]);
  await style.register("caffold-one", "> .button");
  assert.equal(document.adoptedStyleSheets.length, 3);
  assert.equal(document.adoptedStyleSheets[0], previous);
});

test("failed fetches install no partial sheet and may be retried", async (t) => {
  let attempts = 0;
  const { compactIconButton: style } = await styleEnvironment(t, async () => {
    attempts += 1;
    return attempts === 1
      ? new Response("unavailable", { status: 503 })
      : new Response(":scope { display: grid; }");
  });
  await assert.rejects(style.register("caffold-retry", "> .button"), /503/);
  assert.equal(document.adoptedStyleSheets.length, 0);
  await style.register("caffold-retry", "> .button");
  assert.equal(attempts, 2);
  assert.equal(document.adoptedStyleSheets.length, 1);
});

test("network and parsing failures do not register an empty stylesheet", async (t) => {
  let attempts = 0;
  const { compactIconButton: style } = await styleEnvironment(t, async () => {
    if (++attempts === 1) throw new Error("connection lost");
    return new Response(":scope { display: grid; }");
  });
  await assert.rejects(style.register("caffold-failure", "> .button"), /connection lost/);
  CSSStyleSheet.prototype.replaceSync = function () { this.cssRules = []; };
  await assert.rejects(style.register("caffold-failure", "> .button"), /native @scope/);
  assert.equal(document.adoptedStyleSheets.length, 0);
});

test("registration rejects descendant lists, selector injection and explicit custom-element paths", async (t) => {
  let requests = 0;
  const { compactIconButton: style } = await styleEnvironment(t, async () => {
    requests += 1;
    return new Response(":scope {}");
  });
  for (const target of [
    ".button",
    "> .panel .button",
    "> .panel > caffold-child > .button",
    "> .panel > caffold-child.is-busy > .button",
    "> .button.is-busy .icon",
    "> .button, button",
    "> .button) {}",
  ])
    assert.throws(() => style.register("caffold-owner", target), /child path/);
  assert.throws(() => style.register("button", "> .button"), /custom-element/);
  assert.equal(requests, 0);
});

test("each shared style requests its own source and installs its own scopes", async (t) => {
  const requests = [];
  const { busySpin, compactIconButton } = await styleEnvironment(t, async (url) => {
    requests.push(url.href);
    return new Response(":scope { display: grid; }");
  });
  await compactIconButton.register("caffold-one", "> .button");
  await busySpin.register("caffold-one", "> .button");
  await busySpin.register("caffold-two", "> .panel > .button");
  assert.deepEqual(requests, [source.href, busySpinSource.href]);
  assert.equal(document.adoptedStyleSheets.length, 3);
});

test("a child path step may carry the owner's state classes", async (t) => {
  const { busySpin } = await styleEnvironment(t, async () => new Response(":scope {}"));
  await busySpin.register("caffold-owner", "> .panel > .button.is-busy > .icon");
  await busySpin.register("caffold-owner", "> button.is-refreshing > span > .icon");
  assert.match(
    document.adoptedStyleSheets[0].text,
    /@scope \(caffold-owner > \.panel > \.button\.is-busy > \.icon\)/,
  );
  assert.match(
    document.adoptedStyleSheets[1].text,
    /@scope \(caffold-owner > button\.is-refreshing > span > \.icon\)/,
  );
});

async function styleEnvironment(t, fetchSource) {
  const originals = new Map(["document", "CSSStyleSheet", "fetch"].map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.document = { adoptedStyleSheets: [] };
  globalThis.fetch = fetchSource;
  globalThis.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
      this.cssRules = [{ cssRules: [{ cssRules: [{}] }] }];
    }
  };
  return await import(`./component-styles.js?environment=${++environmentId}`);
}
