import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./detail-list.css.js";

export interface SettingsDetailRow {
  key: string;
  label?: string;
  // Left out while it is still loading.
  value?: string | number | null;
  kind?: "code" | "time";
  datetime?: string;
  state?: string;
}

const UNKNOWN_VALUE = "—";

/**
 * A settings label/value list. Rows arrive as one snapshot and are matched by
 * key, so a list that already holds the right rows rewrites only what changed.
 * A row whose value is not known yet keeps its place and shows a placeholder.
 */
@customElement("caffold-settings-detail-list")
export class CaffoldSettingsDetailList extends CaffoldElement {
  @property({ attribute: false })
  accessor rows: readonly SettingsDetailRow[] = [];

  static override styles = styles;

  override render() {
    const busy = this.rows.some((row) => !known(row.value));
    return html`<dl aria-busy=${busy ? "true" : nothing}>${repeat(
      this.rows,
      (row) => row.key,
      (row) =>
        html`<div data-key=${row.key}><dt>${row.label ?? ""}</dt><dd
          ?data-unknown=${!known(row.value)}
          data-state=${row.state || nothing}
        >${rowValue(row)}</dd></div>`,
    )}</dl>`;
  }
}

function known(value: SettingsDetailRow["value"]) {
  return value !== undefined && value !== null;
}

// The value element carries the kind, so a kind change replaces it while a
// plain value change writes text into the element already standing there.
function rowValue(row: SettingsDetailRow) {
  if (!known(row.value)) {
    return UNKNOWN_VALUE;
  }
  const value = String(row.value);
  if (row.kind === "code") {
    return html`<code>${value}</code>`;
  }
  if (row.kind === "time") {
    return html`<time datetime=${row.datetime || nothing}>${value}</time>`;
  }
  return value;
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-detail-list": CaffoldSettingsDetailList;
  }
}
