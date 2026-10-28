import { html, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  type ActionHintTarget,
  captureLinkActionHintBinding,
  disclosureActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  type LinkActionHintBinding,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION, type ActionHintPull } from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import {
  hasScrollLayoutBox,
  mergeScrollSurfaceScopes,
  type ScrollSurfacePull,
  type ScrollSurfaceScope,
  ScrollSurfaces,
} from "#app/scroll-scope.js";
import { DrawnRef, drawn } from "#components/drawn-refs.js";

import styles from "./markdown.css.js";

const FORBIDDEN_ELEMENTS = new Set([
  "base",
  "button",
  "embed",
  "form",
  "iframe",
  "link",
  "meta",
  "object",
  "script",
  "select",
  "style",
  "textarea",
]);

const URL_ATTRIBUTES = new Set(["href", "src"]);

interface LinkRecord {
  control: HTMLAnchorElement;
  ordinal: number;
  binding: LinkActionHintBinding;
}

interface DisclosureRecord {
  details: HTMLDetailsElement;
  summary: HTMLElement;
  ordinal: number;
}

interface ScrollRecord {
  kind: "code" | "table";
  ordinal: number;
  label: string;
  scrollport: Element;
}

@customElement("caffold-github-markdown")
export class CaffoldGithubMarkdown extends CaffoldElement {
  // The HTML GitHub rendered for the Markdown, and the sanitized copy of it
  // that is shown.
  @property({ attribute: false })
  accessor html = "";
  @state()
  private accessor content: DocumentFragment | null = null;

  static override styles = styles;

  private actionHintLinks: LinkRecord[] = [];
  private actionHintDisclosures: DisclosureRecord[] = [];
  private scrollSurfaceRecords: ScrollRecord[] = [];
  private readonly body = new DrawnRef<HTMLElement>(this);
  private readonly surfaces = new ScrollSurfaces(this);

  // GitHub's HTML is parsed inert and sanitized before it reaches the page.
  override willUpdate(changed: PropertyValues) {
    if (!changed.has("html")) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = this.html || "";
    sanitizeChildren(template.content);
    wrapTables(template.content);
    this.content = template.content;
  }

  override render() {
    return html`<article
      ${drawn(this.body)}
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical", "horizontal"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
      class="markdown-body"
    >${this.content}</article>`;
  }

  override updated(changed: PropertyValues) {
    const body = this.body.value;
    if (!changed.has("html") || !body) {
      return;
    }
    this.actionHintLinks = collectActionHintLinks(body);
    this.actionHintDisclosures = collectActionHintDisclosures(body);
    this.scrollSurfaceRecords = collectScrollSurfaceRecords(body);
  }

