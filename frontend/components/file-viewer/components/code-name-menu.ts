import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { scopedStyle } from "#app/scoped-style.js";

import busySpin from "#app/pages/component-styles/busy-spin.css.js";
import styles from "./code-name-menu.css.js";

export type CodeNameAction = "definition" | "references";

// What the menu shows for the name it opened on: its two actions, the same
// actions waiting while the language server gets ready, or one message.
export type CodeNameMenuSnapshot =
  | { status: "ready" }
  | { status: "starting"; progress?: string }
  | { status: "message"; message: string };

export interface CodeNameMenuActionDetail {
  action: CodeNameAction;
}

// The menu a code viewer opens on a name. Its owner makes the host the
// popover, places it at the name, and puts the keyboard presentation in its
// slot.
@customElement("caffold-code-name-menu")
export class CaffoldCodeNameMenu extends CaffoldElement {
  @property({ attribute: false })
  accessor snapshot: CodeNameMenuSnapshot | null = null;

  static override styles = [
    scopedStyle(busySpin, ".code-name-menu-spinner"),
    styles,
  ];

  private readonly hints = new ActionHints(this);

  override render() {
    const snapshot = this.snapshot;
    if (snapshot?.status === "message") {
      return html`<p class="code-name-menu-message" role="status">${snapshot.message}</p>
        <slot></slot>`;
    }
    const starting = snapshot?.status === "starting";
    return html`
      ${
        starting
          ? html`<p class="code-name-menu-status" role="status">
              <span class="code-name-menu-spinner" aria-hidden="true"></span>
              <span>${["Getting ready", snapshot.progress].filter(Boolean).join(" · ")}</span>
            </p>`
          : nothing
      }
      <button
        ${this.hints.button({
          id: "definition",
          label: "Go to definition",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          when: !starting,
          badgeAt: "top-right",
        })}
        type="button"
        data-code-name-action="definition"
        ?disabled=${starting}
        @click=${() => this.act("definition")}
      >Go to definition</button>
      <button
        ${this.hints.button({
          id: "references",
          label: "Find references",
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          when: !starting,
          badgeAt: "top-right",
        })}
        type="button"
        data-code-name-action="references"
        ?disabled=${starting}
        @click=${() => this.act("references")}
      >Find references</button>
      <slot></slot>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  // The first action, for a keyboard that opened the menu on a name.
  focusFirstAction() {
    this.renderRoot
      .querySelector<HTMLButtonElement>("button:not([disabled])")
      ?.focus();
  }

  private act(action: CodeNameAction) {
    this.dispatchEvent(
      new CustomEvent<CodeNameMenuActionDetail>(
        "caffold:code-name-menu-action",
        {
          detail: { action },
        },
      ),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-code-name-menu": CaffoldCodeNameMenu;
  }

  interface HTMLElementEventMap {
    "caffold:code-name-menu-action": CustomEvent<CodeNameMenuActionDetail>;
  }
}
