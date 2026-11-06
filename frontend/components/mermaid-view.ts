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
} from "../action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "../action-hints.js";
import { CaffoldElement } from "../caffold-element.js";
import { UI_TYPEFACE_PRESETS } from "../fonts.js";
import { reportOriginReachable } from "../origin-reachability.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "../scroll-scope.js";
import { getSettings } from "../settings.js";
import { getThemeState } from "../theme.js";

import styles from "./mermaid-view.css.js";

interface RenderRequest {
  key: string;
  controller: AbortController;
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

// The server's generated SVG is the only markup inserted here. Merman owns
// Mermaid parsing and SVG generation; this component owns presentation and
// request lifetime, including a retained result while Code is selected.
@customElement("caffold-mermaid-view")
export class CaffoldMermaidView extends CaffoldElement {
  private sourceValue = "";
  private activeValue = true;
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
  private displayed = false;
  private observer: ResizeObserver | null = null;
  private visibilityFrame: number | null = null;
  private readonly hints = new ActionHints(this, { clipRoots: () => [this] });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly appearanceChanged = () => this.transition({ type: "input" });

  static override styles = styles;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:theme-change", this.appearanceChanged);
    window.addEventListener("caffold:settings-change", this.appearanceChanged);
    this.observer = new ResizeObserver(() => {
      if (
        this.visibilityFrame !== null ||
        this.displayed === this.getClientRects().length > 0
      )
        return;
      // Starting a request draws its status and changes this observed box.
      // Leave ResizeObserver delivery before asking Lit to draw that change.
      this.visibilityFrame = requestAnimationFrame(() => {
        this.visibilityFrame = null;
        const displayed = this.getClientRects().length > 0;
        if (this.displayed === displayed) return;
        this.displayed = displayed;
        this.transition({ type: "input" });
      });
    });
    this.observer.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:theme-change", this.appearanceChanged);
    window.removeEventListener(
      "caffold:settings-change",
      this.appearanceChanged,
    );
    this.observer?.disconnect();
    this.observer = null;
    if (this.visibilityFrame !== null)
      cancelAnimationFrame(this.visibilityFrame);
    this.visibilityFrame = null;
    this.displayed = false;
    this.transition({ type: "input" });
  }

  override willUpdate() {
    this.dispatchEvent(
      new CustomEvent("caffold:mermaid-layout-before", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override updated() {
    this.dataset.renderState = this.renderState.kind;
    const svg = this.renderRoot.querySelector(".diagram > svg");
    if (svg !== this.drawnSvg) {
      this.drawnSvg = svg;
      if (svg instanceof SVGSVGElement) {
        const { width, height } = svg.viewBox.baseVal;
        // Display the library's layout at its natural size. A narrow host
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
    this.dispatchEvent(
      new CustomEvent("caffold:mermaid-layout-after", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const result =
      "result" in this.renderState ? this.renderState.result : null;
    return html`
      <div
        class="diagram"
        ?hidden=${!result}
        ${this.surfaces.surface({
          id: "diagram",
          axes: ["horizontal"],
          when: this.renderState.kind === "ready",
          clipRoots: () => [this],
        })}
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
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    if (!this.active || !this.displayed) return emptyActionHintScope();
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
      scrollRoots: [...this.renderRoot.querySelectorAll(".diagram")],
    });
  }
  scrollSurfaceScope(pull: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ label: "Mermaid diagram", ...pull });
  }

  // Full control graph: inactive -> inactive/pending/ready; pending ->
  // inactive/pending/ready/error; ready -> inactive/pending/ready;
  // error -> inactive/pending/error. A completion is accepted only by the
  // pending request that started it. Same-key input is a no-op; Retry alone
  // restarts an active error. The current ready artifact survives hiding.
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
    const key = JSON.stringify({
      source: this.source,
      theme: getThemeState().resolvedTheme,
      fontFamily: UI_TYPEFACE_PRESETS[settings.uiTypefacePreset].stack,
      fontSize: settings.conversationTextPx,
    });
    const result =
      "result" in previous && previous.result?.key === key
        ? previous.result
        : null;
    if (
      !this.isConnected ||
      !this.active ||
      !this.displayed ||
      !this.source.trim()
    ) {
      if (previous.kind === "pending") previous.request.controller.abort();
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
    if (previous.kind === "pending") previous.request.controller.abort();
    const request = { key, controller: new AbortController() };
    this.renderState = { kind: "pending", request };
    void fetch("/api/mermaid/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: key,
      signal: request.controller.signal,
    })
      .then(async (response) => {
        reportOriginReachable();
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            body?.error?.message ||
              `Diagram request failed (HTTP ${response.status}).`,
          );
        }
        return response.text();
      })
      .then(
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-mermaid-view": CaffoldMermaidView;
  }
}
