import { escapeHtml } from "./dom.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../scroll-scope.js";

const HIGHLIGHT_IMPORT = "https://esm.sh/highlight.js@11.11.1/lib/common";

let highlighterPromise;

class CaffoldCodeViewer extends HTMLElement {
  setFile(file, options = {}) {
    const scroll =
      options.scroll ?? (options.preserveScroll ? this.captureScroll() : null);
    const line = normalizeLine(options.line);
    this.file = file;
    this.renderPlain();
    this.restorePosition(scroll, line);
    this.renderHighlighted(scroll, line);
  }

  renderPlain() {
    this.innerHTML = `
      <section class="code-viewer" data-highlighted="false">
        ${renderCodeLines(escapeHtml(this.file.content), this.file.content)}
      </section>
    `;
  }

  async renderHighlighted(scroll = null, line = null) {
    const renderToken = Symbol("highlight");
    this.renderToken = renderToken;

    try {
      const highlighted = await highlightCode(this.file.content, this.file.languageHint);
      if (this.renderToken !== renderToken) {
        return;
      }

      this.innerHTML = `
        <section class="code-viewer" data-highlighted="true">
          ${renderCodeLines(highlighted, this.file.content)}
        </section>
      `;
      this.restorePosition(scroll, line);
    } catch {
      // CDN import is an enhancement. The plain renderer above remains valid.
    }
  }

  captureScroll() {
    const scroller = this.querySelector(".code-lines");
    return scroller
      ? { top: scroller.scrollTop, left: scroller.scrollLeft }
      : null;
  }

  getScrollState() {
    return this.captureScroll();
  }

  scrollSurfaceScope({
    scopeId = "",
    label = "File content",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(
      ":scope > .code-viewer > .code-lines",
    );
    if (!scopeId || !label || !scrollport || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(":scope > .code-viewer > .code-lines") ===
            scrollport &&
          isCurrent() &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  visibleLine() {
    const scroller = this.querySelector(".code-lines");
    if (!scroller) {
      return null;
    }
    const scrollerTop = scroller.getBoundingClientRect().top;
    const row = Array.from(
      this.querySelectorAll(".code-row[data-line-number]"),
    ).find((candidate) => candidate.getBoundingClientRect().bottom > scrollerTop);
    return normalizeLine(row?.dataset.lineNumber);
  }

  scrollToLine(line) {
    const targetLine = normalizeLine(line);
    const scroller = this.querySelector(".code-lines");
    if (!targetLine || !scroller) {
      return false;
    }
    const row = this.querySelector(
      `.code-row[data-line-number="${targetLine}"]`,
    );
    if (!row) {
      return false;
    }
    const firstRow = this.querySelector(".code-row[data-line-number]");
    scroller.scrollTop = row.offsetTop - (firstRow?.offsetTop ?? 0) + 1;
    return true;
  }

  restoreScroll(scroll) {
    if (!scroll) {
      return;
    }
    const scroller = this.querySelector(".code-lines");
    if (scroller) {
      scroller.scrollTop = scroll.top;
      scroller.scrollLeft = scroll.left;
    }
  }

  restorePosition(scroll, line) {
    if (scroll) {
      this.restoreScroll(scroll);
      return;
    }
    this.scrollToLine(line);
  }
}

async function highlightCode(code, language) {
  const hljs = await getHighlighter();

  if (language && hljs.getLanguage?.(language)) {
    return hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    }).value;
  }

  return hljs.highlightAuto(code).value;
}

async function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import(HIGHLIGHT_IMPORT).then((module) => module.default ?? module);
  }

  return highlighterPromise;
}

function renderCodeLines(html, rawContent) {
  const codeWidth = `${codeColumns(rawContent)}ch`;
  const lineNumberColumns = `${lineNumberDigits(rawContent)}ch`;

  return `
    <div
      class="code-lines"
      role="region"
      aria-label="File content"
      style="--code-line-number-columns: ${lineNumberColumns};"
    >
      <div class="code-gutter-backdrop" aria-hidden="true"></div>
      <div class="code-table" style="--code-content-width: ${codeWidth};">
        ${renderLines(html)}
      </div>
    </div>
  `;
}

function renderLines(html) {
  const lines = html.split(/\r?\n/);

  return lines
    .map((line, index) => {
      const content = line.length === 0 ? "&nbsp;" : line;
      return `
        <div class="code-row" data-line-number="${index + 1}">
          <span class="line-number">${index + 1}</span>
          <code class="line-code">${content}</code>
        </div>
      `;
    })
    .join("");
}

function normalizeLine(line) {
  const value = Number(line);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function codeColumns(content) {
  const columns = content.split(/\r?\n/).reduce((max, line) => {
    return Math.max(max, monospaceColumns(line));
  }, 0);

  return Math.max(columns, 1);
}

function lineNumberDigits(content) {
  const lineCount = content.split(/\r?\n/).length;
  return Math.max(String(lineCount).length, 2);
}

function monospaceColumns(text) {
  let columns = 0;

  for (const char of text) {
    columns += char === "\t" ? 4 : 1;
  }

  return columns;
}

customElements.define("caffold-code-viewer", CaffoldCodeViewer);
