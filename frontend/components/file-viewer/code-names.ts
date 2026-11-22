import { html, type ReactiveControllerHost } from "lit";
import {
  type ActionHintScope,
  type ActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION, type ActionHintPull } from "#app/action-hints.js";
import { KeyboardContexts } from "#app/keyboard-navigation.js";
import "#app/keyboard-navigation/components/presentation.js";
import { returnPopoverFocus } from "#app/popover-focus.js";
import { DrawnRef, drawn } from "../drawn-refs.js";
import "./components/code-name-menu.js";
import type {
  CaffoldCodeNameMenu,
  CodeNameAction,
  CodeNameMenuActionDetail,
  CodeNameMenuSnapshot,
} from "./components/code-name-menu.js";

// Whether the names a viewer shows can be pressed, and whether the language
// server behind them answers yet. Null leaves the code as plain text.
export type CodeNamesState =
  | { status: "ready" }
  | { status: "starting"; progress?: string };

// A name in the file as the viewer shows it: its one-based line and its
// zero-based UTF-16 offset in that line.
export interface CodeNamePosition {
  line: number;
  character: number;
}

export interface CodeNameIntentDetail extends CodeNamePosition {
  action: CodeNameAction;
  name: string;
}

// How far a press may travel and still be a press rather than a selection.
const PRESS_SLOP = 4;

interface OpenName extends CodeNamePosition {
  element: HTMLElement;
  name: string;
  message: string | null;
}

/**
 * The names a code or diff viewer lets a person press, and the menu that
 * opens on one. A press opens the menu at the name; Cmd or Ctrl goes straight
 * to the definition. `G` marks the names in view, and choosing one opens the
 * menu with Go to definition focused. The viewer's owner answers the intent
 * and may hand back a message to show at the name.
 */
export class CodeNames {
  state: CodeNamesState | null = null;

  private readonly host: HTMLElement & ReactiveControllerHost;
  private readonly lineOf: (row: Element) => number | null;
  private readonly scrollport: () => Element | null | undefined;
  private readonly keyboard: KeyboardContexts;
  private readonly menu: DrawnRef<CaffoldCodeNameMenu>;
  private open: OpenName | null = null;
  private pressedAt: { x: number; y: number } | null = null;

  constructor(
    host: HTMLElement & ReactiveControllerHost,
    // The line a row shows, or null for a row whose names cannot be asked
    // about.
    lineOf: (row: Element) => number | null,
    // What the rows scroll in.
    scrollport: () => Element | null | undefined,
  ) {
    this.host = host;
    this.lineOf = lineOf;
    this.scrollport = scrollport;
    this.keyboard = new KeyboardContexts(host);
    this.menu = new DrawnRef<CaffoldCodeNameMenu>(host);
  }

  menuTemplate() {
    return html`<caffold-code-name-menu
      ${drawn(this.menu)}
      ${this.keyboard.popover({ id: "name", label: "Name" })}
      popover="auto"
      .snapshot=${this.snapshot()}
      @beforetoggle=${returnPopoverFocus}
      @toggle=${this.toggled}
      @caffold:code-name-menu-action=${this.act}
    ><caffold-keyboard-navigation-presentation
      ${this.keyboard.presentation()}
    ></caffold-keyboard-navigation-presentation></caffold-code-name-menu>`;
  }

  readonly pressStart = (event: PointerEvent) => {
    this.pressedAt = { x: event.clientX, y: event.clientY };
  };

