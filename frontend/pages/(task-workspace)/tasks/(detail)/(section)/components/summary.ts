import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { sectionLabel } from "#tasks/task-format.js";

/**
 * The heading of a Section's Detail: the last part of its directory, with the
 * whole directory as its title.
 */
@customElement("caffold-section-detail-summary")
export class CaffoldSectionDetailSummary extends LitElement {
  @state()
  private accessor section: { id: string; name: string } | null = null;

  override createRenderRoot() {
    return this;
  }

  setSnapshot({
    section = null,
  }: {
    section?: { id: string; name: string } | null;
  } = {}) {
    this.section = section;
  }

  override render() {
    if (!this.section) {
      return nothing;
    }
    const name = `${this.section.name ?? ""}`;
    return html`<div class="section-detail-heading">
      <h2 title=${name}>${sectionLabel(name)}</h2>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-section-detail-summary": CaffoldSectionDetailSummary;
  }
}
