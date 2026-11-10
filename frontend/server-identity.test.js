import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import {
  applyServerIdentity,
  SERVER_IDENTITY_CHANGE_EVENT,
  ServerIdentityController,
  serverIconUrl,
  serverIdentity,
} from "./server-identity.js";

// The head of a page the server rendered, as the parts this module reads.
function installDocument({ title = "Caffold", icon = "default" } = {}) {
  const attributes = new Map([
    ['meta[name="application-name"]', { content: title }],
    ['meta[name="apple-mobile-web-app-title"]', { content: title }],
    ['meta[name="caffold-server-icon"]', { content: icon }],
    ['link[rel="icon"]', { href: `/icons/${icon}/favicon-32.png` }],
    [
      'link[rel="apple-touch-icon"]',
      { href: `/icons/${icon}/apple-touch-icon.png` },
    ],
  ]);
  const writes = [];
  globalThis.document = {
    title,
    querySelector(selector) {
      const element = attributes.get(selector);
      if (!element) return null;
      return {
        getAttribute: (name) => element[name] ?? null,
        setAttribute: (name, value) => {
          element[name] = value;
          writes.push(selector);
        },
      };
    },
  };
  return { attributes, writes };
}

let events;
let listener;

beforeEach(() => {
  events = [];
  globalThis.window = new EventTarget();
  listener = (event) => events.push(event.detail);
  window.addEventListener(SERVER_IDENTITY_CHANGE_EVENT, listener);
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

test("reads the name and icon the page was served with", () => {
  installDocument({ title: "Caffold Studio", icon: "teal" });

  assert.deepEqual(serverIdentity(), { name: "Caffold Studio", icon: "teal" });
});

test("the name is read as the server wrote it, not as the title reads back", () => {
  installDocument({ title: "Caffold  Studio" });
  // A title reads back with runs of spaces collapsed.
  document.title = "Caffold Studio";

  assert.equal(serverIdentity().name, "Caffold  Studio");
  applyServerIdentity({ name: "Caffold  Studio", icon: "default" });
  assert.deepEqual(events, []);
});

test("a page without an icon shows the default one", () => {
  const { attributes } = installDocument();
  attributes.delete('meta[name="caffold-server-icon"]');

  assert.equal(serverIdentity().icon, "default");
});

test("a server answer is shown in the title, the install names and icons, and the app's marks", () => {
  const { attributes } = installDocument();

  applyServerIdentity({ name: "Caffold Linux", icon: "sky" });

  assert.equal(document.title, "Caffold Linux");
  assert.equal(attributes.get('meta[name="application-name"]').content, "Caffold Linux");
  assert.equal(
    attributes.get('meta[name="apple-mobile-web-app-title"]').content,
    "Caffold Linux",
  );
  assert.equal(attributes.get('meta[name="caffold-server-icon"]').content, "sky");
  assert.equal(attributes.get('link[rel="icon"]').href, "/icons/sky/favicon-32.png");
  assert.equal(
    attributes.get('link[rel="apple-touch-icon"]').href,
    "/icons/sky/apple-touch-icon.png",
  );
  assert.deepEqual(events, [{ name: "Caffold Linux", icon: "sky" }]);
  assert.deepEqual(serverIdentity(), { name: "Caffold Linux", icon: "sky" });
});

test("the same name and icon change nothing and tell nobody", () => {
  const { writes } = installDocument({ title: "Caffold Studio", icon: "red" });

  applyServerIdentity({ name: "Caffold Studio", icon: "red" });

  assert.deepEqual(writes, []);
  assert.deepEqual(events, []);
});

test("an icon file's address names the icon", () => {
  assert.equal(serverIconUrl("violet", "caffold.png"), "/icons/violet/caffold.png");
  assert.equal(serverIconUrl("a/b", "icon-192.png"), "/icons/a%2Fb/icon-192.png");
});

test("a connected component follows every change and stops when it leaves", () => {
  installDocument({ title: "Caffold", icon: "gold" });
  const host = {
    controllers: [],
    updates: 0,
    addController(controller) {
      this.controllers.push(controller);
    },
    requestUpdate() {
      this.updates += 1;
    },
  };
  const server = new ServerIdentityController(host);
  assert.deepEqual(host.controllers, [server]);

  applyServerIdentity({ name: "Caffold", icon: "pink" });
  server.hostConnected();
  assert.equal(server.identity.icon, "pink", "it reads the page when it connects");

  applyServerIdentity({ name: "Caffold", icon: "lime" });
  assert.equal(server.identity.icon, "lime");
  assert.equal(host.updates, 1);

  server.hostDisconnected();
  applyServerIdentity({ name: "Caffold", icon: "blue" });
  assert.equal(server.identity.icon, "lime");
  assert.equal(host.updates, 1);
});
