import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ActionHintPull, ActionHints } from "#app/action-hints.js";
import { compactIconButton } from "#app/component-styles.js";
import { inlineIcon } from "../../icons.js";

export type PageKind = "first" | "previous" | "next" | "last";

await compactIconButton.register(
  "caffold-pagination-button",
  "> .pagination-button",
);

@customElement("caffold-pagination-button")
export class CaffoldPaginationButton extends LitElement {
  @property()
  accessor kind!: PageKind;
  @property({ type: Number })
  accessor page = 0;
  @property()
  accessor label = "";
  @property()
  accessor icon = "";
  @property({ type: Boolean })
  accessor disabled = false;

  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  override render() {
    return html`
      <button
        ${this.hints.button({
          id: `page:${this.kind}:${encodeURIComponent(this.page)}`,
          label: this.label || `Open page ${this.page}`,
        })}
        type="button"
        class="pagination-button"
        data-page-kind=${this.kind}
        data-page=${this.page}
        aria-label=${this.label}
        title=${this.label}
        ?disabled=${this.disabled}
        @click=${this.choosePage}
      >
        ${inlineIcon(this.icon, this.label, "pagination-icon")}
      </button>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  choosePage() {
    if (!Number.isFinite(this.page) || this.page < 1) {
      return;
    }

    this.dispatchEvent(
      new CustomEvent("caffold:change-page", {
        bubbles: true,
        detail: { page: this.page },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-pagination-button": CaffoldPaginationButton;
  }
}