  actionHintScope({ scopeId = "", clipRoots = [] }: ActionHintPull = {}) {
    const body = this.body.value;
    if (!body) {
      return emptyActionHintScope();
    }
    const tableScrollRoots: Element[] = [];
    const targets: ActionHintTarget[] = this.actionHintLinks.flatMap(
      ({ binding, control, ordinal }) => {
        const label = linkActionHintLabel(control);
        if (
          !label ||
          !matchesLinkActionHintBinding(control, binding) ||
          !body.contains(control) ||
          isFoldedAway(control) ||
          !hasActionHintLayoutBox(control)
        ) {
          return [];
        }
        const tableScrollRoot = control.closest(".markdown-table-scroll");
        if (tableScrollRoot && body.contains(tableScrollRoot)) {
          tableScrollRoots.push(tableScrollRoot);
        }
        return [
          linkActionHintTarget({
            invalidationOwner: this,
            id: `${scopeId}:link:${ordinal}`,
            actionId: ACTION_HINT_ACTION.LINK_OPEN,
            label,
            control,
            clipRoots: [this, body, tableScrollRoot, ...clipRoots].filter(
              (root): root is Element => Boolean(root),
            ),
          }),
        ];
      },
    );
    // GitHub content can fold parts of itself away; opening one is how its
    // links come into reach.
    for (const record of this.actionHintDisclosures) {
      const { details, summary, ordinal } = record;
      if (
        !isDisclosureCurrent(body, record) ||
        isFoldedAway(summary) ||
        !hasActionHintLayoutBox(summary)
      ) {
        continue;
      }
      targets.push(
        disclosureActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:disclosure:${ordinal}`,
          actionId: ACTION_HINT_ACTION.DISCLOSURE_TOGGLE,
          label: `${details.open ? "Collapse" : "Expand"} ${disclosureName(summary)}`,
          control: summary,
          clipRoots: [this, body, ...clipRoots],
        }),
      );
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this, this.renderRoot],
      scrollRoots: [this, ...new Set(tableScrollRoots)],
    };
  }

  scrollSurfaceScope({
    label = "Issue description",
    ...pull
  }: ScrollSurfacePull = {}) {
    const own = this.surfaces.scope({ ...pull, label });
    const body = this.body.value;
    const nestedScopes = (body ? this.scrollSurfaceRecords : []).flatMap(
      (record): ScrollSurfaceScope[] =>
        body?.contains(record.scrollport) &&
        hasScrollLayoutBox(this) &&
        hasScrollLayoutBox(record.scrollport)
          ? [
              {
                blocked: false,
                surfaces: [
                  {
                    id: `${pull.scopeId}:${record.kind}:${record.ordinal}`,
                    label: `${label} ${record.label}`,
                    scrollport: record.scrollport,
                    axes: ["horizontal"],
                    clipRoots: [
                      this,
                      body,
                      record.scrollport,
                      ...(pull.clipRoots ?? []),
                    ],
                  },
                ],
                mutationRoots: [this, this.renderRoot],
                resizeElements: [this, record.scrollport],
                scrollRoots: [this, record.scrollport],
              },
            ]
          : [],
    );
    return mergeScrollSurfaceScopes(own, ...nestedScopes);
  }
}

// A link's name is read when a session starts rather than here: a link inside
// a closed disclosure has no rendered text until the disclosure opens.
function collectActionHintLinks(root: Element): LinkRecord[] {
  return [...root.querySelectorAll("a[href]")].flatMap((control, index) => {
    const binding = captureLinkActionHintBinding(control);
    return binding.href && !binding.href.startsWith("#")
      ? [{ control: control as HTMLAnchorElement, ordinal: index + 1, binding }]
      : [];
  });
}

function collectActionHintDisclosures(root: Element): DisclosureRecord[] {
  return [...root.querySelectorAll("details")].flatMap((details, index) => {
    const summary = details.querySelector<HTMLElement>(":scope > summary");
    return summary ? [{ details, summary, ordinal: index + 1 }] : [];
  });
}

function isDisclosureCurrent(
  body: Element,
  { details, summary }: DisclosureRecord,
) {
  return (
    body.contains(details) &&
    details.querySelector(":scope > summary") === summary
  );
}

// Chromium still gives what a closed details folds away a layout box, placed
// over the content that follows it.
function isFoldedAway(control: Element) {
  for (
    let details = control.closest("details");
    details;
    details = details.parentElement?.closest("details") ?? null
  ) {
    if (
      !details.open &&
      !details.querySelector(":scope > summary")?.contains(control)
    ) {
      return true;
    }
  }
  return false;
}

function disclosureName(summary: HTMLElement) {
  // biome-ignore lint/performance/useDomNodeTextContent: a section is named by the words it shows.
  const text = `${summary.innerText ?? summary.textContent ?? ""}`
    .replace(/\s+/g, " ")
    .trim();
  return text || "section";
}

function collectScrollSurfaceRecords(root: Element): ScrollRecord[] {
  const ordinals = new Map<string, number>();
  return [...root.querySelectorAll("pre, .markdown-table-scroll")].map(
    (scrollport) => {
      const kind = scrollport.localName === "pre" ? "code" : "table";
      const ordinal = (ordinals.get(kind) ?? 0) + 1;
      ordinals.set(kind, ordinal);
      return {
        kind,
        ordinal,
        label:
          kind === "code"
            ? `code block ${ordinal}`
            : `Markdown table ${ordinal}`,
        scrollport,
      };
    },
  );
}

function sanitizeChildren(parent: ParentNode) {
  for (const element of [...parent.children]) {
    const tagName = element.localName;
    if (FORBIDDEN_ELEMENTS.has(tagName)) {
      element.remove();
      continue;
    }
    if (tagName === "input" && !sanitizeInput(element as HTMLInputElement)) {
      element.remove();
      continue;
    }
    sanitizeAttributes(element);
    sanitizeChildren(element);
    sanitizeElementAfterChildren(element);
  }
}

function sanitizeInput(element: HTMLInputElement) {
  if (element.getAttribute("type") !== "checkbox") {
    return false;
  }
  element.disabled = true;
  return true;
}

function sanitizeAttributes(element: Element) {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (
      name.startsWith("on") ||
      name === "style" ||
      name === "srcset" ||
      name === "xlink:href"
    ) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(attribute.value)) {
      element.removeAttribute(attribute.name);
    }
  }
  if (element.localName === "img") {
    (element as HTMLImageElement).loading = "lazy";
  }
}

function sanitizeElementAfterChildren(element: Element) {
  if (element.localName !== "a") {
    return;
  }
  if (!element.hasAttribute("href")) {
    element.replaceWith(...element.childNodes);
    return;
  }
  (element as HTMLAnchorElement).target = "_blank";
  (element as HTMLAnchorElement).rel = "noreferrer";
}

function isSafeUrl(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return true;
  }
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function wrapTables(parent: ParentNode) {
  for (const table of [...parent.querySelectorAll("table")]) {
    if (table.parentElement?.classList.contains("markdown-table-scroll")) {
      continue;
    }
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-scroll";
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.append(table);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-github-markdown": CaffoldGithubMarkdown;
  }
}
