// The xterm.js terminal a terminal screen draws with. It fills the box CSS
// gives it, draws in the Code font and size, follows the theme, scrolls its
// history under a dragged finger, selects text under a held one, and reports
// typed input, its row and column count, and whether text is selected.
// xterm.js and its fit addon load from a pinned jsDelivr release the first
// time a terminal opens.

import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { DrawnRef, drawn } from "./drawn-refs.js";
import {
  edgeScrollDirection,
  TOUCH_GESTURE_EFFECT,
  TOUCH_GESTURE_EVENT,
  TOUCH_GESTURE_NODE,
  type TouchGestureEffect,
  type TouchGestureEvent,
  type TouchGestureNode,
  touchGestureTransition,
} from "./terminal-view/touch-gesture.js";
import {
  type CellBuffer,
  type CellPoint,
  type CellRange,
  stretchFromWord,
  wordAt,
} from "./terminal-view/word-range.js";

import styles from "./terminal-view.css.js";

export interface TerminalViewInputDetail {
  data: string;
  binary: boolean;
}

export interface TerminalViewSelectionDetail {
  hasSelection: boolean;
}

const XTERM_VERSION = "6.0.0";
const FIT_ADDON_VERSION = "0.11.0";
const XTERM_BASE = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}`;
const FIT_ADDON_BASE = `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_ADDON_VERSION}`;
// The backend keeps the same number of lines when it restores a screen.
const SCROLLBACK_LINES = 5_000;
const MIN_COLUMNS = 2;
// How long a finger rests before it selects, how far it may wander and still
// count as resting, and how often a selection at an edge row scrolls a row.
const HOLD_MS = 500;
const TAP_SLOP_PX = 10;
const EDGE_SCROLL_MS = 100;

export const TERMINAL_VIEW_INPUT_EVENT = "caffold:terminal-view-input";
export const TERMINAL_VIEW_RESIZE_EVENT = "caffold:terminal-view-resize";
export const TERMINAL_VIEW_SELECTION_EVENT = "caffold:terminal-view-selection";

// The parts of xterm.js 6.0.0 and its fit addon this view uses.
interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
}

interface TerminalOptions {
  fontFamily: string;
  fontSize: number;
  theme: TerminalTheme;
  scrollback: number;
  disableStdin: boolean;
  wordSeparator?: string;
}

interface TerminalBuffer extends CellBuffer {
  readonly viewportY: number;
}

interface Terminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly modes: { applicationCursorKeysMode: boolean };
  readonly buffer: { readonly active: TerminalBuffer };
  options: TerminalOptions;
  loadAddon(addon: FitAddon): void;
  open(parent: HTMLElement): void;
  onData(listener: (data: string) => void): void;
  onBinary(listener: (data: string) => void): void;
  onSelectionChange(listener: () => void): void;
  dispose(): void;
  reset(): void;
  write(data: Uint8Array | string): void;
  focus(): void;
  input(data: string, wasUserInput: boolean): void;
  paste(data: string): void;
  resize(columns: number, rows: number): void;
  scrollLines(amount: number): void;
  select(column: number, row: number, length: number): void;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
}

interface FitAddon {
  proposeDimensions(): { cols: number; rows: number } | undefined;
}

interface TerminalLibrary {
  Terminal: new (options: TerminalOptions) => Terminal;
  FitAddon: new () => FitAddon;
  // xterm.js's stylesheet, which each view adopts into its shadow root.
  stylesheet: CSSStyleSheet;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

let libraryPromise: Promise<TerminalLibrary> | null = null;
// A module that failed to load stays failed under its URL for the life of the
// page, so each later attempt imports it under a new fragment.
let libraryFailures = 0;

@customElement("caffold-terminal-view")
export class CaffoldTerminalView extends CaffoldElement {
  static override styles = styles;

  size: TerminalSize | null = null;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private stopTouch: (() => void) | null = null;
  private fitFrame = 0;
  private readonly appearanceChanged = () => this.applyAppearance();
  private readonly resizeObserver = new ResizeObserver(() =>
    this.scheduleFit(),
  );

  private readonly screen = new DrawnRef<HTMLDivElement>(this);

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:theme-change", this.appearanceChanged);
    window.addEventListener("caffold:settings-change", this.appearanceChanged);
    this.resizeObserver.observe(this);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:theme-change", this.appearanceChanged);
    window.removeEventListener(
      "caffold:settings-change",
      this.appearanceChanged,
    );
    this.resizeObserver.disconnect();
    if (this.fitFrame) {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = 0;
    }
  }

  // xterm.js draws everything inside the screen.
  override render() {
    return html`<div ${drawn(this.screen)} class="terminal-view-screen"></div>`;
  }

  /** Opens a terminal unless one is open. Resolves with its size once it has a box. */
  async open() {
    await this.updateComplete;
    if (!this.terminal) {
      await this.createTerminal();
    }
    this.fit();
    return this.size;
  }

  /**
   * Closes the terminal with everything it drew. A reset would not do:
   * xterm.js still draws the output it had queued before the reset.
   */
  close() {
    if (!this.terminal) {
      return;
    }
    this.stopTouch?.();
    this.stopTouch = null;
    this.terminal.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.size = null;
    // Whatever was selected went with it.
    this.emitSelection(false);
  }

  reset() {
    this.terminal?.reset();
  }

  write(bytes: Uint8Array | string) {
    this.terminal?.write(bytes);
  }

  override focus() {
    this.terminal?.focus();
  }

  setInputEnabled(enabled: boolean) {
    if (this.terminal) {
      this.terminal.options.disableStdin = !enabled;
    }
  }

  /** Types `text` as if it came from the keyboard. */
  sendInput(text: string) {
    this.terminal?.input(text, true);
  }

  /** Pastes `text` the way ⌘V does, bracketed when the program asked for it. */
  paste(text: string) {
    this.terminal?.paste(text);
  }

  selectionText() {
    return this.terminal?.getSelection() ?? "";
  }

  clearSelection() {
    this.terminal?.clearSelection();
  }

  applicationCursorKeys() {
    return Boolean(this.terminal?.modes.applicationCursorKeysMode);
  }

  /** The element xterm.js reads keyboard input from, once the terminal is open. */
  inputControl() {
    return this.terminal?.textarea ?? null;
  }

  ownsInput(element: Element | null | undefined) {
    return Boolean(element) && element === this.inputControl();
  }

  private async createTerminal() {
    const { Terminal, FitAddon, stylesheet } = await loadLibrary();
    const root = this.shadowRoot;
    if (root && !root.adoptedStyleSheets.includes(stylesheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, stylesheet];
    }
    const appearance = terminalAppearance(this);
    // Cells are measured when the terminal opens, so the Code font has to be
    // loaded by then.
    try {
      await document.fonts?.load(
        `${appearance.fontSize}px ${appearance.fontFamily}`,
      );
    } catch {
      // A fallback font still gives the terminal a size.
    }
    // Another open may have made one while the library and font loaded.
    if (this.terminal) {
      return;
    }
    const terminal = new Terminal({
      ...appearance,
      scrollback: SCROLLBACK_LINES,
      disableStdin: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(this.screen.value as HTMLDivElement);
    terminal.onData((data) => this.emitInput(data, false));
    terminal.onBinary((data) => this.emitInput(data, true));
    terminal.onSelectionChange(() =>
      this.emitSelection(terminal.hasSelection()),
    );
    this.stopTouch = followTouch(terminal);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
  }

  private emitInput(data: string, binary: boolean) {
    this.dispatchEvent(
      new CustomEvent<TerminalViewInputDetail>(TERMINAL_VIEW_INPUT_EVENT, {
        detail: { data, binary },
      }),
    );
  }

  private emitSelection(hasSelection: boolean) {
    this.dispatchEvent(
      new CustomEvent<TerminalViewSelectionDetail>(
        TERMINAL_VIEW_SELECTION_EVENT,
        { detail: { hasSelection } },
      ),
    );
  }

  private applyAppearance() {
    if (!this.terminal) {
      return;
    }
    const { fontFamily, fontSize, theme } = terminalAppearance(this);
    this.terminal.options.fontFamily = fontFamily;
    this.terminal.options.fontSize = fontSize;
    this.terminal.options.theme = theme;
    this.scheduleFit();
  }

  private scheduleFit() {
    if (this.fitFrame || !this.terminal) {
      return;
    }
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fit();
    });
  }

  /** Matches the rows and columns to the box, and reports a change. */
  private fit() {
    if (
      !this.terminal ||
      !this.fitAddon ||
      !this.isConnected ||
      !this.getClientRects().length
    ) {
      return;
    }
    const proposed = this.fitAddon.proposeDimensions();
    if (
      !proposed ||
      !Number.isFinite(proposed.cols) ||
      !Number.isFinite(proposed.rows)
    ) {
      return;
    }
    const cols = Math.max(MIN_COLUMNS, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    if (cols !== this.terminal.cols || rows !== this.terminal.rows) {
      this.terminal.resize(cols, rows);
    }
    if (this.size?.cols === cols && this.size?.rows === rows) {
      return;
    }
    this.size = { cols, rows };
    this.dispatchEvent(
      new CustomEvent<TerminalSize>(TERMINAL_VIEW_RESIZE_EVENT, {
        detail: { ...this.size },
      }),
    );
  }
}

/** Bytes for input xterm.js reported; binary input is one byte per character. */
export function terminalInputBytes(
  { data, binary }: { data: string; binary: boolean },
  encoder = new TextEncoder(),
) {
  return binary
    ? Uint8Array.from(`${data}`, (character) => character.charCodeAt(0) & 0xff)
    : encoder.encode(`${data}`);
}

function loadLibrary() {
  const attempt = libraryFailures ? `#retry-${libraryFailures}` : "";
  libraryPromise ??= Promise.all([
    import(`${XTERM_BASE}/lib/xterm.mjs${attempt}`),
    import(`${FIT_ADDON_BASE}/lib/addon-fit.mjs${attempt}`),
    loadStylesheet(`${XTERM_BASE}/css/xterm.css`),
  ]).then(
    ([xterm, fit, stylesheet]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
      stylesheet,
    }),
    (error) => {
      // Recovering the terminal loads it again.
      libraryFailures += 1;
      libraryPromise = null;
      throw error;
    },
  );
  return libraryPromise;
}

