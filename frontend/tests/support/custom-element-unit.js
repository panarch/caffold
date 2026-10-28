export function installCustomElementUnitRegistry() {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  const previousDocument = globalThis.document;
  const previousStyleSheet = globalThis.CSSStyleSheet;
  const definitions = new Map();

  // lit-html walks templates with a document tree walker it creates on import.
  // Component imports adopt their shared styles into this document's sheet
  // sink; browser tests own CSS parsing and rendering.
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    querySelector: () => null,
    createTreeWalker: () => ({}),
    ...previousDocument,
    adoptedStyleSheets: [],
  };
  globalThis.CSSStyleSheet = class {
    replaceSync() {
      this.cssRules = [{ cssRules: [{ cssRules: [{}] }] }];
    }
  };

  globalThis.HTMLElement = class TestHTMLElement {};
  globalThis.customElements = {
    define(name, constructor) {
      if (definitions.has(name)) {
        throw new Error(`Custom element already defined: ${name}`);
      }
      // A browser reads the attributes an element observes when it is
      // defined, which is when Lit finalizes the element's reactive properties.
      void constructor.observedAttributes;
      definitions.set(name, constructor);
    },
    get(name) {
      return definitions.get(name);
    },
  };

  return {
    element(name) {
      const constructor = definitions.get(name);
      if (!constructor) {
        throw new Error(`Custom element was not defined: ${name}`);
      }
      return constructor;
    },
    restore() {
      restoreGlobal("HTMLElement", previousHTMLElement);
      restoreGlobal("customElements", previousCustomElements);
      restoreGlobal("document", previousDocument);
      restoreGlobal("CSSStyleSheet", previousStyleSheet);
    },
  };
}

// An element a test calls methods on without constructing it. Its reactive
// properties are plain properties of its own, since a decorated accessor keeps
// its value where only a constructed element has room for it.
export function elementStandIn(prototype, values = {}) {
  const descriptors = Object.getOwnPropertyDescriptors(values);
  for (const name of prototype.constructor.elementProperties.keys()) {
    descriptors[name] ??= { value: undefined, writable: true, enumerable: true, configurable: true };
  }
  return Object.create(prototype, descriptors);
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
