import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tasksRoot = fileURLToPath(
  new URL("../frontend/pages/(codex)/tasks/", import.meta.url),
);
const ownership = new Map([
  ["page.css", "caffold-tasks-page"],
  ["controls.css", "caffold-tasks-page"],
  ["components/task-status.css", "caffold-tasks-page"],
  ["components/detail.css", "caffold-task-detail"],
  ["components/conversation.css", "caffold-task-conversation"],
  ["components/composer.css", "caffold-task-composer"],
  ["components/navigator.css", "caffold-task-navigator"],
  ["components/review.css", "caffold-task-review"],
  ["components/task-new.css", "caffold-task-new"],
]);

function cssSelectors(css) {
  const selectors = [];
  let index = 0;
  while (index < css.length) {
    while (index < css.length && /\s/.test(css[index])) {
      index += 1;
    }
    if (index >= css.length) {
      break;
    }

    const open = css.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const prelude = css.slice(index, open).trim();
    let depth = 1;
    let close = open + 1;
    while (close < css.length && depth > 0) {
      if (css[close] === "{") {
        depth += 1;
      } else if (css[close] === "}") {
        depth -= 1;
      }
      close += 1;
    }
    assert.equal(depth, 0, `unbalanced CSS block after ${prelude}`);

    const body = css.slice(open + 1, close - 1);
    if (/^@(media|supports|layer|container)\b/.test(prelude)) {
      selectors.push(...cssSelectors(body));
    } else if (!prelude.startsWith("@")) {
      selectors.push(prelude);
    }
    index = close;
  }
  return selectors;
}

function selectorList(selector) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    if (selector[index] === "(" || selector[index] === "[") {
      depth += 1;
    } else if (selector[index] === ")" || selector[index] === "]") {
      depth -= 1;
    } else if (selector[index] === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

test("Tasks styles stay scoped to their owning component", () => {
  for (const [path, owner] of ownership) {
    const css = readFileSync(`${tasksRoot}${path}`, "utf8");
    for (const selector of cssSelectors(css).flatMap(selectorList)) {
      assert.ok(
        selector.startsWith(owner),
        `${path} selector must start with ${owner}: ${selector}`,
      );
    }
  }
});

test("Tasks page CSS does not style child component internals", () => {
  const css = readFileSync(`${tasksRoot}page.css`, "utf8");
  for (const childOwner of [
    "caffold-task-detail",
    "caffold-task-conversation",
    "caffold-task-composer",
    "caffold-task-review",
    "caffold-task-new",
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\b${childOwner}\\b`));
  }

  for (const childClass of [
    "task-detail",
    "task-conversation",
    "task-composer",
    "task-approval",
    "task-message",
    "task-thinking",
    "task-command",
    "task-tool",
    "task-turn",
    "task-stream",
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\.${childClass}(?:[-\\s:.[#>])`));
  }
});
