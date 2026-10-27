import compactIconButtonSource from "./component-styles/compact-icon-button.css.js";

// A shared style a component applies to one of its own elements: `owner` is
// the component's element name and `target` the child path to the element.
export interface SharedStyle {
  register(owner: string, target: string): Promise<void>;
}

// Components register their own elements before defining the custom element.
// One that renders into a shadow root instead puts `compactIconButton(target)`
// in its `static styles`, `target` being the element's class path in that root.
export const compactIconButton = Object.assign(
  scopedStyle("Compact icon buttons", compactIconButtonSource),
  sharedStyle(
    "Compact icon buttons",
    "./component-styles/compact-icon-button.css",
  ),
);

// An element that stays while idle names its busy state class in the path.
export const busySpin = sharedStyle(
  "Busy spins",
  "./component-styles/busy-spin.css",
);

function sharedStyle(name: string, path: string): SharedStyle {
  const registrations = new Map<string, Promise<void>>();
  let sourceRequest: Promise<string> | undefined;

  return {
    register(owner, target) {
      if (!CUSTOM_ELEMENT_NAME.test(owner)) {
        throw new TypeError(`${name} require a custom-element owner`);
      }
      if (!LOCAL_CHILD_PATH.test(target)) {
        throw new TypeError(
          `${name} require a child path to a local class target`,
        );
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

  async function prepareStyles(scope: string) {
    sourceRequest ??= fetch(new URL(path, import.meta.url))
      .then((response) => {
        if (!response.ok)
          throw new Error(`Cannot load ${name} CSS (${response.status})`);
        return response.text();
      })
      .catch((error) => {
        sourceRequest = undefined;
        throw error;
      });

    const css = await sourceRequest;
    const sheet = scopedSheet(scope, css);
    const layer = sheet.cssRules[0] as CSSGroupingRule | undefined;
    const scoped = layer?.cssRules[0] as CSSGroupingRule | undefined;
    if (!scoped?.cssRules?.length) {
      throw new Error(`Component styles require native @scope rules: ${scope}`);
    }
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
}

// One sheet per target, which every instance's shadow root shares.
function scopedStyle(name: string, source: CSSStyleSheet) {
  const sheets = new Map<string, CSSStyleSheet>();
  return (target: string) => {
    if (!LOCAL_CLASS_PATH.test(target)) {
      throw new TypeError(`${name} require a class path to a local target`);
    }
    let sheet = sheets.get(target);
    if (!sheet) {
      const rules = Array.from(source.cssRules, (rule) => rule.cssText);
      sheet = scopedSheet(target, rules.join("\n"));
      sheets.set(target, sheet);
    }
    return sheet;
  };
}

// Unlayered owner rules override the shared defaults.
function scopedSheet(scope: string, css: string) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`@layer component-styles {
    @scope (${scope}) {
      ${css}
    }
  }`);
  return sheet;
}

const CUSTOM_ELEMENT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
// Each step is a tag or class with optional state classes; the target is a class.
const LOCAL_CHILD_PATH =
  /^>(?:\s+(?:[a-z]+|\.[a-zA-Z_][\w-]*)(?:\.[a-zA-Z_][\w-]*)*\s+>)*\s+\.[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/;
// The same steps, starting inside a shadow root and joined by `>` or by a
// space.
const LOCAL_CLASS_PATH =
  /^(?:(?:[a-z]+|\.[a-zA-Z_][\w-]*)(?:\.[a-zA-Z_][\w-]*)*\s+(?:>\s+)?)*\.[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/;
