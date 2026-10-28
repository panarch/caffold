import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { type ActionHintPull, ActionHints } from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { inlineIcon } from "../../icons.js";

import compactIconButton from "#app/component-styles/compact-icon-button.css.js";
import { scopedStyle } from "#app/scoped-style.js";
import styles from "./button.css.js";

export interface ChangePageDetail {
  page: number;
}

export type PageKind = "first" | "previous" | "next" | "last";

@customElement("caffold-pagination-button")
export class CaffoldPaginationButton extends CaffoldElement {
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

  static override styles = [
    scopedStyle(compactIconButton, ".pagination-button"),
    styles,
  ];

  private readonly hints = new ActionHints(this);

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
      new CustomEvent<ChangePageDetail>("caffold:change-page", {
        bubbles: true,
        composed: true,
        detail: { page: this.page },
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-pagination-button": CaffoldPaginationButton;
  }

  interface HTMLElementEventMap {
    "caffold:change-page": CustomEvent<ChangePageDetail>;
  }
}
