import { escapeHtml } from "./dom.js";
import { renderInlineIcon, warmIcons } from "./icons.js";
import { emptyActionHintScope } from "../action-hint-scope.js";

class CaffoldPagination extends HTMLElement {
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
        new CustomEvent("caffold:change-page", {
          bubbles: true,
          detail: { page },
        }),
      );
    });

    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
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
          kind: "first",
          icon: "ChevronFirst",
          label: this.labelAttribute("first-label", "First page"),
          page: 1,
          disabled: page <= 1,
        })}
        ${this.renderPageButton({
          kind: "previous",
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
          kind: "next",
          icon: "ChevronRight",
          label: this.labelAttribute("next-label", "Next page"),
          page: page + 1,
          disabled: !this.hasAttribute("has-next"),
        })}
        ${this.renderPageButton({
          kind: "last",
          icon: "ChevronLast",
          label: this.labelAttribute("last-label", "Last page"),
          page: totalPages,
          disabled: page >= totalPages,
        })}
      </nav>
    `;
  }

  actionHintScope({ scopeId = "", actionId = "", clipRoots = [] } = {}) {
    if (!scopeId || !actionId || this.hidden) {
      return emptyActionHintScope();
    }
    const targets = [...this.querySelectorAll(
      ":scope > .pagination-panel > button[data-page-kind][data-page]",
    )].flatMap((control) => {
      const kind = `${control.dataset.pageKind ?? ""}`;
      const page = `${control.dataset.page ?? ""}`;
      if (!kind || !page || control.disabled) {
        return [];
      }
      return [{
        id: `${scopeId}:page:${kind}:${encodeURIComponent(page)}`,
        actionId,
        label: control.getAttribute("aria-label") || `Open page ${page}`,
        controlKind: "button",
        control,
        anchor: control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(
            `:scope > .pagination-panel > button[data-page-kind="${CSS.escape(kind)}"][data-page="${CSS.escape(page)}"]`,
          ) === control &&
          !control.disabled,
        activate: () => {
          control.focus({ preventScroll: true });
          control.click();
        },
      }];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  renderPageButton({ kind, icon, label, page, disabled }) {
    return `
      <button
        type="button"
        class="pagination-button"
        data-page-kind="${escapeHtml(kind)}"
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

customElements.define("caffold-pagination", CaffoldPagination);
