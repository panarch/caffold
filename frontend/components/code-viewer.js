import { escapeHtml, languageLabel } from "./dom.js";

const HIGHLIGHT_IMPORT = "https://esm.sh/highlight.js@11.11.1/lib/common";

let highlighterPromise;

class CodgerCodeViewer extends HTMLElement {
  setFile(file) {
    this.file = file;
    this.renderPlain();
    this.renderHighlighted();
  }

  renderPlain() {
    const language = languageLabel(this.file.languageHint);
    this.innerHTML = `
      <section class="code-viewer" data-highlighted="false">
        <header>
          <span>${escapeHtml(language)}</span>
        </header>
        <div class="code-lines" role="region" aria-label="File content">
          ${renderLines(escapeHtml(this.file.content))}
        </div>
      </section>
    `;
  }

  async renderHighlighted() {
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
          <div class="code-lines" role="region" aria-label="File content">
            ${renderLines(highlighted)}
          </div>
        </section>
      `;
    } catch {
      // CDN import is an enhancement. The plain renderer above remains valid.
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

customElements.define("codger-code-viewer", CodgerCodeViewer);
