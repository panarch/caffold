import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../scroll-scope.js";
import { syntaxLineHtml } from "../syntax-spans.js";

class CaffoldCodeViewer extends HTMLElement {
  setFile(file, options = {}) {
    const scroll =
      options.scroll ?? (options.preserveScroll ? this.captureScroll() : null);
    const line = normalizeLine(options.line);
    this.file = file;
    this.render();
    this.restorePosition(scroll, line);
  }

  render() {
    this.innerHTML = `
      <section class="code-viewer">
        ${renderCodeLines(this.file)}
      </section>
    `;
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
        axes: ["vertical", "horizontal"],
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          this.querySelector(":scope > .code-viewer > .code-lines") ===
            scrollport &&
          isCurrent() &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
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

function renderCodeLines(file) {
  const codeWidth = `${codeColumns(file.content)}ch`;
  const lineNumberColumns = `${lineNumberDigits(file.content)}ch`;

  return `
    <div
      class="code-lines"
      role="region"
      aria-label="File content"
      style="--code-line-number-columns: ${lineNumberColumns};"
    >
      <div class="code-gutter-backdrop" aria-hidden="true"></div>
      <div class="code-table" style="--code-content-width: ${codeWidth};">
        ${renderLines(file)}
      </div>
    </div>
  `;
}

function renderLines(file) {
  const lines = file.content.split(/\r?\n/);

  return lines
    .map((line, index) => {
      const content =
        line.length === 0 ? "&nbsp;" : syntaxLineHtml(line, file.syntaxSpans?.[index]);
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
