import { html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { CaffoldElement } from "../../caffold-element.js";
import { KEYBOARD_SHORTCUT_HELP_SECTIONS } from "../shortcuts.js";

import styles from "./shortcut-list.css.js";

/** Every keyboard shortcut, in the sections the help dialog shows. */
@customElement("caffold-keyboard-shortcut-list")
export class CaffoldKeyboardShortcutList extends CaffoldElement {
  static override styles = styles;

  override render() {
    return KEYBOARD_SHORTCUT_HELP_SECTIONS.map(
      (section) => html`<section>
        <h3>${section.title}</h3>
        ${section.description ? html`<p>${section.description}</p>` : nothing}
        <dl>${section.rows.map(
          ({ keys, alternatives, description }) => html`<div>
            <dt>${keys.map(
              (key, index) =>
                html`${
                  index === 0
                    ? nothing
                    : alternatives
                      ? html`<span class="keyboard-shortcut-or">or</span>`
                      : html`<span aria-hidden="true">/</span>`
                }<kbd>${key}</kbd>`,
            )}</dt>
            <dd>${description}</dd>
          </div>`,
        )}</dl>
        ${section.note ? html`<p>${section.note}</p>` : nothing}
      </section>`,
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-keyboard-shortcut-list": CaffoldKeyboardShortcutList;
  }
}
