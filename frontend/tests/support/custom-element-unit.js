export function installCustomElementUnitRegistry() {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  const definitions = new Map();

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
