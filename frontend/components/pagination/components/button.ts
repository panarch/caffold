import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { compactIconButton } from "#app/component-styles.js";
import { inlineIcon } from "../../icons.js";

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

  actionHintScope({
    scopeId = "",
    actionId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    const control = this.querySelector<HTMLButtonElement>(
      ":scope > .pagination-button",
    );
    if (!scopeId || !actionId || this.hidden || !control || control.disabled) {
      return emptyActionHintScope();
    }
    const kind = `${control.dataset.pageKind ?? ""}`;
    const page = `${control.dataset.page ?? ""}`;
    if (!kind || !page) {
      return emptyActionHintScope();
    }
    return {
      ...emptyActionHintScope(),
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:page:${kind}:${encodeURIComponent(page)}`,
          actionId,
          label: control.getAttribute("aria-label") || `Open page ${page}`,
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            this.querySelector(":scope > .pagination-button") === control &&
            control.dataset.pageKind === kind &&
            control.dataset.page === page &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
    };
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
