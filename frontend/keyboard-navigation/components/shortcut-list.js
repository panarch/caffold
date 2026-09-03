import { KEYBOARD_SHORTCUT_HELP_SECTIONS } from "../shortcuts.js";

class CaffoldKeyboardShortcutList extends HTMLElement {
  connectedCallback() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.innerHTML = KEYBOARD_SHORTCUT_HELP_SECTIONS.map(({ title, rows }) => `
      <section>
        <h3>${title}</h3>
        <dl>
          ${rows.map(({ keys, description }) => `
            <div>
              <dt>${renderKeys(keys)}</dt>
              <dd>${description}</dd>
            </div>
          `).join("")}
        </dl>
      </section>
    `).join("");
  }
}

function renderKeys(keys) {
  return keys.map((key) => `<kbd>${key}</kbd>`).join(
    '<span aria-hidden="true">/</span>',
  );
}

if (!customElements.get("caffold-keyboard-shortcut-list")) {
  customElements.define(
    "caffold-keyboard-shortcut-list",
    CaffoldKeyboardShortcutList,
  );
}
