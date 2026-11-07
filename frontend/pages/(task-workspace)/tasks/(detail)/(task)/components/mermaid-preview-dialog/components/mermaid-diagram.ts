import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  captureLinkActionHintBinding,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  type LinkActionHintBinding,
  linkActionHintLabel,
  linkActionHintTarget,
  matchesLinkActionHintBinding,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { UI_TYPEFACE_PRESETS } from "#app/fonts.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import { getSettings } from "#app/settings.js";
import { getThemeState } from "#app/theme.js";

import styles from "./mermaid-diagram.css.js";

const MERMAID_VERSION = "12.3.0";
const MERMAID_IMPORT = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;

interface RenderRequest {
  key: string;
}
type RenderState =
  | { kind: "inactive"; result: SvgResult | null }
  | { kind: "pending"; request: RenderRequest }
  | { kind: "ready"; result: SvgResult }
  | { kind: "error"; request: RenderRequest; message: string };
type RenderEvent =
  | { type: "input" | "retry" }
  | { type: "complete"; request: RenderRequest; svg: string }
  | { type: "failed"; request: RenderRequest; message: string };
interface SvgResult {
  key: string;
  svg: string;
}
interface Appearance {
  theme: string;
  fontFamily: string;
  fontSize: number;
}

// Mermaid's SVG is the only markup inserted here. Mermaid owns parsing,
// layout, and SVG generation in this browser, so labels are measured in the
// fonts they are drawn with; this component owns presentation and render
// lifetime, including a retained result while its dialog is closed.
@customElement("caffold-task-mermaid-diagram")
export class CaffoldTaskMermaidDiagram extends CaffoldElement {
  private sourceValue = "";
  private activeValue = false;
  get source() {
    return this.sourceValue;
  }
  @property({ attribute: false })
  set source(value: string) {
    const previous = this.sourceValue;
    this.sourceValue = value;
    if (previous !== value && this.isConnected)
      this.transition({ type: "input" });
  }
  get active() {
    return this.activeValue;
  }
  @property({ type: Boolean })
  set active(value: boolean) {
    const previous = this.activeValue;
    this.activeValue = value;
    if (previous !== value && this.isConnected)
      this.transition({ type: "input" });
  }
  @state() private accessor renderState: RenderState = {
    kind: "inactive",
    result: null,
  };
  private links: {
    control: HTMLAnchorElement | SVGAElement;
    binding: LinkActionHintBinding;
  }[] = [];
  private drawnSvg: Element | null = null;
  private readonly hints = new ActionHints(this, { clipRoots: () => [this] });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly appearanceChanged = () => this.transition({ type: "input" });

