import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  emptyActionHintScope,
  mergeActionHintScopes,
} from "../action-hint-scope.js";
import { warmIcons } from "./icons.js";
import "./pagination/components/button.ts";
import type { CaffoldPaginationButton } from "./pagination/components/button.ts";

class CaffoldPagination extends LitElement {
  static properties = {
    page: { type: Number },
    totalPages: { type: Number, attribute: "total-pages" },
    hasPrevious: { type: Boolean, attribute: "has-previous" },
    hasNext: { type: Boolean, attribute: "has-next" },
    firstLabel: { attribute: "first-label" },
    previousLabel: { attribute: "previous-label" },
    nextLabel: { attribute: "next-label" },
    lastLabel: { attribute: "last-label" },
  };

  declare page: number;
  declare totalPages: number;
  declare hasPrevious: boolean;
  declare hasNext: boolean;
  declare firstLabel: string | null | undefined;
  declare previousLabel: string | null | undefined;
  declare nextLabel: string | null | undefined;
  declare lastLabel: string | null | undefined;

  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.page = 1;
    this.totalPages = 0;
    this.hasPrevious = false;
    this.hasNext = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
    const page = finiteOr(this.page, 1);
    const totalPages = finiteOr(this.totalPages, 0);
    if (totalPages <= 1) {
      return nothing;
    }

    return html`
      <nav
        class="pagination-panel"
        aria-label=${this.getAttribute("aria-label") ?? "Pagination"}
      >
        <caffold-pagination-button
          kind="first"
          icon="ChevronFirst"
          page="1"
          .label=${this.firstLabel ?? "First page"}
          .disabled=${page <= 1}
        ></caffold-pagination-button>
        <caffold-pagination-button
          kind="previous"
          icon="ChevronLeft"
          .label=${this.previousLabel ?? "Previous page"}
          .page=${page - 1}
          .disabled=${!this.hasPrevious}
        ></caffold-pagination-button>
        <span
          class="pagination-indicator"
          aria-label=${`Page ${page} of ${totalPages}`}
        >
          ${`${page} / ${totalPages}`}
        </span>
        <caffold-pagination-button
          kind="next"
          icon="ChevronRight"
          .label=${this.nextLabel ?? "Next page"}
          .page=${page + 1}
          .disabled=${!this.hasNext}
        ></caffold-pagination-button>
        <caffold-pagination-button
          kind="last"
          icon="ChevronLast"
          .label=${this.lastLabel ?? "Last page"}
          .page=${totalPages}
          .disabled=${page >= totalPages}
        ></caffold-pagination-button>
      </nav>
    `;
  }

  // The page buttons provide their own targets; this adds itself so that a
  // rendered or removed button set revalidates the session.
  actionHintScope(options: ActionHintScopeOptions = {}): ActionHintScope {
    if (!options.scopeId || !options.actionId || this.hidden) {
      return emptyActionHintScope();
    }
    const pageButtons = this.querySelectorAll<CaffoldPaginationButton>(
      ":scope > .pagination-panel > caffold-pagination-button",
    );
    return mergeActionHintScopes(
      { ...emptyActionHintScope(), mutationRoots: [this] },
      ...[...pageButtons].map((button) => button.actionHintScope(options)),
    );
  }
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

customElements.define("caffold-pagination", CaffoldPagination);
