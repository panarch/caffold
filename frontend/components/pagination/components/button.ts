import { html, LitElement } from "lit";
import { type ActionHintPull, ActionHints } from "#app/action-hints.ts";
import { compactIconButton } from "#app/component-styles.ts";
import { inlineIcon } from "../../icons.ts";

export type PageKind = "first" | "previous" | "next" | "last";

export class CaffoldPaginationButton extends LitElement {
  static properties = {
    kind: {},
    page: { type: Number },
    label: {},
    icon: {},
    disabled: { type: Boolean },
  };

  declare kind: PageKind;
  declare page: number;
  declare label: string;
  declare icon: string;
  declare disabled: boolean;

  private readonly hints = new ActionHints(this);

  constructor() {
    super();
    this.page = 0;
    this.label = "";
    this.icon = "";
    this.disabled = false;
  }

  createRenderRoot() {
    return this;
  }

  render() {
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

await compactIconButton.register(
  "caffold-pagination-button",
  "> .pagination-button",
);

customElements.define("caffold-pagination-button", CaffoldPaginationButton);
