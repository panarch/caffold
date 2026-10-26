import { html, LitElement, nothing } from "lit";
import {
  type ActionHintPull,
  ActionHints,
  mergeActionHintScopes,
} from "../action-hints.ts";
import { warmIcons } from "./icons.ts";
import "./pagination/components/button.ts";
import { DrawnRefs, drawn } from "./drawn-refs.ts";
import type {
  CaffoldPaginationButton,
  PageKind,
} from "./pagination/components/button.ts";

const PAGE_KINDS: readonly PageKind[] = ["first", "previous", "next", "last"];

export class CaffoldPagination extends LitElement {
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
  private readonly hints = new ActionHints(this);
  private readonly pageButtons = new DrawnRefs<CaffoldPaginationButton>(this);

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

customElements.define("caffold-pagination", CaffoldPagination);
