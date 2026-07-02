import { escapeHtml } from "./dom.js";

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

class CodgerDiffViewer extends HTMLElement {
  connectedCallback() {
    if (this.diff) {
      this.render();
    }
  }

  setDiff(diff) {
    this.diff = diff;
    this.render();
  }

  render() {
    const rows = parseUnifiedDiff(this.diff?.diff ?? "");
    const codeWidth = `${diffCodeColumns(rows)}ch`;
    this.innerHTML = `
      <section class="diff-viewer" aria-label="Git diff">
        <div class="diff-lines">
          <div class="diff-gutter-backdrop" aria-hidden="true"></div>
          <div class="diff-table" style="--diff-code-width: ${codeWidth};">
            ${rows.length === 0 ? this.renderEmpty() : rows.map((row) => this.renderRow(row)).join("")}
          </div>
        </div>
      </section>
    `;
  }

  renderEmpty() {
    return `
      <div class="diff-row diff-row-empty">
        <span class="diff-gutter" aria-hidden="true">
          <span class="diff-old-line"></span>
          <span class="diff-new-line"></span>
          <span class="diff-prefix"></span>
        </span>
        <span class="diff-code">No diff for this file.</span>
      </div>
    `;
  }

  renderRow(row) {
    return `
      <div class="diff-row diff-row-${escapeHtml(row.type)}">
        <span class="diff-gutter">
          <span class="diff-old-line">${escapeHtml(row.oldLine ?? "")}</span>
          <span class="diff-new-line">${escapeHtml(row.newLine ?? "")}</span>
          <span class="diff-prefix">${escapeHtml(row.prefix)}</span>
        </span>
        <span class="diff-code">${escapeHtml(row.content)}</span>
      </div>
    `;
  }
}

customElements.define("codger-diff-viewer", CodgerDiffViewer);

function diffCodeColumns(rows) {
  const columns = rows.reduce((max, row) => {
    return Math.max(max, monospaceColumns(row.content));
  }, 0);

  return Math.max(columns, "No diff for this file.".length, 1);
}

function monospaceColumns(text) {
  let columns = 0;

  for (const char of text) {
    columns += char === "\t" ? 4 : 1;
  }

  return columns;
}

function parseUnifiedDiff(diffText) {
  if (!diffText) {
    return [];
  }

  const rows = [];
  let oldLine = null;
  let newLine = null;
  let inHunk = false;

  for (const line of diffText.split("\n")) {
    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[2]);
      inHunk = true;
      rows.push({
        type: "hunk",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: line,
      });
      continue;
    }

    if (!inHunk || isDiffMetadataLine(line)) {
      rows.push({
        type: "metadata",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      rows.push({
        type: "note",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+")) {
      rows.push({
        type: "added",
        oldLine: null,
        newLine,
        prefix: "+",
        content: line.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      rows.push({
        type: "removed",
        oldLine,
        newLine: null,
        prefix: "-",
        content: line.slice(1),
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      rows.push({
        type: "context",
        oldLine,
        newLine,
        prefix: " ",
        content: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rows.push({
      type: "metadata",
      oldLine: null,
      newLine: null,
      prefix: "",
      content: line,
    });
  }

  return rows;
}

function isDiffMetadataLine(line) {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}
