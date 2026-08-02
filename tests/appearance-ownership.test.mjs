import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));
const e2eSupportRoot = fileURLToPath(new URL("./e2e/support/", import.meta.url));

const conversationOwners = new Set([
  "pages/(codex)/tasks/components/composer.css",
  "pages/(codex)/tasks/components/detail/conversation.css",
  "pages/(codex)/tasks/components/detail/conversation/markdown.js",
  "pages/(review-workspace)/(github)/(issues)/detail/page.css",
  "pages/(review-workspace)/(github)/(pulls)/detail/page.css",
  "pages/(review-workspace)/(github)/components/markdown.js",
  "pages/settings/page.css",
  "settings.js",
  "styles.css",
]);

const codeOwners = new Set([
  "components/code-viewer.css",
  "components/diff-viewer.css",
  "pages/(codex)/tasks/components/detail/conversation.css",
  "pages/(codex)/tasks/components/detail/conversation/markdown.js",
  "pages/(review-workspace)/(github)/components/markdown.js",
  "pages/settings/page.css",
  "settings.js",
  "styles.css",
]);

test("legacy appearance writers and selectors stay removed", () => {
  const sources = frontendSources();
  const forbidden = [
    "--code-viewer-font-size",
    "--task-detail-font-size",
    "--task-detail-meta-size",
    "--task-detail-heading-size",
    "--task-detail-line-height",
    "--task-detail-composer-min-height",
    "--task-detail-composer-max-height",
    "data-file-tree-size",
    "data-code-size",
    "data-task-list-size",
    "data-task-detail-size",
    "setFileTreeSize",
    "setCodeSize",
    "setTaskListSize",
    "setTaskDetailSize",
    "FILE_TREE_SIZES",
    "CODE_SIZES",
    "TASK_LIST_SIZES",
    "TASK_DETAIL_SIZES",
  ];

  for (const [path, source] of sources) {
    for (const value of forbidden) {
      assert.equal(
        source.includes(value),
        false,
        `${path} must not restore legacy appearance contract ${value}`,
      );
    }
  }
});

test("conversation and code tokens stay within semantic content owners", () => {
  const sources = frontendSources();

  assert.deepEqual(
    tokenConsumers(sources, /--conversation-(?:font-size|line-height)/),
    [...conversationOwners].sort(),
  );
  assert.deepEqual(
    tokenConsumers(sources, /--code-(?:font-size|line-height)/),
    [...codeOwners].sort(),
  );
});

