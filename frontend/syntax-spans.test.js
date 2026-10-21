import assert from "node:assert/strict";
import test from "node:test";

import { syntaxLineHtml } from "./syntax-spans.js";

test("wraps each span in its color class and escapes the text around it", () => {
  assert.equal(
    syntaxLineHtml('if (a < b) return "<b>";', [
      [0, 2, 1],
      [11, 6, 1],
      [18, 5, 3],
    ]),
    '<span class="syntax-keyword">if</span> (a &lt; b) ' +
      '<span class="syntax-keyword">return</span> ' +
      '<span class="syntax-string">&quot;&lt;b&gt;&quot;</span>;',
  );
});

test("names all six colors in the server's order", () => {
  assert.equal(
    syntaxLineHtml("abcdef", [0, 1, 2, 3, 4, 5].map((color) => [color, 1, color])),
    [
      "comment",
      "keyword",
      "literal",
      "string",
      "title",
      "type",
    ]
      .map((name, index) => `<span class="syntax-${name}">${"abcdef"[index]}</span>`)
      .join(""),
  );
});

test("counts positions in UTF-16 units", () => {
  assert.equal(
    syntaxLineHtml('let 이름 = "😀";', [[9, 4, 3]]),
    'let 이름 = <span class="syntax-string">&quot;😀&quot;</span>;',
  );
});

test("leaves a line without spans as escaped text", () => {
  assert.equal(syntaxLineHtml("a && b", undefined), "a &amp;&amp; b");
  assert.equal(syntaxLineHtml("", []), "");
});

test("skips spans it cannot place", () => {
  assert.equal(
    syntaxLineHtml("abc", [
      [0, 2, 9],
      [1, 1, 0],
      [0, 1, 0],
    ]),
    'a<span class="syntax-comment">b</span>c',
  );
});
