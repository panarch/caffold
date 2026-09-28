import { KEYBOARD_SHORTCUT_HELP_SECTIONS } from "../shortcuts.js";

class CaffoldKeyboardShortcutList extends HTMLElement {
  connectedCallback() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.innerHTML = KEYBOARD_SHORTCUT_HELP_SECTIONS.map((section) => `
      <section>
        <h3>${section.title}</h3>
        ${section.description ? `<p>${section.description}</p>` : ""}
        <dl>
          ${section.rows.map(({ keys, alternatives, description }) => `
            <div>
              <dt>${renderKeys(keys, alternatives)}</dt>
              <dd>${description}</dd>
            </div>
          `).join("")}
        </dl>
        ${section.note ? `<p>${section.note}</p>` : ""}
      </section>
    `).join("");
  }
}

function renderKeys(keys, alternatives) {
  return keys.map((key) => `<kbd>${key}</kbd>`).join(
    alternatives
      ? '<span class="keyboard-shortcut-or">or</span>'
      : '<span aria-hidden="true">/</span>',
  );
}

if (!customElements.get("caffold-keyboard-shortcut-list")) {
  customElements.define(
    "caffold-keyboard-shortcut-list",
    CaffoldKeyboardShortcutList,
  );
}
