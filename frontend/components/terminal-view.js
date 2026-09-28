// The xterm.js terminal a terminal screen draws with. It fills the box CSS
// gives it, draws in the Code font and size, follows the theme, scrolls its
// history under a dragged finger, and reports typed input and its row and
// column count. xterm.js and its fit addon load from a pinned jsDelivr release
// the first time a terminal opens.

const XTERM_VERSION = "6.0.0";
const FIT_ADDON_VERSION = "0.11.0";
const XTERM_BASE = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}`;
const FIT_ADDON_BASE =
  `https://cdn.jsdelivr.net/npm/@xterm/addon-fit@${FIT_ADDON_VERSION}`;
// The backend keeps the same number of lines when it restores a screen.
const SCROLLBACK_LINES = 5_000;
const MIN_COLUMNS = 2;

export const TERMINAL_VIEW_INPUT_EVENT = "caffold:terminal-view-input";
export const TERMINAL_VIEW_RESIZE_EVENT = "caffold:terminal-view-resize";

let libraryPromise;
// A module that failed to load stays failed under its URL for the life of the
// page, so each later attempt imports it under a new fragment.
let libraryFailures = 0;

class CaffoldTerminalView extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    window.addEventListener("caffold:theme-change", this.boundAppearance);
    window.addEventListener("caffold:settings-change", this.boundAppearance);
    this.resizeObserver.observe(this);
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:theme-change", this.boundAppearance);
    window.removeEventListener("caffold:settings-change", this.boundAppearance);
    this.resizeObserver.disconnect();
    if (this.fitFrame) {
      cancelAnimationFrame(this.fitFrame);
      this.fitFrame = 0;
    }
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.terminal = null;
    this.fitAddon = null;
    this.opening = null;
    this.size = null;
    this.fitFrame = 0;
    this.encoder = new TextEncoder();
    this.boundAppearance = () => this.applyAppearance();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.innerHTML = `<div class="terminal-view-screen"></div>`;
  }

  /** Opens the terminal on first use. Resolves with its size once it has a box. */
  async open() {
    this.ensureRendered();
    this.opening ??= this.createTerminal().catch((error) => {
      this.opening = null;
      throw error;
    });
    await this.opening;
    this.fit();
    return this.size;
  }

  reset() {
    this.terminal?.reset();
  }

  write(bytes) {
    this.terminal?.write(bytes);
  }

  focus() {
    this.terminal?.focus();
  }

  setInputEnabled(enabled) {
    if (this.terminal) {
      this.terminal.options.disableStdin = !enabled;
    }
  }

  /** Types `text` as if it came from the keyboard. */
  sendInput(text) {
    this.terminal?.input(text, true);
  }

  applicationCursorKeys() {
    return Boolean(this.terminal?.modes.applicationCursorKeysMode);
  }

  /** The element xterm.js reads keyboard input from, once the terminal is open. */
  inputControl() {
    return this.terminal?.textarea ?? null;
  }

  ownsInput(element) {
    return Boolean(element) && element === this.inputControl();
  }

  async createTerminal() {
    const { Terminal, FitAddon } = await loadLibrary();
    const appearance = terminalAppearance(this);
    // Cells are measured when the terminal opens, so the Code font has to be
    // loaded by then.
    try {
      await document.fonts?.load(`${appearance.fontSize}px ${appearance.fontFamily}`);
    } catch {
      // A fallback font still gives the terminal a size.
    }
    const terminal = new Terminal({
      ...appearance,
      scrollback: SCROLLBACK_LINES,
      disableStdin: true,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(this.querySelector(":scope > .terminal-view-screen"));
    terminal.onData((data) => this.emitInput(data, false));
    terminal.onBinary((data) => this.emitInput(data, true));
    scrollOnTouch(terminal);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
  }

  emitInput(data, binary) {
    this.dispatchEvent(new CustomEvent(TERMINAL_VIEW_INPUT_EVENT, {
      detail: { data, binary },
    }));
  }

  applyAppearance() {
    if (!this.terminal) {
      return;
    }
    const { fontFamily, fontSize, theme } = terminalAppearance(this);
    this.terminal.options.fontFamily = fontFamily;
    this.terminal.options.fontSize = fontSize;
    this.terminal.options.theme = theme;
    this.scheduleFit();
  }

  scheduleFit() {
    if (this.fitFrame || !this.terminal) {
      return;
    }
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fit();
    });
  }

  /** Matches the rows and columns to the box, and reports a change. */
  fit() {
    if (!this.terminal || !this.isConnected || !this.getClientRects().length) {
      return;
    }
    const proposed = this.fitAddon.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) {
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
    this.dispatchEvent(new CustomEvent(TERMINAL_VIEW_RESIZE_EVENT, {
      detail: { ...this.size },
    }));
  }
}

if (!customElements.get("caffold-terminal-view")) {
  customElements.define("caffold-terminal-view", CaffoldTerminalView);
}

/** Bytes for input xterm.js reported; binary input is one byte per character. */
export function terminalInputBytes({ data, binary }, encoder = new TextEncoder()) {
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
    ([xterm, fit]) => ({
      Terminal: xterm.Terminal,
      FitAddon: fit.FitAddon,
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

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`${href} did not load.`));
    }, { once: true });
    document.head.append(link);
  });
}

/** The Code-axis font and the theme colors the stylesheet gives the view. */
function terminalAppearance(element) {
  const style = getComputedStyle(element);
  const read = (name) => style.getPropertyValue(name).trim();
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
function scrollOnTouch(terminal) {
  const screen = terminal.element.querySelector(".xterm-screen");
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
  screen.addEventListener("touchmove", (event) => {
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
  }, { passive: false });
}
