import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";

class CodgerPagination extends HTMLElement {
  static observedAttributes = [
    "page",
    "total-pages",
    "has-previous",
    "has-next",
    "first-label",
    "previous-label",
    "next-label",
    "last-label",
  ];

  connectedCallback() {
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-page]");
      if (!button) {
        return;
      }

      const page = Number.parseInt(button.dataset.page ?? "", 10);
      if (!Number.isFinite(page) || page < 1) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("codger:change-page", {
          bubbles: true,
          detail: { page },
        }),
      );
    });

    this.boundIconsReady = () => this.render();
    window.addEventListener("codger:icons-ready", this.boundIconsReady);
    warmIcons();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("codger:icons-ready", this.boundIconsReady);
  }

  attributeChangedCallback() {
    this.render();
  }

  render() {
    if (!this.isConnected) {
      return;
    }

    const page = this.numberAttribute("page", 1);
    const totalPages = this.numberAttribute("total-pages", 0);
    if (totalPages <= 1) {
      this.innerHTML = "";
      return;
    }

    this.innerHTML = `
      <nav class="pagination-panel" aria-label="${escapeHtml(this.ariaLabel())}">
        ${this.renderPageButton({
          icon: "ChevronFirst",
          label: this.labelAttribute("first-label", "First page"),
          page: 1,
          disabled: page <= 1,
        })}
        ${this.renderPageButton({
          icon: "ChevronLeft",
          label: this.labelAttribute("previous-label", "Previous page"),
          page: page - 1,
          disabled: !this.hasAttribute("has-previous"),
        })}
        <span
          class="pagination-indicator"
          aria-label="${escapeHtml(`Page ${page} of ${totalPages}`)}"
        >
          ${escapeHtml(`${page} / ${totalPages}`)}
        </span>
        ${this.renderPageButton({
          icon: "ChevronRight",
          label: this.labelAttribute("next-label", "Next page"),
          page: page + 1,
          disabled: !this.hasAttribute("has-next"),
        })}
        ${this.renderPageButton({
          icon: "ChevronLast",
          label: this.labelAttribute("last-label", "Last page"),
          page: totalPages,
          disabled: page >= totalPages,
        })}
      </nav>
    `;
  }

  renderPageButton({ icon, label, page, disabled }) {
    return `
      <button
        type="button"
        class="pagination-button"
        data-page="${escapeHtml(`${page}`)}"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
        ${disabled ? "disabled" : ""}
      >
        ${renderInlineIcon(icon, label, "pagination-icon")}
      </button>
    `;
  }

  numberAttribute(name, fallback) {
    const value = Number.parseInt(this.getAttribute(name) ?? "", 10);
    return Number.isFinite(value) ? value : fallback;
  }

  labelAttribute(name, fallback) {
    return this.getAttribute(name) ?? fallback;
  }

  ariaLabel() {
    return this.getAttribute("aria-label") ?? "Pagination";
  }
}

customElements.define("codger-pagination", CodgerPagination);
