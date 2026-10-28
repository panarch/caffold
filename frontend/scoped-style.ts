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
  let byTarget = sheets.get(style);
  if (!byTarget) {
    byTarget = new Map();
    sheets.set(style, byTarget);
  }
  let sheet = byTarget.get(target);
  if (!sheet) {
    const rules = Array.from(style.cssRules, (rule) => rule.cssText);
    sheet = new CSSStyleSheet();
    sheet.replaceSync(`@layer component-styles {
      @scope (${target}) {
        ${rules.join("\n")}
      }
    }`);
    byTarget.set(target, sheet);
  }
  return sheet;
}

const sheets = new WeakMap<CSSStyleSheet, Map<string, CSSStyleSheet>>();

// Each step is a tag or class with optional state classes, joined by `>` or by
// a space; the target is a class.
const LOCAL_CLASS_PATH =
  /^(?:(?:[a-z]+|\.[a-zA-Z_][\w-]*)(?:\.[a-zA-Z_][\w-]*)*\s+(?:>\s+)?)*\.[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/;
