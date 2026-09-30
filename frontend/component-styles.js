// Components register their own button before defining the custom element.
export const compactIconButton = {
  register(owner, target) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(owner)) {
      throw new TypeError("Compact icon buttons require a custom-element owner");
    }
    if (!/^>(?:\s+(?:\.[a-zA-Z_][\w-]*|[a-z]+)\s+>)*\s+\.[a-zA-Z_][\w-]*$/.test(target)) {
      throw new TypeError("Compact icon buttons require a child path to a local class target");
    }

    const scope = `${owner} ${target.replace(/\s+/g, " ")}`;
    let ready = registrations.get(scope);
    if (!ready) {
      ready = prepareStyles(scope).catch((error) => {
        registrations.delete(scope);
        throw error;
      });
      registrations.set(scope, ready);
    }
    return ready;
  },
};

const registrations = new Map();
let sourceRequest;

async function prepareStyles(scope) {
  sourceRequest ??= fetch(new URL("./component-styles/compact-icon-button.css", import.meta.url))
    .then((response) => {
      if (!response.ok) throw new Error(`Cannot load compact icon button CSS (${response.status})`);
      return response.text();
    }).catch((error) => {
      sourceRequest = undefined;
      throw error;
    });

  const css = await sourceRequest;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`@layer component-styles {
    @scope (${scope}) {
      ${css}
    }
  }`);
  if (!sheet.cssRules[0]?.cssRules[0]?.cssRules?.length) {
    throw new Error(`Component styles require native @scope rules: ${scope}`);
  }
  // Unlayered owner rules override the shared defaults.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
