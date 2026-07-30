import assert from "node:assert/strict";

const GROUPING_AT_RULES = new Set([
  "container",
  "document",
  "layer",
  "media",
  "scope",
  "starting-style",
  "supports",
]);

export function effectiveSelectors(css) {
  const selectors = [];
  walkRules(css, 0, css.length, [], selectors);
  return selectors;
}

export function ownershipViolations(css, { owners, path = "<css>" }) {
  assert.ok(Array.isArray(owners) && owners.length > 0, `${path} must declare an owner`);
  const violations = [];
  for (const selector of effectiveSelectors(css)) {
    const owner = lastOwnerOccurrence(selector, owners);
    if (!owner) {
      violations.push(`${path} selector must include ${owners.join(" or ")}: ${selector}`);
      continue;
    }

    const foreignChild = firstForeignCustomElement(selector, owner.end, owners);
    if (!foreignChild) {
      continue;
    }
    if (!hasTopLevelCombinatorBetween(selector, owner.end, foreignChild.start)) {
      violations.push(
        `${path} selector includes undeclared component ${foreignChild.name}: ${selector}`,
      );
    } else if (hasCombinatorAfter(selector, foreignChild.end)) {
      violations.push(
        `${path} selector crosses into ${foreignChild.name} internals: ${selector}`,
      );
    }
  }
  return violations;
}

function walkRules(css, start, end, parentSelectors, selectors) {
  for (const rule of parseRuleList(css, start, end)) {
    const prelude = cleanPrelude(rule.prelude);
    if (!prelude) {
      continue;
    }

    if (prelude.startsWith("@")) {
      const [atRule] = prelude.slice(1).match(/^[\w-]+/) ?? [];
      if (atRule === "nest") {
        const nestedPrelude = prelude.slice("@nest".length + 1).trim();
        appendQualifiedRule(
          css,
          rule,
          nestedPrelude,
          parentSelectors,
          selectors,
        );
      } else if (GROUPING_AT_RULES.has(atRule)) {
        walkRules(css, rule.bodyStart, rule.bodyEnd, parentSelectors, selectors);
      }
      continue;
    }

    appendQualifiedRule(css, rule, prelude, parentSelectors, selectors);
  }
}

function appendQualifiedRule(css, rule, prelude, parentSelectors, selectors) {
  const localSelectors = splitSelectorList(prelude);
  const resolvedSelectors =
    parentSelectors.length === 0
      ? localSelectors
      : parentSelectors.flatMap((parent) =>
          localSelectors.map((local) => resolveNestedSelector(parent, local)),
        );
  if (hasTopLevelDeclarations(css, rule.bodyStart, rule.bodyEnd)) {
    selectors.push(...resolvedSelectors);
  }
  walkRules(css, rule.bodyStart, rule.bodyEnd, resolvedSelectors, selectors);
}

function hasTopLevelDeclarations(css, start, end) {
  let index = start;
  while (index < end) {
    index = skipTrivia(css, index, end);
    if (index >= end) {
      return false;
    }

    const delimiter = findRuleDelimiter(css, index, end);
    if (!delimiter) {
      const trailing = cleanPrelude(css.slice(index, end));
      return Boolean(trailing && !trailing.startsWith("@") && trailing.includes(":"));
    }
    if (delimiter.char === ";") {
      const statement = cleanPrelude(css.slice(index, delimiter.index));
      if (statement && !statement.startsWith("@") && statement.includes(":")) {
        return true;
      }
      index = delimiter.index + 1;
      continue;
    }
    if (delimiter.char === "{") {
      index = findMatchingBrace(css, delimiter.index, end) + 1;
      continue;
    }
    return false;
  }
  return false;
}

function parseRuleList(css, start, end) {
  const rules = [];
  let index = start;
  while (index < end) {
    index = skipTrivia(css, index, end);
    if (index >= end) {
      break;
    }

    const preludeStart = index;
    const delimiter = findRuleDelimiter(css, index, end);
    if (!delimiter) {
      break;
    }

    if (delimiter.char === ";") {
      index = delimiter.index + 1;
      continue;
    }
    if (delimiter.char === "}") {
      break;
    }

    const bodyEnd = findMatchingBrace(css, delimiter.index, end);
    rules.push({
      prelude: css.slice(preludeStart, delimiter.index),
      bodyStart: delimiter.index + 1,
      bodyEnd,
    });
    index = bodyEnd + 1;
  }
  return rules;
}