test("interface spacing scales instead of bypassing the appearance axis", () => {
  const declarations = frontendSources()
    .filter(([path]) => path.endsWith(".css"))
    .flatMap(([path, source]) =>
      [...source.matchAll(
        /^\s*(gap|row-gap|column-gap|padding(?:-(?:block|inline)(?:-(?:start|end))?|-(?:top|right|bottom|left))?|margin(?:-(?:block|inline)(?:-(?:start|end))?|-(?:top|right|bottom|left))?)\s*:\s*([^;]+);/gm,
      )].map((match) => ({ path, property: match[1], value: match[2].trim() })),
    );

  const bypasses = declarations.filter(({ value }) => /(?:^|\s|\()\d*\.?\d+px\b/.test(value));
  assert.deepEqual(
    bypasses,
    [],
    "Interface-owned spacing must use rem or semantic Interface tokens",
  );
});

test("common chrome shares one icon slot and control geometry", () => {
  const root = readFrontend("styles.css");
  for (const token of [
    "--interface-control-gap",
    "--interface-toolbar-gap",
    "--interface-toolbar-padding-inline",
    "--interface-control-padding-inline",
    "--interface-icon-size",
    "--interface-icon-small-size",
    "--interface-icon-large-size",
    "--interface-icon-slot-size",
  ]) {
    assert.match(root, new RegExp(`${token}:`));
  }

  const owners = [
    ["pages/components/header-actions.css", ".header-action-icon"],
    ["pages/(codex)/tasks/controls.css", ".task-action-icon"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-brand-button img"],
    ["pages/(codex)/tasks/components/detail/review.css", ".task-refresh-icon"],
    ["components/file-viewer.css", ".viewer-info-icon"],
    ["pages/(review-workspace)/layout.css", ".review-workspace-close-icon"],
  ];
  for (const [path, selector] of owners) {
    const source = readFrontend(path);
    const block = cssBlock(source, selector);
    assert.match(block, /width: var\(--interface-icon-size\)/, `${path} ${selector}`);
    assert.match(block, /height: var\(--interface-icon-size\)/, `${path} ${selector}`);
  }
});

test("visible inline icons have explicit block geometry from their UI owner", () => {
  const owners = [
    ["pages/components/app-menu.css", ".app-menu-item-icon", "--interface-icon-size"],
    ["pages/components/header-actions.css", ".header-action-icon", "--interface-icon-size"],
    ["pages/components/header-actions.css", ".header-action-brand-icon", "--interface-icon-size"],
    ["pages/components/header-actions.css", ".header-menu-icon", "--interface-icon-size"],
    ["pages/(review-workspace)/layout.css", ".review-workspace-close-icon", "--interface-icon-size"],
    ["pages/(review-workspace)/(git)/components/controls.css", ".git-review-refresh-icon", "--interface-icon-size"],
    ["pages/(review-workspace)/(git)/(log)/list/page.css", ".log-review-icon", "--interface-icon-small-size"],
    ["pages/(review-workspace)/(github)/(pulls)/detail/page.css", ".github-pull-files-icon", "--interface-icon-small-size"],
    ["pages/(review-workspace)/(github)/(pulls)/list/page.css", ".github-pull-icon", "--interface-icon-small-size"],
    ["pages/settings/page.css", ".settings-close-icon", "--interface-icon-size"],
    ["pages/settings/page.css", ".settings-preview-icon", "--task-list-icon-size"],
    ["pages/(codex)/layout.css", ".codex-workspace-close-icon", "--interface-icon-size"],
    ["pages/(codex)/tasks/controls.css", ".task-action-icon", "--interface-icon-size"],
    ["pages/(codex)/tasks/components/composer.css", ".task-send-icon", "--interface-icon-size"],
    ["pages/(codex)/tasks/components/detail/review.css", ".task-refresh-icon", "--interface-icon-size"],
    ["pages/(codex)/tasks/components/navigator.css", ".task-repository-icon", "--task-list-icon-size"],
    ["pages/(codex)/tasks/components/navigator.css", ".task-row-worktree-icon", "--task-list-icon-size"],
    ["components/file-browser/list.css", ".file-refresh-icon", "--interface-icon-size"],
    ["components/file-browser/list.css", ".entry-icon-svg", "--file-tree-icon-size"],
    ["components/file-viewer.css", ".viewer-refresh-icon", "--interface-icon-size"],
    ["components/file-viewer.css", ".viewer-info-icon", "--interface-icon-size"],
    ["components/pagination.css", ".pagination-icon", "--interface-icon-small-size"],
  ];

  for (const [path, selector, token] of owners) {
    const block = cssBlockContaining(readFrontend(path), selector, "width:");
    assert.match(block, /display: block/, `${path} ${selector}`);
    assert.match(block, new RegExp(`width: var\\(${token}\\)`), `${path} ${selector}`);
    assert.match(block, new RegExp(`height: var\\(${token}\\)`), `${path} ${selector}`);
  }
});

test("icon-only controls do not fall back to baseline-dependent text glyphs", () => {
  const sources = frontendSources();
  const forbidden = ["&times;", "&uarr;", "&#8964;"];

  for (const [path, source] of sources) {
    for (const glyph of forbidden) {
      assert.equal(
        source.includes(glyph),
        false,
        `${path} must render ${glyph} through the shared icon system`,
      );
    }
  }
});

test("the browser fixture renders every shared inline icon used by production", () => {
  const usedNames = new Set(
    frontendSources().flatMap(([, source]) =>
      [...source.matchAll(/renderInlineIcon\("([A-Za-z0-9]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  );
  const fixture = readFileSync(
    resolve(e2eSupportRoot, "browser-defaults.js"),
    "utf8",
  );
  const fixtureNames = new Set(
    [...fixture.matchAll(/export const ([A-Za-z0-9]+)\s*=/g)].map(
      (match) => match[1],
    ),
  );

  assert.deepEqual(
    [...usedNames].filter((name) => !fixtureNames.has(name)).sort(),
    [],
    "Playwright must not silently replace production icons with screen-reader-only placeholders",
  );
});

test("representative icon-only controls use square semantic slots", () => {
  const owners = [
    ["pages/components/header-actions.css", ".header-action-group-button", "--interface-control-size"],
    ["pages/settings/page.css", ".settings-close-button", "--interface-control-size"],
    ["pages/(review-workspace)/layout.css", ".review-workspace-close", "--interface-compact-control-size"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-brand-button", "--interface-control-size"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-detail-info-button", "--interface-control-size"],
    ["components/file-browser/list.css", ".file-refresh-button", "--interface-compact-control-size"],
    ["components/file-viewer.css", ".viewer-info-button", "--interface-control-size"],
    ["pages/(review-workspace)/(git)/components/controls.css", ".git-review-refresh", "--interface-compact-control-size"],
  ];

  for (const [path, selector, token] of owners) {
    const block = cssBlockContaining(readFrontend(path), selector, "width:");
    assert.match(block, new RegExp(`width: var\\(${token}\\)`), `${path} ${selector}`);
    assert.match(block, new RegExp(`height: var\\(${token}\\)`), `${path} ${selector}`);
    assert.match(block, /place-items: center/, `${path} ${selector}`);
  }
});

test("mixed surfaces keep content and controls on separate axes", () => {
  const composer = readFrontend(
    "pages/(codex)/tasks/components/composer.css",
  );
  assert.match(
    composer,
    /\.task-composer textarea[\s\S]*font-size: var\(--conversation-font-size\)/,
  );
  assert.match(
    composer,
    /\.task-model-button[\s\S]*min-height: var\(--interface-compact-control-size\)/,
  );
  assert.doesNotMatch(composer, /\.task-(?:model|permission)-(?:icon|caret)/);
  assert.match(
    composer,
    /\.task-model-popover,[\s\S]*padding: 0\.5rem;/,
  );
  assert.match(
    composer,
    /\.task-model-option \{[\s\S]*gap: 0\.5rem;[\s\S]*padding: 0\.375rem;/,
  );

  const conversation = readFrontend(
    "pages/(codex)/tasks/components/detail/conversation.css",
  );
  assert.match(
    conversation,
    /\.task-approval-card p[\s\S]*font-size: var\(--conversation-font-size\)/,
  );
  assert.match(
    conversation,
    /\.task-approval-card pre[\s\S]*font-size: var\(--code-font-size\)/,
  );
  assert.match(
    conversation,
    /\.task-approval-actions[\s\S]*\.task-history-error button[\s\S]*min-height: var\(--interface-compact-control-size\)/,
  );
});

function tokenConsumers(sources, pattern) {
  return sources
    .filter(([, source]) => pattern.test(source))
    .map(([path]) => path)
    .sort();
}

function frontendSources() {
  return walk(frontendRoot).map((absolutePath) => [
    relative(frontendRoot, absolutePath),
    readFileSync(absolutePath, "utf8"),
  ]);
}

function readFrontend(path) {
  return readFileSync(resolve(frontendRoot, path), "utf8");
}

function cssBlock(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `missing selector ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(start, close + 1);
}

function cssBlockContaining(source, selector, requiredText) {
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf(selector, offset);
    assert.notEqual(start, -1, `missing selector ${selector}`);
    const open = source.indexOf("{", start);
    const close = source.indexOf("}", open);
    const block = source.slice(start, close + 1);
    if (block.includes(requiredText)) {
      return block;
    }
    offset = close + 1;
  }
  assert.fail(`missing ${requiredText} in selector ${selector}`);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.(?:css|js)$/.test(entry.name) ? [path] : [];
  });
}