  readonly press = (event: MouseEvent) => {
    const pressedAt = this.pressedAt;
    this.pressedAt = null;
    if (!this.state || event.detail > 1 || event.button !== 0) {
      return;
    }
    if (
      pressedAt &&
      Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) >
        PRESS_SLOP
    ) {
      return;
    }
    const target = (event.target as Element | null)?.closest?.(".code-name");
    const row = target?.closest(".code-row, .diff-row");
    const line = row ? this.lineOf(row) : null;
    if (!(target instanceof HTMLElement) || !line) {
      return;
    }
    const name: OpenName = {
      element: target,
      line,
      character: Number(target.dataset.character),
      name: target.textContent ?? "",
      message: null,
    };
    if ((event.metaKey || event.ctrlKey) && this.state.status === "ready") {
      this.anchor(name);
      this.intend("definition");
      return;
    }
    this.show(name);
  };

  // The names in view, as `G` marks them.
  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintPull = {}): ActionHintScope {
    const scrollport = this.scrollport();
    const root = this.host.shadowRoot;
    if (!this.state || !scrollport || !root) {
      return emptyActionHintScope();
    }
    const view = scrollport.getBoundingClientRect();
    const rows = [...root.querySelectorAll(".code-row, .diff-row")];
    let first = 0;
    let last = rows.length;
    while (first < last) {
      const middle = (first + last) >> 1;
      if (rows[middle].getBoundingClientRect().bottom <= view.top) {
        first = middle + 1;
      } else {
        last = middle;
      }
    }
    const targets: ActionHintTarget[] = [];
    for (const row of rows.slice(first)) {
      if (row.getBoundingClientRect().top >= view.bottom) {
        break;
      }
      const line = this.lineOf(row);
      if (!line) {
        continue;
      }
      for (const element of row.querySelectorAll<HTMLElement>(".code-name")) {
        const rect = element.getBoundingClientRect();
        if (rect.right <= view.left || rect.left >= view.right) {
          continue;
        }
        const character = Number(element.dataset.character);
        const name = element.textContent ?? "";
        targets.push({
          id: `${scopeId}:name:${line}:${character}`,
          actionId: ACTION_HINT_ACTION.CODE_NAME,
          label: `${name}, line ${line}`,
          invalidationOwner: this.host,
          controlKind: "button",
          control: element,
          anchor: element,
          clipRoots: [...clipRoots, scrollport],
          // A name's badge sits on the name's own line, over its first
          // letters, so it reads as that name's and leaves the lines around
          // it.
          badgeAt: "center-left",
          activate: () =>
            this.show(
              { element, line, character, name, message: null },
              { focus: true },
            ),
        });
      }
    }
    return {
      blocked: false,
      targets,
      mutationRoots: [this.host, root],
      scrollRoots: [scrollport],
    };
  }

  // Shows `message` at the name at `position`, as the owner's answer to an
  // intent that found nowhere to go.
  showMessage(position: CodeNamePosition, message: string) {
    const element = this.nameAt(position);
    if (!element) {
      return false;
    }
    this.show({
      ...position,
      element,
      name: element.textContent ?? "",
      message,
    });
    return true;
  }

  hide() {
    const menu = this.menu.value;
    if (menu?.matches(":popover-open")) {
      menu.hidePopover();
    }
  }

  keyboardNavigationContexts({ scopeId = "" }: { scopeId?: string } = {}) {
    return this.keyboard.contexts({
      scopeId,
      actionHints: (pull) =>
        this.menu.value?.actionHintScope(pull) ?? emptyActionHintScope(),
    });
  }

  private show(name: OpenName, { focus = false }: { focus?: boolean } = {}) {
    this.anchor(name);
    this.host.requestUpdate();
    void this.host.updateComplete.then(async () => {
      const menu = this.menu.value;
      if (!menu || this.open !== name) {
        return;
      }
      if (!menu.matches(":popover-open")) {
        menu.showPopover();
      }
      // The name stays underlined while its menu is open, since a touch or
      // `G` leaves no hover on it.
      name.element.classList.add("is-open");
      if (focus) {
        await menu.updateComplete;
        menu.focusFirstAction();
      }
    });
  }

  private anchor(name: OpenName) {
    this.open?.element.style.removeProperty("anchor-name");
    this.open?.element.classList.remove("is-open");
    name.element.style.setProperty("anchor-name", "--code-name");
    this.open = name;
  }

  private snapshot(): CodeNameMenuSnapshot | null {
    if (this.open?.message) {
      return { status: "message", message: this.open.message };
    }
    return this.state;
  }

  private readonly toggled = (event: ToggleEvent) => {
    if (event.newState === "closed" && this.open) {
      this.open.element.style.removeProperty("anchor-name");
      this.open.element.classList.remove("is-open");
      this.open = null;
      this.host.requestUpdate();
    }
  };

  private readonly act = (event: CustomEvent<CodeNameMenuActionDetail>) => {
    event.stopPropagation();
    this.intend(event.detail.action);
    this.hide();
  };

  private intend(action: CodeNameAction) {
    const open = this.open;
    if (!open) {
      return;
    }
    this.host.dispatchEvent(
      new CustomEvent<CodeNameIntentDetail>("caffold:code-name-intent", {
        bubbles: true,
        composed: true,
        detail: {
          action,
          line: open.line,
          character: open.character,
          name: open.name,
        },
      }),
    );
  }

  private nameAt({ line, character }: CodeNamePosition) {
    const root = this.host.shadowRoot;
    const rows = [...(root?.querySelectorAll(".code-row, .diff-row") ?? [])];
    const row = rows.find((candidate) => this.lineOf(candidate) === line);
    return row?.querySelector<HTMLElement>(
      `.code-name[data-character="${character}"]`,
    );
  }
}

declare global {
  interface HTMLElementEventMap {
    "caffold:code-name-intent": CustomEvent<CodeNameIntentDetail>;
  }
}
