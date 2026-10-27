import { nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

const REPEAT = repeat([], () => "")._$litDirective$;
const KEYED = keyed("", "")._$litDirective$;
const UNSAFE_HTML = unsafeHTML("")._$litDirective$;

/**
 * The markup a Lit template draws, for a unit test that reads what a
 * component's `render()` says without a browser. Text and attribute values
 * are escaped as the browser serializes them, and a value bound to an
 * unquoted attribute is quoted. Listeners and property values draw nothing.
 */
export function templateHtml(value) {
  if (value === null || value === undefined || value === nothing) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(templateHtml).join("");
  }
  if (value._$litType$) {
    return value.strings
      .map((text, index) => {
        if (index >= value.values.length) {
          return text;
        }
        const drawn = templateHtml(value.values[index]);
        return /=$/.test(text) ? `${text}"${drawn}"` : `${text}${drawn}`;
      })
      .join("");
  }
  if (value._$litDirective$ === REPEAT) {
    const [items, keyOrTemplate, template] = value.values;
    return [...items]
      .map((item, index) => templateHtml((template ?? keyOrTemplate)(item, index)))
      .join("");
  }
  if (value._$litDirective$ === KEYED) {
    return templateHtml(value.values[1]);
  }
  if (value._$litDirective$ === UNSAFE_HTML) {
    return `${value.values[0] ?? ""}`;
  }
  return isPrimitive(value) ? escape(`${value}`) : "";
}

function isPrimitive(value) {
  return ["string", "number", "boolean", "bigint"].includes(typeof value);
}

function escape(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
