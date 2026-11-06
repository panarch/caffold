import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";

// Only the already-sanitized Marked tree enters here. Lit owns the mounted
// tree, so appended text leaves existing fence components and their SVG alone.
export function markdownContent(
  parent: Node,
  fences: Map<Element, string>,
  controls: boolean,
): unknown {
  return repeat(
    [...parent.childNodes],
    (_node, index) => index,
    (node) => markdownNode(node, fences, controls),
  );
}

function markdownNode(
  node: Node,
  fences: Map<Element, string>,
  controls: boolean,
): TemplateResult | string | typeof nothing {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return nothing;
  const label = fences.get(node);
  if (controls && label !== undefined) {
    return html`<caffold-task-code-block .text=${node.textContent ?? ""} .label=${label}></caffold-task-code-block>`;
  }
  const tag = unsafeStatic(node.localName);
  return staticHtml`<${tag}
    class=${node.getAttribute("class") ?? nothing}
    data-fence-label=${label ?? nothing}
    href=${node.getAttribute("href") ?? nothing}
    target=${node.getAttribute("target") ?? nothing}
    rel=${node.getAttribute("rel") ?? nothing}
    title=${node.getAttribute("title") ?? nothing}
    start=${node.getAttribute("start") ?? nothing}
    type=${node.getAttribute("type") ?? nothing}
    ?checked=${node.hasAttribute("checked")}
    ?disabled=${node.hasAttribute("disabled")}
  >${markdownContent(node, fences, controls)}</${tag}>`;
}
