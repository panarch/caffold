import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { type ActionHintPull, ActionHints } from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./sheet-tabs.css.js";

interface XlsxSheetTab {
  index: number;
  name: string;
}

export interface XlsxSheetTabsIntentDetail {
  index: number;
}

interface SheetTabsSnapshot {
  selected: number;
  sheets: XlsxSheetTab[];
}

// One button per visible sheet, named as the workbook names it; the pressed
// one is the sheet the viewer shows.
@customElement("caffold-xlsx-sheet-tabs")
export class CaffoldXlsxSheetTabs extends CaffoldElement {
  static override styles = styles;

  // An equivalent snapshot leaves the tabs as they are.
  @state({
    hasChanged: (next: unknown, previous: unknown) =>
      JSON.stringify(next) !== JSON.stringify(previous),
  })
  private accessor snapshot: SheetTabsSnapshot = { selected: -1, sheets: [] };

  private readonly hints = new ActionHints(this);

  override render() {
    const { selected, sheets } = this.snapshot;
    return repeat(
      sheets,
      (sheet) => sheet.index,
      (sheet) =>
        html`<button
          ${this.hints.button({
            id: `sheet:${sheet.index}`,
            label: `Show sheet ${sheet.name}`,
            when: sheet.index !== selected,
          })}
          type="button"
          data-sheet-index=${sheet.index}
          aria-pressed=${sheet.index === selected ? "true" : "false"}
          @click=${() => this.choose(sheet.index)}
        ><span>${sheet.name}</span></button>`,
    );
  }

  override updated() {
    this.setAttribute("role", "group");
    this.setAttribute("aria-label", "Sheets");
  }

  setSnapshot(snapshot: SheetTabsSnapshot) {
    this.snapshot = {
      selected: snapshot.selected,
      sheets: snapshot.sheets.map(({ index, name }) => ({ index, name })),
    };
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private choose(index: number) {
    this.dispatchEvent(
      new CustomEvent<XlsxSheetTabsIntentDetail>(
        "caffold:xlsx-sheet-tabs-intent",
        { detail: { index } },
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-xlsx-sheet-tabs": CaffoldXlsxSheetTabs;
  }

  interface HTMLElementEventMap {
    "caffold:xlsx-sheet-tabs-intent": CustomEvent<XlsxSheetTabsIntentDetail>;
  }
}