  static override styles = styles;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:theme-change", this.appearanceChanged);
    window.addEventListener("caffold:settings-change", this.appearanceChanged);
    this.transition({ type: "input" });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:theme-change", this.appearanceChanged);
    window.removeEventListener(
      "caffold:settings-change",
      this.appearanceChanged,
    );
    this.transition({ type: "input" });
  }

  override updated() {
    this.dataset.renderState = this.renderState.kind;
    const svg = this.renderRoot.querySelector(".diagram > svg");
    if (svg === this.drawnSvg) return;
    this.drawnSvg = svg;
    if (svg instanceof SVGSVGElement) {
      const { width, height } = svg.viewBox.baseVal;
      // Display the library's layout at its natural size. A narrow dialog
      // scrolls instead of scaling every label down to fit its width.
      svg.style.width = `${width}px`;
      svg.style.height = `${height}px`;
      svg.style.maxWidth = "none";
    }
    this.links = [
      ...(svg?.querySelectorAll<HTMLAnchorElement | SVGAElement>("a") ?? []),
    ].map((control) => ({
      control,
      binding: captureLinkActionHintBinding(control),
    }));
  }

  override render() {
    const result =
      "result" in this.renderState ? this.renderState.result : null;
    return html`<div
      class="body"
      ${this.surfaces.surface({
        id: "scroll",
        axes: ["vertical", "horizontal"],
        scrollport: () => this,
        clipRoots: () => [this],
      })}
    >
      <div
        class="diagram"
        ?hidden=${!result}
      >${result ? unsafeHTML(result.svg) : nothing}</div>
      ${
        this.renderState.kind === "pending"
          ? html`<p class="status" role="status">Rendering diagram…</p>`
          : nothing
      }
      ${
        this.renderState.kind === "error"
          ? html`
            <div class="error" role="status">
              <p>${this.renderState.message}</p>
              <pre
                class="source"
                aria-label="Mermaid source"
                ${this.surfaces.surface({
                  id: "source",
                  axes: ["horizontal"],
                  clipRoots: () => [this],
                })}
              ><code>${this.source}</code></pre>
              <button
                type="button"
                ${this.hints.button({
                  id: "retry",
                  label: "Retry diagram",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                @click=${this.retry}
              >Retry</button>
            </div>
          `
          : nothing
      }
    </div>`;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    if (!this.active) return emptyActionHintScope();
    return mergeActionHintScopes(this.hints.scope(pull), {
      blocked: false,
      targets: this.links.flatMap(({ control, binding }, index) => {
        const label = linkActionHintLabel(control);
        if (
          !label ||
          !matchesLinkActionHintBinding(control, binding) ||
          !hasActionHintLayoutBox(control)
        )
          return [];
        return [
          linkActionHintTarget({
            id: `${pull.scopeId}:link:${index}`,
            actionId: ACTION_HINT_ACTION.LINK_OPEN,
            label,
            invalidationOwner: this,
            control,
            clipRoots: [this, ...(pull.clipRoots ?? [])],
          }),
        ];
      }),
      mutationRoots: [this, this.renderRoot],
      scrollRoots: [this],
    });
  }
  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ label: "Mermaid diagram", ...pull });
  }

  // Full control graph: inactive -> inactive/pending/ready; pending ->
  // inactive/pending/ready/error; ready -> inactive/pending/ready;
  // error -> inactive/pending/error. A completion is accepted only by the
  // pending request that started it, since Mermaid cannot stop a render.
  // Same-key input is a no-op; Retry alone restarts an active error. The
  // current ready artifact survives deactivation.
  private transition(event: RenderEvent) {
    const previous = this.renderState;
    if (event.type === "complete" || event.type === "failed") {
      if (previous.kind !== "pending" || previous.request !== event.request)
        return;
      this.renderState =
        event.type === "complete"
          ? {
              kind: "ready",
              result: { key: event.request.key, svg: event.svg },
            }
          : { kind: "error", request: event.request, message: event.message };
      return;
    }
    const settings = getSettings();
    const appearance: Appearance = {
      theme: getThemeState().resolvedTheme,
      fontFamily: UI_TYPEFACE_PRESETS[settings.uiTypefacePreset].stack,
      fontSize: settings.conversationTextPx,
    };
    const key = JSON.stringify({ source: this.source, ...appearance });
    const result =
      "result" in previous && previous.result?.key === key
        ? previous.result
        : null;
    if (!this.isConnected || !this.active || !this.source.trim()) {
      if (previous.kind !== "inactive" || previous.result !== result)
        this.renderState = { kind: "inactive", result };
      return;
    }
    if (result) {
      if (previous.kind !== "ready")
        this.renderState = { kind: "ready", result };
      return;
    }
    if (
      (previous.kind === "pending" || previous.kind === "error") &&
      previous.request.key === key &&
      event.type !== "retry"
    )
      return;
    if (event.type === "retry" && previous.kind !== "error") return;
    const request = { key };
    this.renderState = { kind: "pending", request };
    renderSvg(this.source, appearance).then(
      (svg) => this.transition({ type: "complete", request, svg }),
      (error: unknown) =>
        this.transition({
          type: "failed",
          request,
          message:
            error instanceof Error
              ? error.message
              : "Diagram rendering failed.",
        }),
    );
  }

  private retry() {
    this.transition({ type: "retry" });
  }
}

interface MermaidLibrary {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
}

let library: Promise<MermaidLibrary> | null = null;
let libraryFailures = 0;
let renders: Promise<unknown> = Promise.resolve();
let renderCount = 0;

// Mermaid keeps one page-wide configuration, so each render applies its
// own theme and fonts directly before drawing, one render after another.
function renderSvg(source: string, appearance: Appearance) {
  const rendered = renders.then(async () => {
    const mermaid = await loadLibrary();
    // Mermaid sizes each label by drawing it, so a font that arrives later
    // would leave its box too narrow.
    await document.fonts
      .load(`${appearance.fontSize}px ${appearance.fontFamily}`, source)
      .catch(() => undefined);
    mermaid.initialize({
      startOnLoad: false,
      theme: appearance.theme === "dark" ? "dark" : "default",
      fontFamily: appearance.fontFamily,
      themeVariables: {
        fontFamily: appearance.fontFamily,
        fontSize: `${appearance.fontSize}px`,
      },
      suppressErrorRendering: true,
    });
    renderCount += 1;
    const { svg } = await mermaid.render(
      `caffold-mermaid-${renderCount}`,
      source,
    );
    return svg;
  });
  renders = rendered.catch(() => undefined);
  return rendered;
}

// A failed module address stays failed for the page, so a later attempt
// asks for the library under a new address.
function loadLibrary() {
  const attempt = libraryFailures ? `#retry-${libraryFailures}` : "";
  library ??= import(`${MERMAID_IMPORT}${attempt}`).then(
    (module: { default: MermaidLibrary }) => module.default,
    (error: unknown) => {
      library = null;
      libraryFailures += 1;
      throw error;
    },
  );
  return library;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-task-mermaid-diagram": CaffoldTaskMermaidDiagram;
  }
}
