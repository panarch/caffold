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
  "pages/(codex)/tasks/components/detail/conversation/command-dialog.css",
  "pages/(codex)/tasks/components/detail/conversation/markdown.js",
  "pages/(review-workspace)/(github)/components/markdown.js",
  "pages/settings/page.css",
  "settings.js",
  "styles.css",
]);

const typefaceOwners = new Set([
  "components/code-viewer.css",
  "components/diff-viewer.css",
  "fonts.js",
  "pages/(codex)/tasks/components/detail/conversation/markdown.js",
  "pages/(review-workspace)/(github)/components/markdown.js",
  "pages/settings/page.css",
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

test("UI and code typeface roles stay within semantic owners", () => {
  const sources = frontendSources();

  assert.deepEqual(
    tokenConsumers(sources, /--font-(?:ui|code)/),
    [...typefaceOwners].sort(),
  );
  assert.equal(
    sources.some(([, source]) => source.includes("--font-mono")),
    false,
    "The legacy shared typeface token must not collapse UI and code roles",
  );
});

test("color roles keep neutral chrome, interactions, and semantic feedback separate", () => {
  const root = readFrontend("styles.css");
  for (const token of [
    "--surface-subtle",
    "--border-subtle",
    "--focus-ring",
    "--control-fg",
    "--control-selected-fg",
    "--tap-highlight-color",
    "--row-hover-bg",
    "--control-hover-bg",
    "--selection-bg",
    "--link-fg",
    "--primary-action-fg",
    "--primary-action-bg",
    "--primary-action-border",
    "--success",
    "--related-file-fg",
    "--related-file-marker-bg",
    "--warning",
    "--danger",
    "--diff-added-bg",
    "--diff-removed-bg",
  ]) {
    assert.match(root, new RegExp(`${token}:`));
  }

  assert.match(root, /--bg: #f5f5f5/);
  assert.match(root, /--surface-muted: #f1f1f1/);
  assert.match(root, /--border: #d4d4d4/);
  assert.match(root, /--text: #1f1f1f/);
  assert.match(root, /--code-gutter: #f2f2f2/);
  assert.match(root, /--focus-ring: #525252/);
  assert.match(root, /--row-hover-bg: #f5f5f5/);
  assert.match(root, /--control-hover-bg: #e5e5e5/);
  assert.match(root, /--selection-bg: #e5e5e5/);
  assert.match(root, /--selection-indicator: #737373/);
  assert.match(root, /--success: #167c5c/);
  assert.match(
    root,
    /html\s*\{[\s\S]*-webkit-tap-highlight-color: var\(--tap-highlight-color\)/,
    "Touch feedback must stay visible and use the shared neutral highlight role",
  );
  assert.doesNotMatch(
    root,
    /-webkit-tap-highlight-color:\s*transparent/,
    "Touch feedback must not be removed for visual styling",
  );
  assert.doesNotMatch(
    root,
    /--activity-fg:/,
    "Progress spinners must use neutral control color rather than a green activity role",
  );
  for (const path of [
    "pages/(codex)/tasks/components/task-status.css",
    "pages/(codex)/tasks/components/detail/conversation.css",
  ]) {
    assert.match(
      readFrontend(path),
      /task-status-spinner[\s\S]*color: var\(--control-fg\)/,
      `${path} must keep progress spinners neutral`,
    );
  }
  assert.doesNotMatch(
    root,
    /--accent(?:-strong|-soft|-border)?:/,
    "The generic accent palette must not collapse semantic color roles",
  );

  for (const [path, source] of frontendSources()) {
    assert.doesNotMatch(
      source,
      /var\(--accent(?:-strong|-soft|-border)?\)/,
      `${path} must consume a color token named for its semantic role`,
    );
  }

  const selectedOwners = [
    "components/file-browser/list.css",
    "components/git-compare-browser/compare-tree.css",
    "components/git-diff-browser/changes-tree.css",
    "pages/(codex)/tasks/components/navigator.css",
    "pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.css",
    "pages/(review-workspace)/(github)/(pulls)/files/components/tree.css",
  ];
  for (const path of selectedOwners) {
    assert.match(
      readFrontend(path),
      /background: var\(--selection-bg\)/,
      `${path} must use the selection role instead of the accent palette directly`,
    );
  }

  for (const path of [
    "pages/(review-workspace)/(github)/(issues)/list/page.css",
    "pages/(review-workspace)/(github)/(pulls)/list/page.css",
    "pages/settings/page.css",
  ]) {
    assert.match(
      readFrontend(path),
      /var\(--selection-indicator\)/,
      `${path} must keep generic selection indicators neutral`,
    );
  }

  for (const path of [
    "components/file-browser.css",
    "components/git-compare-browser.css",
    "components/git-diff-browser.css",
    "components/review-panel-resizer.css",
    "pages/(codex)/tasks/components/detail/review.css",
  ]) {
    assert.match(
      readFrontend(path),
      /background: var\(--resizer-hover-bg\)/,
      `${path} must use the neutral resizer interaction role`,
    );
  }
  assert.match(
    readFrontend("pages/(codex)/tasks/page.css"),
    /border-right-color: var\(--resizer-hover-bg\)/,
    "The Tasks resize hit area must highlight its owning panel border",
  );

  const diffViewer = readFrontend("components/diff-viewer.css");
  assert.match(diffViewer, /background: var\(--diff-added-bg\)/);
  assert.match(diffViewer, /background: var\(--diff-removed-bg\)/);
});

test("structural shadows separate fixed regions from floating elevation", () => {
  const sources = frontendSources();
  const root = readFrontend("styles.css");

  assert.match(
    root,
    /--structural-shadow-panel: 0 4px 18px rgb\(var\(--shadow-rgb\) \/ 6%\)/,
  );
  assert.match(
    root,
    /--structural-shadow-block-end: 0 3px 10px rgb\(var\(--shadow-rgb\) \/ 3%\)/,
  );
  assert.match(
    root,
    /--structural-shadow-inline-end: linear-gradient\([\s\S]*to right,[\s\S]*rgb\(var\(--shadow-rgb\) \/ 2\.5%\) 0%,[\s\S]*rgb\(var\(--shadow-rgb\) \/ 1\.25%\) 35%,[\s\S]*rgb\(var\(--shadow-rgb\) \/ 0\.5%\) 70%,[\s\S]*transparent 100%[\s\S]*\)/,
  );
  assert.deepEqual(
    tokenConsumers(sources, /var\(--structural-shadow-panel\)/),
    ["pages/(codex)/tasks/components/composer.css"],
  );
  assert.deepEqual(
    tokenConsumers(sources, /var\(--structural-shadow-block-end\)/),
    [
      "pages/(codex)/tasks/components/detail/summary.css",
      "pages/(codex)/tasks/page.css",
    ],
  );
  assert.deepEqual(
    tokenConsumers(sources, /var\(--structural-shadow-inline-end\)/),
    ["pages/(codex)/tasks/page.css"],
  );

  const taskPage = readFrontend("pages/(codex)/tasks/page.css");
  cssBlockMatching(taskPage, ".tasks-master-detail", [
    /position: relative/,
    /grid-template-columns: var\(--tasks-list-width, 380px\) minmax\(520px, 1fr\)/,
  ]);
  cssBlockMatching(taskPage, ".tasks-list-pane", [
    /overflow: visible/,
    /border-right: 1px solid var\(--border\)/,
  ]);
  assert.doesNotMatch(cssBlock(taskPage, ".tasks-list-pane"), /box-shadow/);
  cssBlockMatching(taskPage, ".tasks-list-pane::after", [
    /inset: 0 -1\.125rem 0 auto/,
    /width: 1\.125rem/,
    /background: var\(--structural-shadow-inline-end\)/,
    /pointer-events: none/,
  ]);
  cssBlockMatching(taskPage, ".tasks-master-resizer", [
    /position: absolute/,
    /inset: 0 auto 0 calc\(var\(--tasks-list-width, 380px\) - 0\.1875rem\)/,
    /z-index: 3/,
    /width: 0\.375rem/,
  ]);
  assert.doesNotMatch(cssBlock(taskPage, ".tasks-master-resizer"), /border-/);
  assert.doesNotMatch(taskPage, /\.tasks-master-resizer::after/);
  cssBlockMatching(
    taskPage,
    ".tasks-master-detail:has(.tasks-master-resizer:hover) .tasks-list-pane",
    [/border-right-color: var\(--resizer-hover-bg\)/],
  );

  const composer = readFrontend("pages/(codex)/tasks/components/composer.css");
  cssBlockMatching(composer, ".task-composer-panel", [
    /box-shadow: var\(--structural-shadow-panel\)/,
  ]);
  assert.doesNotMatch(
    cssBlock(composer, ".task-composer.task-follow-up-form"),
    /box-shadow/,
  );
});

test("unseen completion attention blinks the marker without hiding it", () => {
  const navigator = readFrontend("pages/(codex)/tasks/components/navigator.css");
  const navigatorView = readFrontend("pages/(codex)/tasks/components/navigator.js");

  cssBlockMatching(navigator, ".task-unseen-complete::before", [
    /animation: task-unseen-complete-blink 2\.4s ease-in-out infinite/,
    /animation-delay: var\(--task-unseen-attention-delay, 0ms\)/,
  ]);
  assert.match(
    navigator,
    /@keyframes task-unseen-complete-blink[\s\S]*opacity: 1[\s\S]*opacity: 0\.35/,
  );
  assert.match(
    navigator,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.task-unseen-complete::before[\s\S]*animation: none[\s\S]*opacity: 1/,
  );
  assert.match(
    navigatorView,
    /style="--task-unseen-attention-delay: \$\{attentionDelayMs\}ms"/,
  );
});

test("component styles do not own literal colors", () => {
  const literalColor = /#[0-9a-fA-F]{3,8}\b|rgb\(\s*\d/;
  const owners = frontendSources().filter(
    ([path]) => path.endsWith(".css") && path !== "styles.css",
  );

  for (const [path, source] of owners) {
    assert.doesNotMatch(
      source,
      literalColor,
      `${path} must consume semantic color tokens from styles.css`,
    );
  }
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
    ["pages/(codex)/tasks/components/navigator.css", ".task-restore-icon", "--interface-icon-size"],
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

test("control paint layers do not pull screen-reader text into layout", () => {
  const taskControls = readFrontend("pages/(codex)/tasks/controls.css");

  assert.doesNotMatch(taskControls, /\.task-primary-button\s*>\s*\*\s*\{/);
  assert.match(
    taskControls,
    /\.task-primary-button\s*>\s*:not\(\.sr-only\)\s*\{/,
  );
  assert.match(
    taskControls,
    /\.task-primary-button,[\s\S]*isolation: isolate;/,
  );
  assert.match(
    taskControls,
    /\.task-primary-button::before,[\s\S]*z-index: -1;/,
  );
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

test("icon-only controls use square slots from their semantic control tier", () => {
  const pageControls = [
    [
      "pages/components/header-actions.css",
      ".header-action-group-button",
      "--interface-control-hit-size",
    ],
    [
      "pages/settings/page.css",
      ".settings-close-button",
      "--interface-control-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/detail/conversation/command-dialog.css",
      ".task-command-dialog-close",
      "--interface-control-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/composer.css",
      ".task-send-button",
      "--interface-control-hit-size",
    ],
  ];
  const contextualControls = [
    [
      "pages/(review-workspace)/layout.css",
      ".review-workspace-close",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/layout.css",
      ".codex-workspace-close",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/detail/summary.css",
      ".task-brand-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/detail/summary.css",
      ".task-detail-info-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/navigator.css",
      ".task-restore-button",
      "--interface-compact-hit-size",
    ],
    [
      "components/file-browser/list.css",
      ".file-refresh-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/composer.css",
      ".task-composer-attachment button",
      "--interface-compact-hit-size",
    ],
    [
      "components/file-viewer.css",
      ".viewer-info-button",
      "--interface-compact-hit-size",
    ],
    [
      "components/file-viewer.css",
      ".viewer-refresh-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(review-workspace)/(git)/components/controls.css",
      ".git-review-refresh",
      "--interface-compact-hit-size",
    ],
  ];

  for (const [path, selector, token] of [...pageControls, ...contextualControls]) {
    cssBlockMatching(readFrontend(path), selector, [
      new RegExp(`width: var\\(${token}\\)`),
      new RegExp(`height: var\\(${token}\\)`),
      /place-items: center/,
    ]);
  }

  const fileViewer = readFrontend("components/file-viewer.css");
  cssBlockMatching(fileViewer, ".viewer-info-button", [
    /position: relative/,
    /width: var\(--interface-compact-hit-size\)/,
    /height: var\(--interface-compact-hit-size\)/,
  ]);
  cssBlockMatching(fileViewer, ".viewer-info-button::after", [
    /inset: var\(--interface-compact-hit-outset\)/,
  ]);
});

test("archived restore actions stay visually secondary until interaction", () => {
  const navigator = readFrontend("pages/(codex)/tasks/components/navigator.css");

  cssBlockMatching(navigator, ".task-restore-button", [
    /color: var\(--border-strong\)/,
  ]);
  cssBlockMatching(navigator, ".task-restore-button::before", [
    /border: 1px solid transparent/,
    /background: transparent/,
  ]);
  cssBlockMatching(navigator, ".task-restore-button:not\(:disabled\):hover::before", [
    /border-color: var\(--border\)/,
    /background: var\(--control-subtle-hover-bg\)/,
  ]);
});

test("visible controls separate responsive geometry from coarse-pointer hit area", () => {
  const tokens = readFrontend("styles.css");
  for (const token of [
    "--interface-control-visual-size",
    "--interface-control-hit-size",
    "--interface-control-hit-outset",
    "--interface-compact-visual-size",
    "--interface-compact-hit-size",
    "--interface-compact-hit-outset",
  ]) {
    assert.match(tokens, new RegExp(`${token}:`));
  }

  const controls = [
    ["pages/components/header-actions.css", ".header-action-group-button::before", "--interface-control-hit-outset"],
    ["pages/settings/page.css", ".settings-close-button::before", "--interface-control-hit-outset"],
    [
      "pages/(codex)/tasks/components/detail/conversation/command-dialog.css",
      ".task-command-dialog-close::before",
      "--interface-control-hit-outset",
    ],
    ["pages/(codex)/layout.css", ".codex-workspace-close::before", "--interface-compact-hit-outset"],
    ["pages/(review-workspace)/layout.css", ".review-workspace-close::before", "--interface-compact-hit-outset"],
    ["pages/(codex)/tasks/components/composer.css", ".task-send-button::before", "--interface-control-hit-outset"],
    ["pages/(codex)/tasks/components/composer.css", ".task-composer-attachment button::before", "--interface-compact-hit-outset"],
    ["pages/(codex)/tasks/components/composer.css", ".task-model-button::before", "--interface-compact-hit-outset"],
    ["pages/(codex)/tasks/components/composer.css", ".task-permission-button::before", "--interface-compact-hit-outset"],
    ["pages/settings/page.css", ".settings-reset-all::before", "--interface-compact-hit-outset"],
    ["pages/settings/page.css", ".settings-range-control button::before", "--interface-compact-hit-outset"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-detail-archive-action .task-secondary-button::before", "--interface-compact-hit-outset"],
  ];

  for (const [path, selector, token] of controls) {
    const block = cssBlockContaining(readFrontend(path), selector, "inset:");
    assert.match(block, new RegExp(token), `${path} ${selector}`);
  }

  cssBlockMatching(
    readFrontend("pages/(codex)/tasks/controls.css"),
    ".task-primary-button::before",
    [
      /inset-block: var\(--interface-control-hit-outset\)/,
      /background: var\(--primary-action-bg\)/,
    ],
  );
});

test("contextual and inline actions stay compact while page and primary actions stay regular", () => {
  const compactControls = [
    [
      "pages/(codex)/tasks/components/detail/summary.css",
      ".task-detail-actions .task-secondary-button",
      "--interface-compact-visual-size",
    ],
    [
      "pages/(codex)/tasks/components/detail/review.css",
      ".task-review-refresh",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(codex)/tasks/components/detail/conversation.css",
      ".task-approval-actions .task-secondary-button",
      "--interface-compact-visual-size",
    ],
    [
      "pages/(codex)/tasks/components/navigator.css",
      '[data-task-action="load-more-tasks"]',
      "--interface-compact-visual-size",
    ],
    [
      "pages/(codex)/tasks/components/navigator.css",
      '[data-task-action="load-more-archived-tasks"]',
      "--interface-compact-visual-size",
    ],
    [
      "pages/settings/page.css",
      ".settings-reset-all",
      "--interface-compact-hit-size",
    ],
    [
      "pages/settings/page.css",
      ".settings-range-control button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(review-workspace)/(github)/(pulls)/detail/page.css",
      ".github-pull-files-button",
      "--interface-compact-visual-size",
    ],
  ];

  cssBlockMatching(
    readFrontend("pages/(codex)/tasks/controls.css"),
    ".task-primary-button",
    [
      /min-height: var\(--interface-control-hit-size\)/,
      /background: transparent/,
    ],
  );
  cssBlockMatching(
    readFrontend("pages/(codex)/tasks/controls.css"),
    ".task-icon-button",
    [
      /min-height: var\(--interface-control-hit-size\)/,
      /width: var\(--interface-control-hit-size\)/,
      /height: var\(--interface-control-hit-size\)/,
    ],
  );
  for (const [path, selector, token] of compactControls) {
    const block = cssBlockContaining(readFrontend(path), selector, "height:");
    assert.match(block, new RegExp(`height: var\\(${token}\\)`), `${path} ${selector}`);
  }
});

test("dense contextual toolbars separate visual size from coarse-pointer hit area", () => {
  const tokens = readFrontend("styles.css");
  const summary = readFrontend("pages/(codex)/tasks/components/detail/summary.css");
  const review = readFrontend("pages/(codex)/tasks/components/detail/review.css");

  assert.match(tokens, /--interface-compact-visual-size: 1\.875rem;/);
  assert.match(
    tokens,
    /--interface-compact-hit-size:[\s\S]*--interface-compact-visual-size[\s\S]*--interface-target-floor/,
  );
  assert.match(
    tokens,
    /--interface-compact-hit-outset:[\s\S]*--interface-target-floor[\s\S]*--interface-compact-visual-size/,
  );
  assert.match(
    summary,
    /\.task-mode-switch button \{[\s\S]*height: var\(--interface-compact-hit-size\)[\s\S]*margin-block: calc\(0rem - var\(--interface-compact-hit-outset\)\)/,
  );
  assert.match(
    summary,
    /\.task-brand-button::before,[\s\S]*--interface-compact-hit-outset/,
  );
  assert.match(
    review,
    /\.task-review-axis-options button \{[\s\S]*height: var\(--interface-compact-hit-size\)[\s\S]*margin-block: calc\(0rem - var\(--interface-compact-hit-outset\)\)/,
  );
  assert.match(
    review,
    /\.task-review-refresh \{[\s\S]*width: var\(--interface-compact-hit-size\)[\s\S]*height: var\(--interface-compact-hit-size\)[\s\S]*margin: calc\(0rem - var\(--interface-compact-hit-outset\)\)/,
  );
  assert.match(
    review,
    /\.task-review-refresh::before \{[\s\S]*inset: var\(--interface-compact-hit-outset\)/,
  );
});

test("task rows use full-width selection and compact repository grouping", () => {
  const navigator = readFrontend(
    "pages/(codex)/tasks/components/navigator.css",
  );
  const row = cssBlock(navigator, "& .task-row {");
  const archivedRow = cssBlock(navigator, "& .task-archived-row {");
  const repositoryGap = cssBlock(
    navigator,
    "& .task-repository-group + .task-repository-group {",
  );
  const repositoryHeader = cssBlock(
    navigator,
    "& .task-repository-header {",
  );
  const hover = cssBlock(navigator, "& .task-row:hover,");
  const selected = cssBlock(
    navigator,
    '& .task-row[aria-current="true"]',
  );
  const title = cssBlock(navigator, "& .task-row-title");

  assert.doesNotMatch(row, /border-left/);
  assert.doesNotMatch(hover, /border-left/);
  assert.doesNotMatch(selected, /border-left/);
  assert.match(row, /width: calc\(100% \+ var\(--task-repository-indent\)\)/);
  assert.match(
    row,
    /margin-inline-start: calc\(0rem - var\(--task-repository-indent\)\)/,
  );
  assert.match(
    row,
    /padding-inline-start: var\(--interface-space-8\)/,
  );
  assert.match(
    archivedRow,
    /width: calc\(100% \+ var\(--task-repository-indent\)\)/,
  );
  assert.match(
    archivedRow,
    /margin-inline-start: calc\(0rem - var\(--task-repository-indent\)\)/,
  );
  assert.match(
    archivedRow,
    /padding-inline-start: var\(--interface-space-8\)/,
  );
  assert.match(repositoryGap, /margin-top: var\(--interface-space-6\)/);
  assert.match(repositoryHeader, /min-height: var\(--interface-space-14\)/);
  assert.match(row, /grid-template-columns: minmax\(0, 1fr\) 3rem/);
  assert.match(row, /gap: 0\.25rem/);
  assert.match(selected, /background: var\(--selection-bg\)/);
  assert.doesNotMatch(selected, /color-mix/);
  assert.match(title, /font-weight: 500/);

  const indicators = cssBlock(navigator, "& .task-row-indicators");
  assert.match(indicators, /width: 3rem/);
  assert.match(indicators, /min-width: 0/);
});

test("text actions use the shared Interface metadata scale instead of root body text", () => {
  const owners = [
    ["pages/components/app-menu.css", ".app-menu-popover button"],
    ["pages/components/pathbar.css", ".path-crumbs button"],
    ["pages/(codex)/tasks/controls.css", ".task-primary-button"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-review-menu-popover button"],
    ["pages/(codex)/tasks/components/detail/summary.css", ".task-detail-popover dd"],
    ["pages/(review-workspace)/(github)/(pulls)/detail/page.css", ".github-pull-commit a"],
  ];

  for (const [path, selector] of owners) {
    const block = cssBlockContaining(readFrontend(path), selector, "font-size:");
    assert.match(
      block,
      /font-size: var\(--interface-meta-font-size\)/,
      `${path} ${selector}`,
    );
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
    /\.task-model-button[\s\S]*min-height: var\(--interface-compact-visual-size\)/,
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

function cssBlockMatching(source, selector, patterns) {
  let offset = 0;
  while (offset < source.length) {
    const start = source.indexOf(selector, offset);
    assert.notEqual(start, -1, `missing selector ${selector}`);
    const open = source.indexOf("{", start);
    const close = source.indexOf("}", open);
    const block = source.slice(start, close + 1);
    if (patterns.every((pattern) => pattern.test(block))) {
      return block;
    }
    offset = close + 1;
  }
  assert.fail(`missing expected declarations in selector ${selector}`);
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
