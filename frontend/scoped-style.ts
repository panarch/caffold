// A shared style is a stylesheet directly under a `component-styles/`
// directory whose rules all start at `:scope`. A component applies one to an
// element of its own; the rules go in the `component-styles` layer, so the
// owner's unlayered rules override them.

// For a component's `static styles`: `target` is the element's class path in
// the component's shadow root. Every instance's root shares one sheet.
export function scopedStyle(style: CSSStyleSheet, target: string) {
  if (!LOCAL_CLASS_PATH.test(target)) {
    throw new TypeError(
      `Shared styles require a class path to a local target: ${target}`,
    );
  }
  return scopedSheet(style, target);
}

// For a component that still renders into Light DOM, before it defines its
// element: `owner` is the element name and `target` the child path from it.
export function adoptScopedStyle(
  style: CSSStyleSheet,
  owner: string,
  target: string,
) {
  if (!CUSTOM_ELEMENT_NAME.test(owner)) {
    throw new TypeError(
      `Shared styles require a custom-element owner: ${owner}`,
    );
  }
  if (!LOCAL_CHILD_PATH.test(target)) {
    throw new TypeError(
      `Shared styles require a child path to a local class target: ${target}`,
    );
  }
  const scope = `${owner} ${target.replace(/\s+/g, " ")}`;
  const sheet = scopedSheet(style, scope);
  if (document.adoptedStyleSheets.includes(sheet)) return;
  const layer = sheet.cssRules[0] as CSSGroupingRule | undefined;
  const scoped = layer?.cssRules[0] as CSSGroupingRule | undefined;
  if (!scoped?.cssRules?.length) {
    throw new Error(`Shared styles require native @scope rules: ${scope}`);
  }
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

const sheets = new WeakMap<CSSStyleSheet, Map<string, CSSStyleSheet>>();

function scopedSheet(style: CSSStyleSheet, scope: string) {
  let byScope = sheets.get(style);
  if (!byScope) {
    byScope = new Map();
    sheets.set(style, byScope);
  }
  let sheet = byScope.get(scope);
  if (!sheet) {
    const rules = Array.from(style.cssRules, (rule) => rule.cssText);
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`@layer component-styles {
      @scope (${scope}) {
        ${rules.join("\n")}
      }
    }`);
    byScope.set(scope, sheet);
  }
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
