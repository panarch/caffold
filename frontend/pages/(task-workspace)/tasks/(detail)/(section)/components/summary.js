import { escapeHtml } from "../../../../../../components/dom.js";

class CaffoldSectionDetailSummary extends HTMLElement {
  setSnapshot({ section = null } = {}) {
    const sectionId = `${section?.id ?? ""}`;
    if (this.sectionId === sectionId && this.sectionName === section?.name) {
      return;
    }
    this.sectionId = sectionId;
    this.sectionName = `${section?.name ?? ""}`;
    this.innerHTML = section
      ? `<div class="section-detail-heading">
          <h2 title="${escapeHtml(this.sectionName)}">${escapeHtml(this.sectionName)}</h2>
        </div>`
      : "";
  }
}

if (!customElements.get("caffold-section-detail-summary")) {
  customElements.define(
    "caffold-section-detail-summary",
    CaffoldSectionDetailSummary,
  );
}
