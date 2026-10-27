import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.js";
import { warmIcons } from "./icons.js";
import "./pagination/components/button.js";
import { DrawnRefs, drawn } from "./drawn-refs.js";
import type {
  CaffoldPaginationButton,
  PageKind,
} from "./pagination/components/button.js";

const PAGE_KINDS: readonly PageKind[] = ["first", "previous", "next", "last"];

@customElement("caffold-pagination")
export class CaffoldPagination extends LitElement {
  @property({ type: Number })
  accessor page = 1;
  @property({ type: Number, attribute: "total-pages" })
  accessor totalPages = 0;
  @property({ type: Boolean, attribute: "has-previous" })
  accessor hasPrevious = false;
  @property({ type: Boolean, attribute: "has-next" })
  accessor hasNext = false;
  @property({ attribute: "first-label" })
  accessor firstLabel: string | null | undefined;
  @property({ attribute: "previous-label" })
  accessor previousLabel: string | null | undefined;
  @property({ attribute: "next-label" })
  accessor nextLabel: string | null | undefined;
  @property({ attribute: "last-label" })
  accessor lastLabel: string | null | undefined;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);
  private readonly pageButtons = new DrawnRefs<CaffoldPaginationButton>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
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
          ${drawn(this.pageButtons.of("first"))}
          kind="first"
          icon="ChevronFirst"
          page="1"
          .label=${this.firstLabel ?? "First page"}
          .disabled=${page <= 1}
        ></caffold-pagination-button>
        <caffold-pagination-button
          ${drawn(this.pageButtons.of("previous"))}
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
          ${drawn(this.pageButtons.of("next"))}
          kind="next"
          icon="ChevronRight"
          .label=${this.nextLabel ?? "Next page"}
          .page=${page + 1}
          .disabled=${!this.hasNext}
        ></caffold-pagination-button>
        <caffold-pagination-button
          ${drawn(this.pageButtons.of("last"))}
          kind="last"
          icon="ChevronLast"
          .label=${this.lastLabel ?? "Last page"}
          .page=${totalPages}
          .disabled=${page >= totalPages}
        ></caffold-pagination-button>
      </nav>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return mergeActionHintScopes(
      this.hints.scope(pull),
      ...PAGE_KINDS.map((kind) =>
        this.pageButtons.get(kind)?.actionHintScope(pull),
      ),
    );
  }
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-pagination": CaffoldPagination;
  }
}