async function loadStylesheet(href: string) {
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(`${href} did not load (${response.status}).`);
  }
  const stylesheet = new CSSStyleSheet();
  stylesheet.replaceSync(await response.text());
  return stylesheet;
}

/** The Code-axis font and the theme colors the stylesheet gives the view. */
function terminalAppearance(element: Element) {
  const style = getComputedStyle(element);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    fontFamily: read("--font-code") || "monospace",
    fontSize: Number.parseFloat(read("--code-font-size")) || 13,
    theme: {
      background: read("--terminal-background"),
      foreground: read("--terminal-foreground"),
      cursor: read("--terminal-cursor"),
      cursorAccent: read("--terminal-background"),
      selectionBackground: read("--terminal-selection"),
    },
  };
}

/**
 * Follows one finger over the screen through the touch gesture model, since
 * xterm.js 6.0.0 scrolls its history only for the mouse wheel and selects only
 * with a mouse. The history scrolls a row for each row a finger drags; a
 * finger held still selects. A second finger ends the gesture and leaves it,
 * such as a pinch zoom, to the browser. Returns a function that ends a gesture
 * in progress, timers included.
 */
function followTouch(terminal: Terminal) {
  const screen = terminal.element.querySelector(".xterm-screen") as HTMLElement;
  const { IDLE } = TOUCH_GESTURE_NODE;
  const { PRESS, ABANDON, MOVE, HOLD_ELAPSED, EDGE_TICK, LIFT } =
    TOUCH_GESTURE_EVENT;
  let node: TouchGestureNode = IDLE;
  let holdTimer = 0;
  let edgeTimer = 0;
  let pressed = { x: 0, y: 0 };
  let finger = { x: 0, y: 0 };
  let pressedRow = 0;
  let scrolledToY = 0;
  let pixels = 0;
  let word: CellRange | null = null;

  screen.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) {
      apply({ type: ABANDON });
      return;
    }
    // A first finger starts afresh, whatever an earlier touch left behind.
    apply({ type: ABANDON });
    const { clientX, clientY } = event.touches[0];
    pressed = { x: clientX, y: clientY };
    finger = pressed;
    pressedRow = screenRow(clientY);
    scrolledToY = clientY;
    pixels = 0;
    apply({ type: PRESS });
  });
  screen.addEventListener(
    "touchmove",
    (event) => {
      if (node === IDLE) {
        return;
      }
      if (event.touches.length !== 1) {
        apply({ type: ABANDON });
        return;
      }
      event.preventDefault();
      const { clientX, clientY } = event.touches[0];
      finger = { x: clientX, y: clientY };
      apply({
        type: MOVE,
        pastSlop:
          Math.hypot(clientX - pressed.x, clientY - pressed.y) > TAP_SLOP_PX,
      });
    },
    { passive: false },
  );
  screen.addEventListener("touchend", (event) => {
    if (event.touches.length === 0 && apply({ type: LIFT })) {
      event.preventDefault();
    }
  });
  screen.addEventListener("touchcancel", () => apply({ type: ABANDON }));
  // Android sends a long press as a context menu, which xterm.js takes for a
  // right click: it moves its input under the finger and focuses it.
  terminal.element.addEventListener(
    "contextmenu",
    (event) => {
      if (node !== IDLE) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );

  // The only writer of `node`. Returns whether the touch's lift is the
  // gesture's, so the browser makes no tap of it.
  const apply = (event: TouchGestureEvent) => {
    const result = touchGestureTransition(node, event);
    if (!result) {
      return false;
    }
    node = result.node;
    let claimed = false;
    for (const effect of result.effects) {
      claimed = run(effect) || claimed;
    }
    return claimed;
  };

  const run = (effect: TouchGestureEffect) => {
    switch (effect) {
      case TOUCH_GESTURE_EFFECT.START_HOLD:
        holdTimer = window.setTimeout(
          () => apply({ type: HOLD_ELAPSED }),
          HOLD_MS,
        );
        return false;
      case TOUCH_GESTURE_EFFECT.CANCEL_HOLD:
        window.clearTimeout(holdTimer);
        return false;
      case TOUCH_GESTURE_EFFECT.SCROLL:
        scrollWithFinger();
        return false;
      case TOUCH_GESTURE_EFFECT.SELECT_WORD:
        word = wordAt(
          terminal.buffer.active,
          terminal.cols,
          cellUnder(pressed),
          terminal.options.wordSeparator ?? "",
        );
        select(word);
        return false;
      case TOUCH_GESTURE_EFFECT.STRETCH_SELECTION:
        stretchSelection();
        return false;
      case TOUCH_GESTURE_EFFECT.START_EDGE_SCROLL:
        edgeTimer = window.setInterval(
          () => apply({ type: EDGE_TICK }),
          EDGE_SCROLL_MS,
        );
        return false;
      case TOUCH_GESTURE_EFFECT.EDGE_SCROLL: {
        const direction = edgeScrollDirection(
          screenRow(finger.y),
          terminal.rows,
          pressedRow,
        );
        if (direction) {
          terminal.scrollLines(direction);
          stretchSelection();
        }
        return false;
      }
      case TOUCH_GESTURE_EFFECT.STOP_EDGE_SCROLL:
        window.clearInterval(edgeTimer);
        return false;
      case TOUCH_GESTURE_EFFECT.DISMISS_SELECTION:
        if (!terminal.hasSelection()) {
          return false;
        }
        terminal.clearSelection();
        return true;
      case TOUCH_GESTURE_EFFECT.CLAIM_LIFT:
        return true;
    }
  };

  const scrollWithFinger = () => {
    const rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    pixels += scrolledToY - finger.y;
    scrolledToY = finger.y;
    const rows = Math.trunc(pixels / rowHeight);
    if (rows) {
      pixels -= rows * rowHeight;
      terminal.scrollLines(rows);
    }
  };

  const stretchSelection = () => {
    if (word) {
      select(
        stretchFromWord(
          terminal.buffer.active,
          terminal.cols,
          word,
          cellUnder(finger),
        ),
      );
    }
  };

  const select = ({ x, y, length }: CellRange) => {
    terminal.select(x, y, length);
  };

  // The screen row under a client y, which lies outside the screen when the
  // finger does.
  const screenRow = (y: number) => {
    const box = screen.getBoundingClientRect();
    return Math.floor((y - box.top) / (box.height / terminal.rows));
  };

  // The buffer cell under a point, the nearest one when it lies outside.
  const cellUnder = ({ x, y }: { x: number; y: number }): CellPoint => {
    const box = screen.getBoundingClientRect();
    const column = Math.floor((x - box.left) / (box.width / terminal.cols));
    return {
      x: clamp(column, 0, terminal.cols - 1),
      y:
        terminal.buffer.active.viewportY +
        clamp(screenRow(y), 0, terminal.rows - 1),
    };
  };

  return () => {
    apply({ type: ABANDON });
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-terminal-view": CaffoldTerminalView;
  }

  interface HTMLElementEventMap {
    [TERMINAL_VIEW_RESIZE_EVENT]: CustomEvent<TerminalSize>;
    [TERMINAL_VIEW_INPUT_EVENT]: CustomEvent<TerminalViewInputDetail>;
    [TERMINAL_VIEW_SELECTION_EVENT]: CustomEvent<TerminalViewSelectionDetail>;
  }
}
