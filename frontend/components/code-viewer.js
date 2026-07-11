import { escapeHtml, languageLabel } from "./dom.js";

const HIGHLIGHT_IMPORT = "https://esm.sh/highlight.js@11.11.1/lib/common";

let highlighterPromise;

class CaffoldCodeViewer extends HTMLElement {
  setFile(file, options = {}) {
    const scroll = options.scroll ?? (options.preserveScroll ? this.captureScroll() : null);
    this.file = file;
    this.renderPlain();
    this.restoreScroll(scroll);
    this.renderHighlighted(scroll);
  }

  renderPlain() {
    const language = languageLabel(this.file.languageHint);
    this.innerHTML = `
      <section class="code-viewer" data-highlighted="false">
        <header>
          <span>${escapeHtml(language)}</span>
        </header>
        ${renderCodeLines(escapeHtml(this.file.content), this.file.content)}
      </section>
    `;
  }

  async renderHighlighted(scroll = null) {
    const renderToken = Symbol("highlight");
    this.renderToken = renderToken;

    try {
      const highlighted = await highlightCode(this.file.content, this.file.languageHint);
      if (this.renderToken !== renderToken) {
        return;
      }

      const language = languageLabel(this.file.languageHint);
      this.innerHTML = `
        <section class="code-viewer" data-highlighted="true">
          <header>
            <span>${escapeHtml(language)}</span>
          </header>
          ${renderCodeLines(highlighted, this.file.content)}
        </section>
      `;
      this.restoreScroll(scroll);
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

  return `
    <div class="code-lines" role="region" aria-label="File content">
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
        <div class="code-row">
          <span class="line-number">${index + 1}</span>
          <code class="line-code">${content}</code>
        </div>
      `;
    })
    .join("");
}

function codeColumns(content) {
  const columns = content.split(/\r?\n/).reduce((max, line) => {
    return Math.max(max, monospaceColumns(line));
  }, 0);

  return Math.max(columns, 1);
}

function monospaceColumns(text) {
  let columns = 0;

  for (const char of text) {
    columns += char === "\t" ? 4 : 1;
  }

  return columns;
}

customElements.define("caffold-code-viewer", CaffoldCodeViewer);
