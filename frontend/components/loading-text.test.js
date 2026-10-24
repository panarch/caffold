import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { showLoadingText } = await import("./loading-text.ts");
const loadingText = registry.element("caffold-loading-text").prototype;
after(() => registry.restore());

// Enough of a node for a container holding text or one phrase element.
class FakeNode {
  constructor(localName = "") {
    this.localName = localName;
    this.childNodes = [];
    this.text = "";
    this.attributes = new Map();
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get textContent() {
    return this.childNodes.length
      ? this.childNodes.map((node) => node.textContent).join("")
      : this.text;
  }

  set textContent(value) {
    this.childNodes = [];
    this.text = `${value}`;
  }

  replaceChildren(...nodes) {
    this.childNodes = nodes;
    this.text = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, `${value}`);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  toggleAttribute(name, force) {
    if (force) {
      this.attributes.set(name, "");
    } else {
      this.attributes.delete(name);
    }
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }
}
globalThis.document.createElement = (localName) => new FakeNode(localName);

test("announces itself as a status once connected", () => {
  const element = new FakeNode("caffold-loading-text");
  loadingText.connectedCallback.call(element);
  assert.equal(element.getAttribute("role"), "status");
});

test("makes the phrase a container's only content without restarting a matching one", () => {
  const container = new FakeNode("p");
  container.textContent = "Checking…";

  showLoadingText(container, "Checking…");
  const phrase = container.firstChild;
  assert.equal(phrase.localName, "caffold-loading-text");
  assert.equal(phrase.hasAttribute("immediate"), false);
  assert.equal(container.childNodes.length, 1);

  showLoadingText(container, "Checking…");
  assert.equal(container.firstChild, phrase);

  phrase.toggleAttribute("immediate", true);
  showLoadingText(container, "Checking…");
  assert.notEqual(container.firstChild, phrase, "a phrase shown at once is not the delayed one");

  const delayed = container.firstChild;
  showLoadingText(container, "Checking for updates…");
  assert.notEqual(container.firstChild, delayed);
  assert.equal(container.textContent, "Checking for updates…");
});
