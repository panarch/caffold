import { html, LitElement, nothing } from "lit";
import { sectionLabel } from "#tasks/task-format.js";

/**
 * The heading of a Section's Detail: the last part of its directory, with the
 * whole directory as its title.
 */
export class CaffoldSectionDetailSummary extends LitElement {
  private section: { id: string; name: string } | null = null;

  createRenderRoot() {
    return this;
  }

  setSnapshot({
    section = null,
  }: {
    section?: { id: string; name: string } | null;
  } = {}) {
    this.section = section;
    this.requestUpdate();
    this.performUpdate();
  }

  render() {
    if (!this.section) {
      return nothing;
    }
    const name = `${this.section.name ?? ""}`;
    return html`<div class="section-detail-heading">
      <h2 title=${name}>${sectionLabel(name)}</h2>
    </div>`;
  }
}

customElements.define(
  "caffold-section-detail-summary",
  CaffoldSectionDetailSummary,
);