function findRuleDelimiter(css, start, end) {
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = start; index < end; index += 1) {
    const char = css[index];
    const next = css[index + 1];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipComment(css, index, end) - 1;
      continue;
    }
    if (char === "(") {
      parentheses += 1;
      continue;
    }
    if (char === ")") {
      parentheses -= 1;
      continue;
    }
    if (char === "[") {
      brackets += 1;
      continue;
    }
    if (char === "]") {
      brackets -= 1;
      continue;
    }
    if (parentheses === 0 && brackets === 0 && (char === ";" || char === "{" || char === "}")) {
      return { char, index };
    }
  }
  return null;
}

function findMatchingBrace(css, open, end) {
  let depth = 1;
  let quote = "";
  for (let index = open + 1; index < end; index += 1) {
    const char = css[index];
    const next = css[index + 1];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipComment(css, index, end) - 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(`unbalanced CSS block after ${cleanPrelude(css.slice(0, open))}`);
}

function splitSelectorList(selector) {
  const selectors = [];
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      parentheses += 1;
    } else if (char === ")") {
      parentheses -= 1;
    } else if (char === "[") {
      brackets += 1;
    } else if (char === "]") {
      brackets -= 1;
    } else if (char === "," && parentheses === 0 && brackets === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selector.slice(start).trim());
  return selectors.filter(Boolean);
}

function resolveNestedSelector(parent, child) {
  if (child.includes("&")) {
    return child.replaceAll("&", parent).trim();
  }
  return `${parent} ${child}`.trim();
}

function cleanPrelude(prelude) {
  return prelude.replaceAll(/\/\*[\s\S]*?\*\//g, " ").trim();
}

function skipTrivia(css, start, end) {
  let index = start;
  while (index < end) {
    if (/\s/.test(css[index])) {
      index += 1;
    } else if (css[index] === "/" && css[index + 1] === "*") {
      index = skipComment(css, index, end);
    } else {
      break;
    }
  }
  return index;
}

function skipComment(css, start, end) {
  const close = css.indexOf("*/", start + 2);
  if (close < 0 || close >= end) {
    throw new Error("unclosed CSS comment");
  }
  return close + 2;
}

function lastOwnerOccurrence(selector, owners) {
  let match = null;
  for (const owner of owners) {
    const pattern = new RegExp(`(^|[^\\w-])(${escapeRegExp(owner)})(?![\\w-])`, "g");
    for (const occurrence of selector.matchAll(pattern)) {
      const start = occurrence.index + occurrence[1].length;
      if (!match || start > match.start) {
        match = {
          end: start + occurrence[2].length,
          name: owner,
          start,
        };
      }
    }
  }
  return match;
}

function firstForeignCustomElement(selector, start, owners) {
  const pattern = /(^|[^\w-])(caffold-[a-z0-9-]+)(?![\w-])/g;
  for (const match of selector.matchAll(pattern)) {
    const matchStart = match.index + match[1].length;
    if (matchStart >= start && !owners.includes(match[2])) {
      return {
        end: matchStart + match[2].length,
        name: match[2],
        start: matchStart,
      };
    }
  }
  return null;
}

function hasCombinatorAfter(selector, start) {
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  let targetParentheses = null;
  let targetBrackets = null;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parentheses += 1;
      continue;
    }
    if (char === ")") {
      parentheses -= 1;
      continue;
    }
    if (char === "[") {
      brackets += 1;
      continue;
    }
    if (char === "]") {
      brackets -= 1;
      continue;
    }
    if (index < start) {
      continue;
    }
    targetParentheses ??= parentheses;
    targetBrackets ??= brackets;
    if (parentheses > targetParentheses || brackets > targetBrackets) {
      continue;
    }
    if (char === ">" || char === "+" || char === "~") {
      return true;
    }
    if (/\s/.test(char) && selector.slice(index).trim().length > 0) {
      return true;
    }
  }
  return false;
}

function hasTopLevelCombinatorBetween(selector, start, end) {
  let parentheses = 0;
  let brackets = 0;
  let quote = "";
  for (let index = 0; index < end; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parentheses += 1;
      continue;
    }
    if (char === ")") {
      parentheses -= 1;
      continue;
    }
    if (char === "[") {
      brackets += 1;
      continue;
    }
    if (char === "]") {
      brackets -= 1;
      continue;
    }
    if (index < start || parentheses > 0 || brackets > 0) {
      continue;
    }
    if (char === ">" || char === "+" || char === "~" || /\s/.test(char)) {
      return true;
    }
  }
  return false;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
