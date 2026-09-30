import { readFile } from "node:fs/promises";

export function installCustomElementUnitRegistry() {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const previousStyleSheet = globalThis.CSSStyleSheet;
  const definitions = new Map();

  // Component imports await their CSS assets. This harness supplies the file
  // transport and a sheet sink; browser tests own CSS parsing and rendering.
  globalThis.fetch = (input, ...options) => {
    const url = input instanceof URL ? input
      : typeof input === "string" && input.startsWith("file:") ? new URL(input) : null;
    return url?.protocol === "file:" && url.pathname.endsWith(".css")
      ? readFile(url, "utf8").then((text) => new Response(text))
      : previousFetch(input, ...options);
  };
  globalThis.document = {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    querySelector: () => null,
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
      restoreGlobal("fetch", previousFetch);
      restoreGlobal("document", previousDocument);
      restoreGlobal("CSSStyleSheet", previousStyleSheet);
    },
  };
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
