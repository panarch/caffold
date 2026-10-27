// The xterm.js terminal a terminal screen draws with. It fills the box CSS
// gives it, draws in the Code font and size, follows the theme, scrolls its
// history under a dragged finger, and reports typed input and its row and
// column count. xterm.js and its fit addon load from a pinned jsDelivr release
// the first time a terminal opens.

import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";
import { DrawnRef, drawn } from "./drawn-refs.js";

import styles from "./terminal-view.css.js";

export interface TerminalViewInputDetail {
  data: string;
  binary: boolean;
}

const XTERM_VERSION = "6.0.0";
const FIT_ADDON_VERSION = "0.11.0";
const XTERM_BASE = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}`;
const FIT_ADDON_BASE = `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_ADDON_VERSION}`;
// The backend keeps the same number of lines when it restores a screen.
const SCROLLBACK_LINES = 5_000;
const MIN_COLUMNS = 2;

export const TERMINAL_VIEW_INPUT_EVENT = "caffold:terminal-view-input";
export const TERMINAL_VIEW_RESIZE_EVENT = "caffold:terminal-view-resize";

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
}

interface Terminal {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly modes: { applicationCursorKeysMode: boolean };
  options: TerminalOptions;
  loadAddon(addon: FitAddon): void;
  open(parent: HTMLElement): void;
  onData(listener: (data: string) => void): void;
  onBinary(listener: (data: string) => void): void;
  dispose(): void;
  reset(): void;
  write(data: Uint8Array | string): void;
  focus(): void;
  input(data: string, wasUserInput: boolean): void;
  resize(columns: number, rows: number): void;
  scrollLines(amount: number): void;
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
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.size = null;
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
    scrollOnTouch(terminal);
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
 * Scrolls the history a row for each row one finger drags over the screen,
 * which xterm.js 6.0.0 does only for the mouse wheel. A second finger leaves
 * the gesture to the browser.
 */
function scrollOnTouch(terminal: Terminal) {
  const screen = terminal.element.querySelector(".xterm-screen") as HTMLElement;
  let dragging = false;
  let lastY = 0;
  let rowHeight = 0;
  let pixels = 0;
  screen.addEventListener("touchstart", (event) => {
    dragging = event.touches.length === 1;
    lastY = event.touches[0].clientY;
    rowHeight = screen.getBoundingClientRect().height / terminal.rows;
    pixels = 0;
  });
  screen.addEventListener(
    "touchmove",
    (event) => {
      dragging &&= event.touches.length === 1;
      if (!dragging) {
        return;
      }
      event.preventDefault();
      const y = event.touches[0].clientY;
      pixels += lastY - y;
      lastY = y;
      const rows = Math.trunc(pixels / rowHeight);
      if (rows) {
        pixels -= rows * rowHeight;
        terminal.scrollLines(rows);
      }
    },
    { passive: false },
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-terminal-view": CaffoldTerminalView;
  }

  interface HTMLElementEventMap {
    [TERMINAL_VIEW_RESIZE_EVENT]: CustomEvent<TerminalSize>;
    [TERMINAL_VIEW_INPUT_EVENT]: CustomEvent<TerminalViewInputDetail>;
  }
}
