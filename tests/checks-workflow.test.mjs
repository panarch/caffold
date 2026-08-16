import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/checks.yml"),
  "utf8",
);

test("browser CI runs one explicit job per viewport project", () => {
  assert.match(workflow, /name: Browser Tests \/ \$\{\{ matrix\.project \}\}/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /project: \[desktop, foldable, phone\]/);
  assert.match(
    workflow,
    /npm run test:e2e -- --project=\$\{\{ matrix\.project \}\}/,
  );
  assert.match(
    workflow,
    /name: playwright-results-\$\{\{ matrix\.project \}\}/,
  );
});

test("browser CI preserves one stable aggregate check", () => {
  const gate = workflow.slice(workflow.indexOf("  browser_gate:"));
  assert.match(gate, /^  browser_gate:\n    name: Browser Tests$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^    needs: browser$/m);
  assert.match(gate, /BROWSER_RESULT: \$\{\{ needs\.browser\.result \}\}/);
});
