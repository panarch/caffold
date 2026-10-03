// Components register their own elements before defining the custom element.
export const compactIconButton = sharedStyle(
  "Compact icon buttons",
  "./component-styles/compact-icon-button.css",
);

// An element that stays while idle names its busy state class in the path.
export const busySpin = sharedStyle(
  "Busy spins",
  "./component-styles/busy-spin.css",
);

function sharedStyle(name, path) {
  const registrations = new Map();
  let sourceRequest;

  return {
    register(owner, target) {
      if (!CUSTOM_ELEMENT_NAME.test(owner)) {
        throw new TypeError(`${name} require a custom-element owner`);
      }
      if (!LOCAL_CHILD_PATH.test(target)) {
        throw new TypeError(`${name} require a child path to a local class target`);
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

  async function prepareStyles(scope) {
    sourceRequest ??= fetch(new URL(path, import.meta.url))
      .then((response) => {
        if (!response.ok) throw new Error(`Cannot load ${name} CSS (${response.status})`);
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
}

const CUSTOM_ELEMENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
// Each step is a tag or class with optional state classes; the target is a class.
const LOCAL_CHILD_PATH =
  /^>(?:\s+(?:[a-z]+|\.[a-zA-Z_][\w-]*)(?:\.[a-zA-Z_][\w-]*)*\s+>)*\s+\.[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/;
