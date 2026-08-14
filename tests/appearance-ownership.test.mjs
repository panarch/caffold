import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));
const e2eSupportRoot = fileURLToPath(new URL("./e2e/support/", import.meta.url));

const conversationOwners = new Set([
  "pages/(task-workspace)/tasks/components/composer.css",
  "pages/(task-workspace)/tasks/components/detail/conversation.css",
  "pages/(task-workspace)/tasks/components/detail/conversation/work-details.css",
  "pages/(task-workspace)/tasks/components/detail/conversation/markdown.js",
  "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.css",
  "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css",
  "pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js",
  "pages/(task-workspace)/settings/appearance/page.css",
  "settings.js",
  "styles.css",
]);

const codeOwners = new Set([
  "components/code-viewer.css",
  "components/diff-viewer.css",
  "pages/(task-workspace)/tasks/components/detail/conversation.css",
  "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css",
  "pages/(task-workspace)/tasks/components/detail/conversation/command-summary.css",
  "pages/(task-workspace)/tasks/components/detail/conversation/markdown.js",
  "pages/(task-workspace)/tasks/components/detail/conversation/work-details.css",
  "pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js",
  "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.css",
  "pages/(task-workspace)/settings/appearance/page.css",
  "settings.js",
  "styles.css",
]);

const typefaceOwners = new Set([
  "components/code-viewer.css",
  "components/diff-viewer.css",
  "fonts.js",
  "pages/(task-workspace)/tasks/components/detail/conversation/markdown.js",
  "pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js",
  "pages/(task-workspace)/settings/appearance/page.css",
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
    "pages/(task-workspace)/tasks/components/task-status.css",
    "pages/(task-workspace)/tasks/components/detail/conversation.css",
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
    "components/file-tree.css",
    "pages/(task-workspace)/tasks/components/active-task-list/components/row.css",
    "pages/(task-workspace)/settings/appearance/page.css",
  ];
  for (const path of selectedOwners) {
    assert.match(
      readFrontend(path),
      /background: var\(--selection-bg\)/,
      `${path} must use the selection role instead of the accent palette directly`,
    );
  }

  for (const path of [
    "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.css",
    "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.css",
  ]) {
    assert.match(
      readFrontend(path),
      /var\(--selection-indicator\)/,
      `${path} must keep generic selection indicators neutral`,
    );
  }

  for (const path of [
    "components/git-compare-browser.css",
    "components/review-panel-resizer.css",
    "pages/(task-workspace)/tasks/components/detail/review.css",
  ]) {
    assert.match(
      readFrontend(path),
      /background: var\(--resizer-hover-bg\)/,
      `${path} must use the neutral resizer interaction role`,
    );
  }
  assert.match(
    readFrontend("pages/(task-workspace)/layout.css"),
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
    [
      "pages/(task-workspace)/tasks/components/composer.css",
      "pages/layout.css",
    ],
  );
  assert.deepEqual(
    tokenConsumers(sources, /var\(--structural-shadow-block-end\)/),
    [
      "pages/(task-workspace)/settings/layout.css",
      "pages/(task-workspace)/settings/navigator.css",
      "pages/(task-workspace)/tasks/components/detail/summary.css",
      "pages/(task-workspace)/tasks/components/navigator.css",
      "pages/(task-workspace)/tasks/components/recovery.css",
    ],
  );
  assert.deepEqual(
    tokenConsumers(sources, /var\(--structural-shadow-inline-end\)/),
    [
      "pages/(task-workspace)/layout.css",
    ],
  );

  const taskWorkspace = readFrontend("pages/(task-workspace)/layout.css");
  cssBlockMatching(taskWorkspace, ".task-workspace-master-detail", [
    /position: relative/,
    /var\(--task-workspace-master-width, 380px\)/,
    /minmax\(520px, 1fr\)/,
  ]);
  cssBlockMatching(taskWorkspace, ".task-workspace-master-pane", [
    /overflow: visible/,
    /border-right: 1px solid var\(--border\)/,
  ]);
  assert.doesNotMatch(
    cssBlock(taskWorkspace, ".task-workspace-master-pane"),
    /box-shadow/,
  );
  cssBlockMatching(taskWorkspace, ".task-workspace-master-pane::after", [
    /inset: 0 -1\.125rem 0 auto/,
    /width: 1\.125rem/,
    /background: var\(--structural-shadow-inline-end\)/,
    /pointer-events: none/,
  ]);
  cssBlockMatching(taskWorkspace, ".task-workspace-master-resizer", [
    /position: absolute/,
    /var\(--task-workspace-master-width, 380px\)/,
    /0\.1875rem/,
    /z-index: 3/,
    /width: 0\.375rem/,
  ]);
  assert.doesNotMatch(
    cssBlock(taskWorkspace, ".task-workspace-master-resizer"),
    /border-/,
  );
  assert.doesNotMatch(taskWorkspace, /\.task-workspace-master-resizer::after/);
  cssBlockMatching(
    taskWorkspace,
    ":has(.task-workspace-master-resizer:hover) .task-workspace-master-pane",
    [/border-right-color: var\(--resizer-hover-bg\)/],
  );

  const composer = readFrontend("pages/(task-workspace)/tasks/components/composer.css");
  cssBlockMatching(composer, ".task-composer-panel", [
    /box-shadow: var\(--structural-shadow-panel\)/,
  ]);
  assert.doesNotMatch(
    cssBlock(composer, ".task-composer.task-follow-up-form"),
    /box-shadow/,
  );
});

test("unseen completion attention blinks the marker without hiding it", () => {
  const activeList = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/row.css",
  );
  const activeTaskListView = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/row.js",
  );

  cssBlockMatching(activeList, ".task-unseen-complete::before", [
    /animation: task-unseen-complete-blink 2\.4s ease-in-out infinite/,
    /animation-delay: var\(--task-unseen-attention-delay, 0ms\)/,
  ]);
  assert.match(
    activeList,
    /@keyframes task-unseen-complete-blink[\s\S]*opacity: 1[\s\S]*opacity: 0\.35/,
  );
  assert.match(
    activeList,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.task-unseen-complete::before[\s\S]*animation: none[\s\S]*opacity: 1/,
  );
  assert.match(
    activeTaskListView,
    /style="--task-unseen-attention-delay: \$\{attentionDelayMs\}ms"/,
  );
});

test("workspace header identity and titles share semantic ownership", () => {
  const tokens = readFrontend("styles.css");
  const brand = readFrontend(
    "pages/(task-workspace)/components/workspace-brand.css",
  );
  const brandView = readFrontend(
    "pages/(task-workspace)/components/workspace-brand.js",
  );
  const taskNavigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.css",
  );
  const taskNavigatorView = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/components/detail.css",
  );
  const settingsNavigator = readFrontend(
    "pages/(task-workspace)/settings/navigator.css",
  );
  const settingsNavigatorView = readFrontend(
    "pages/(task-workspace)/settings/navigator.js",
  );
  const settingsLayout = readFrontend(
    "pages/(task-workspace)/settings/layout.css",
  );
  const appearanceView = readFrontend(
    "pages/(task-workspace)/settings/appearance/page.js",
  );

  assert.match(tokens, /--workspace-header-title-size: 0\.8125rem/);
  cssBlockMatching(brand, "caffold-workspace-brand", [
    /gap: var\(--interface-space-3\)/,
    /color: var\(--muted\)/,
  ]);
  cssBlockMatching(brand, ".workspace-brand-icon", [
    /width: 1\.25rem/,
    /height: 1\.25rem/,
    /transform: translateY\(-0\.0625rem\)/,
  ]);
  cssBlockMatching(brand, ".workspace-brand-title", [
    /font-size: var\(--workspace-header-title-size\)/,
    /text-overflow: ellipsis/,
    /white-space: nowrap/,
  ]);
  assert.match(
    brandView,
    /customElements\.define\("caffold-workspace-brand"/,
  );
  assert.match(taskNavigatorView, /<caffold-workspace-brand>/);
  assert.match(settingsNavigatorView, /<caffold-workspace-brand>/);
  assert.doesNotMatch(
    appearanceView,
    /<caffold-workspace-brand>/,
    "Appearance content must not repeat the Settings navigator identity",
  );
  assert.doesNotMatch(taskNavigator, /task-list-primary-(?:brand|icon)/);
  assert.doesNotMatch(settingsNavigator, /settings-navigator-header (?:img|strong)/);
  cssBlockMatching(settingsNavigator, ".settings-navigator-header", [
    /height: var\(--task-workspace-header-size\)/,
    /padding: 0 var\(--interface-space-6\)/,
    /box-shadow: var\(--structural-shadow-block-end\)/,
  ]);
  assert.match(
    detail,
    /--task-detail-header-title-size: var\(--workspace-header-title-size\)/,
  );
  assert.match(
    settingsLayout,
    /--settings-page-title-size: var\(--workspace-header-title-size\)/,
  );
});

test("App Shell foreground recovery notice owns viewport-wide connection chrome", () => {
  const appShell = readFrontend("pages/layout.css");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.css",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/components/detail.css",
  );

  cssBlockMatching(appShell, ".app-foreground-recovery", [
    /position: fixed/,
    /left: 50%/,
    /width: max-content/,
    /max-width: calc\(100vw - var\(--interface-space-12\)\)/,
    /background: var\(--warning-soft\)/,
    /box-shadow: var\(--structural-shadow-panel\)/,
    /transform: translateX\(-50%\)/,
  ]);
  cssBlockMatching(navigator, "caffold-task-navigator", [
    /position: relative/,
    /display: grid/,
    /grid-template-rows:/,
    /minmax\(0, 1fr\)/,
  ]);
  cssBlockMatching(navigator, ".task-list-scroll", [
    /min-height: 0/,
    /overflow: auto/,
  ]);
  cssBlockMatching(navigator, ".task-list-primary-header", [
    /border-bottom: 1px solid var\(--border\)/,
    /box-shadow: var\(--structural-shadow-block-end\)/,
  ]);
  cssBlockMatching(detail, ".task-conversation-pane", [
    /position: relative/,
    /grid-template-rows: minmax\(0, 1fr\) auto/,
  ]);
  assert.doesNotMatch(navigator, /task-list-availability/);
  assert.doesNotMatch(detail, /task-stream-state/);
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

test("Settings roles share inherited constraints without sharing leaf selectors", () => {
  const settingsLayout = readFrontend(
    "pages/(task-workspace)/settings/layout.css",
  );
  for (const token of [
    "--settings-content-max-width",
    "--settings-content-padding-block",
    "--settings-content-padding-inline",
    "--settings-small-text-size",
    "--settings-page-title-size",
    "--settings-page-description-size",
    "--settings-field-label-size",
    "--settings-field-description-size",
    "--settings-detail-label-size",
    "--settings-detail-value-size",
    "--settings-page-action-size",
    "--settings-context-action-size",
  ]) {
    assert.match(settingsLayout, new RegExp(`${token}:`));
  }
  assert.match(
    settingsLayout,
    /--settings-small-text-size: max\(14px, 0\.8125rem\)/,
  );
  assert.match(
    settingsLayout,
    /--settings-detail-value-size: var\(--settings-small-text-size\)/,
  );

  const pages = [
    [
      "pages/(task-workspace)/settings/appearance/page.css",
      "settings-appearance",
    ],
    ["pages/(task-workspace)/settings/files/page.css", "settings-files"],
    ["pages/(task-workspace)/settings/codex/page.css", "settings-codex"],
    ["pages/(task-workspace)/settings/about/page.css", "settings-about"],
  ];
  for (const [path, container] of pages) {
    const source = readFrontend(path);
    assert.match(source, new RegExp(`container: ${container} / inline-size`));
    assert.match(source, /var\(--settings-content-max-width\)/);
    assert.match(source, /var\(--settings-content-padding-block\)/);
    assert.match(source, /var\(--settings-content-padding-inline\)/);
    assert.match(source, /var\(--settings-page-description-size\)/);
  }

  const appLayout = readFrontend("pages/layout.js");
  const taskWorkspace = readFrontend("pages/(task-workspace)/layout.js");
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/page.js");
  const settingsWorkspace = readFrontend(
    "pages/(task-workspace)/settings/layout.js",
  );
  assert.match(appLayout, /<main class="app-main"/);
  for (const source of [taskWorkspace, tasksPage, settingsWorkspace]) {
    assert.doesNotMatch(source, /<\/?main\b/);
  }
  assert.match(
    settingsWorkspace,
    /role="region"[\s\S]*aria-labelledby="settings-workspace-title"/,
  );
  assert.match(settingsWorkspace, /<h1 id="settings-workspace-title"><\/h1>/);

  for (const path of [
    "pages/(task-workspace)/settings/appearance/page.js",
    "pages/(task-workspace)/settings/files/page.js",
    "pages/(task-workspace)/settings/codex/page.js",
    "pages/(task-workspace)/settings/about/page.js",
  ]) {
    assert.doesNotMatch(
      readFrontend(path),
      /<h2 id="settings-(?:appearance|files|codex|about)-title"/,
    );
  }
  assert.match(
    readFrontend("pages/(task-workspace)/settings/navigator.js"),
    /aria-label="Settings sections"/,
  );
  assert.doesNotMatch(
    readFrontend("pages/(task-workspace)/settings/navigator.js"),
    /Local to this browser/,
  );

  const appearancePage = readFrontend(
    "pages/(task-workspace)/settings/appearance/page.js",
  );
  assert.match(appearancePage, /settings-typeface-detail/);
  assert.match(appearancePage, /settings-text-preview/);
  assert.match(appearancePage, /renderInlineIcon\("RotateCcw"/);
  assert.match(appearancePage, /data-reset-label=/);
  assert.doesNotMatch(appearancePage, /data-typeface-description/);
  assert.doesNotMatch(appearancePage, /settings-interface-preview/);
  assert.doesNotMatch(appearancePage, /data-typeface-availability/);
  assert.doesNotMatch(appearancePage, /\.availability/);
  assert.doesNotMatch(appearancePage, /icons\/favicon-32\.png/);
  assert.doesNotMatch(appearancePage, />Open</);

  cssBlockMatching(
    readFrontend("pages/(task-workspace)/settings/codex/page.css"),
    ".settings-usage-row strong",
    [/font-size: var\(--settings-detail-value-size\)/],
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
    ["pages/(task-workspace)/tasks/controls.css", ".task-action-icon"],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/git.css",
      ".task-git-icon",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/github.css",
      ".task-github-icon",
    ],
    ["components/file-viewer.css", ".viewer-info-icon"],
    ["pages/(task-workspace)/tasks/components/detail/(git)/layout.css", ".task-domain-back-icon"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/layout.css", ".task-domain-back-icon"],
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
    ["pages/(task-workspace)/tasks/components/detail/(git)/layout.css", ".task-domain-back-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/layout.css", ".task-domain-back-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css", ".git-review-refresh-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.css", ".log-review-icon", "--interface-icon-small-size"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css", ".github-pull-files-icon", "--interface-icon-small-size"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.css", ".github-pull-icon", "--interface-icon-small-size"],
    ["pages/(task-workspace)/settings/layout.css", ".settings-workspace-back-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/settings/appearance/page.css", ".settings-reset-all-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/settings/appearance/page.css", ".settings-reset-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/layout.css", ".task-workspace-route-control-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/components/navigation.css", ".task-workspace-navigation-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/controls.css", ".task-action-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/components/composer.css", ".task-primary-action-icon", "--interface-icon-size"],
    ["pages/(task-workspace)/tasks/components/active-task-list.css", ".task-repository-icon", "--task-list-icon-size"],
    ["pages/(task-workspace)/tasks/components/active-task-list/components/row.css", ".task-row-worktree-icon", "--task-list-icon-size"],
    ["pages/(task-workspace)/tasks/components/archived-task-list.css", ".task-repository-icon", "--task-list-icon-size"],
    ["pages/(task-workspace)/tasks/components/archived-task-list.css", ".task-row-worktree-icon", "--task-list-icon-size"],
    ["pages/(task-workspace)/tasks/components/archived-task-list.css", ".task-archived-action-icon", "--interface-icon-size"],
    ["components/file-navigator/list.css", ".file-refresh-icon", "--interface-icon-size"],
    ["components/file-tree.css", ".entry-icon-svg", "--file-tree-icon-size"],
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
  const taskControls = readFrontend("pages/(task-workspace)/tasks/controls.css");

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
      "pages/(task-workspace)/settings/layout.css",
      '.settings-workspace-detail-header button',
      "--interface-control-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css",
      ".task-command-dialog-close",
      "--interface-control-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/image-preview-dialog.css",
      ".task-image-preview-close",
      "--interface-control-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/composer.css",
      ".task-primary-action-button",
      "--interface-control-hit-size",
    ],
  ];
  const contextualControls = [
    [
      "pages/(task-workspace)/tasks/components/detail/(git)/layout.css",
      ".task-domain-back",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/(github)/layout.css",
      ".task-domain-back",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/layout.css",
      ".task-workspace-route-control",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/git.css",
      ".task-git-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/github.css",
      ".task-github-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/info.css",
      ".task-detail-info-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/archived-task-list.css",
      ".task-archived-action-button",
      "--task-list-row-height",
    ],
    [
      "components/file-navigator/list.css",
      ".file-refresh-button",
      "--interface-compact-hit-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/composer.css",
      ".task-composer-attachment-remove",
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
      "pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css",
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

test("archived actions use a visually secondary compact base", () => {
  const archivedList = readFrontend("pages/(task-workspace)/tasks/components/archived-task-list.css");

  cssBlockMatching(archivedList, ".task-archived-action-button", [
    /width: var\(--task-list-row-height\)/,
    /height: var\(--task-list-row-height\)/,
    /color: var\(--border-strong\)/,
  ]);
  cssBlockMatching(archivedList, ".task-archived-action-button::before", [
    /border: 1px solid transparent/,
    /background: transparent/,
  ]);
  cssBlockMatching(archivedList, ".task-archived-action-button:not\(:disabled\):hover::before", [
    /border-color: var\(--border\)/,
    /background: var\(--control-subtle-hover-bg\)/,
  ]);
  cssBlockMatching(archivedList, ".task-delete-button", [
    /color: var\(--danger\)/,
  ]);
  cssBlockMatching(archivedList, ".task-delete-button .task-archived-action-icon", [
    /opacity: 0\.62/,
  ]);
  cssBlockMatching(archivedList, ".task-delete-button:not\(:disabled\):hover", [
    /color: var\(--danger-strong\)/,
  ]);
  cssBlockMatching(archivedList, ".task-delete-button:not\(:disabled\):hover::before", [
    /border-color: var\(--danger-border\)/,
    /background: var\(--danger-faint\)/,
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
    [
      "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css",
      ".task-command-dialog-close::before",
      "--interface-control-hit-outset",
    ],
    [
      "pages/(task-workspace)/tasks/components/image-preview-dialog.css",
      ".task-image-preview-close::before",
      "--interface-control-hit-outset",
    ],
    ["pages/(task-workspace)/layout.css", ".task-workspace-route-control::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/tasks/components/detail/(git)/layout.css", ".task-domain-back::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/layout.css", ".task-domain-back::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/tasks/components/composer.css", ".task-primary-action-button::before", "--interface-control-hit-outset"],
    ["pages/(task-workspace)/tasks/components/composer.css", ".task-composer-attachment-remove::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/tasks/components/task-turn-options.css", ".task-model-button::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/tasks/components/task-turn-options.css", ".task-permission-button::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/settings/appearance/page.css", ".settings-reset-all::before", "--interface-control-hit-outset"],
    ["pages/(task-workspace)/settings/appearance/page.css", ".settings-inline-reset::before", "--interface-compact-hit-outset"],
    ["pages/(task-workspace)/settings/codex/page.css", ".settings-content-section > header button::before", "--interface-control-hit-outset"],
    ["pages/(task-workspace)/settings/codex/page.css", ".settings-runtime-control button::before", "--interface-control-hit-outset"],
    ["pages/(task-workspace)/settings/about/page.css", ".settings-about-actions button::before", "--interface-control-hit-outset"],
    ["pages/(task-workspace)/tasks/components/detail/summary/info.css", ".task-detail-archive-action .task-secondary-button::before", "--interface-compact-hit-outset"],
  ];

  for (const [path, selector, token] of controls) {
    const block = cssBlockContaining(readFrontend(path), selector, "inset:");
    assert.match(block, new RegExp(token), `${path} ${selector}`);
  }

  cssBlockMatching(
    readFrontend("pages/(task-workspace)/tasks/controls.css"),
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
      "pages/(task-workspace)/tasks/components/detail/summary.css",
      ".task-detail-actions .task-secondary-button",
      "--interface-compact-visual-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/conversation.css",
      ".task-approval-actions .task-secondary-button",
      "--interface-compact-visual-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/archived-task-list.css",
      '[data-task-action="load-more-archived-tasks"]',
      "--interface-compact-visual-size",
    ],
    [
      "pages/(task-workspace)/settings/appearance/page.css",
      ".settings-inline-reset",
      "--settings-context-action-size",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css",
      ".github-pull-files-button",
      "--interface-compact-visual-size",
    ],
  ];

  cssBlockMatching(
    readFrontend("pages/(task-workspace)/tasks/controls.css"),
    ".task-primary-button",
    [
      /min-height: var\(--interface-control-hit-size\)/,
      /background: transparent/,
    ],
  );
  cssBlockMatching(
    readFrontend("pages/(task-workspace)/tasks/controls.css"),
    ".task-icon-button",
    [
      /min-height: var\(--interface-control-hit-size\)/,
      /width: var\(--interface-control-hit-size\)/,
      /height: var\(--interface-control-hit-size\)/,
    ],
  );
  for (const [path, selector, token] of compactControls) {
    const block = cssBlockContaining(readFrontend(path), selector, token);
    assert.match(
      block,
      new RegExp(`(?:min-)?height: var\\(${token}\\)`),
      `${path} ${selector}`,
    );
  }

  const pageActions = [
    [
      "pages/(task-workspace)/settings/appearance/page.css",
      ".settings-reset-all",
    ],
    [
      "pages/(task-workspace)/settings/codex/page.css",
      ".settings-content-section > header button",
    ],
    [
      "pages/(task-workspace)/settings/codex/page.css",
      ".settings-runtime-control button",
    ],
    [
      "pages/(task-workspace)/settings/about/page.css",
      ".settings-about-actions button",
    ],
  ];
  for (const [path, selector] of pageActions) {
    const block = cssBlockContaining(
      readFrontend(path),
      selector,
      "--settings-page-action-size",
    );
    assert.match(
      block,
      /min-height: var\(--settings-page-action-size\)/,
      `${path} ${selector}`,
    );
  }
});

test("dense contextual toolbars separate visual size from coarse-pointer hit area", () => {
  const tokens = readFrontend("styles.css");
  const summary = readFrontend("pages/(task-workspace)/tasks/components/detail/summary.css");
  const gitButton = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary/git.css",
  );
  const githubButton = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary/github.css",
  );
  const review = readFrontend("pages/(task-workspace)/tasks/components/detail/review.css");

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
    gitButton,
    /\.task-git-button::before \{[\s\S]*--interface-compact-hit-outset/,
  );
  assert.match(
    githubButton,
    /\.task-github-button::before \{[\s\S]*--interface-compact-hit-outset/,
  );
  assert.match(
    review,
    /\.task-review-axis-options button \{[\s\S]*height: var\(--interface-compact-hit-size\)[\s\S]*margin-block: calc\(0rem - var\(--interface-compact-hit-outset\)\)/,
  );
});

test("task rows use full-width selection and compact repository grouping", () => {
  const activeRow = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/row.css",
  );
  const activeList = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const archivedList = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-task-list.css",
  );
  const row = cssBlock(activeRow, "& > .task-row {");
  const archivedRow = cssBlock(archivedList, "& .task-archived-row {");
  const hover = cssBlock(activeRow, "& > .task-row:hover,");
  const selected = cssBlock(
    activeRow,
    '& > .task-row[aria-current="true"]',
  );

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
  assert.match(row, /grid-template-columns: minmax\(0, 1fr\) 3rem/);
  assert.match(row, /gap: 0\.25rem/);
  assert.match(selected, /background: var\(--selection-bg\)/);
  assert.doesNotMatch(selected, /color-mix/);

  for (const [groupOwner, rowOwner] of [
    [activeList, activeRow],
    [archivedList, archivedList],
  ]) {
    const repositoryGap = cssBlock(
      groupOwner,
      "& .task-repository-group + .task-repository-group {",
    );
    const repositoryHeader = cssBlock(groupOwner, "& .task-repository-header {");
    const title = cssBlock(rowOwner, "& .task-row-title");
    const indicators = cssBlock(rowOwner, "& .task-row-indicators");
    assert.match(repositoryGap, /margin-top: var\(--interface-space-6\)/);
    assert.match(repositoryHeader, /min-height: var\(--interface-space-14\)/);
    assert.match(title, /font-weight: 500/);
    assert.match(indicators, /width: 3rem/);
    assert.match(indicators, /min-width: 0/);
  }
});

test("text actions use the shared Interface metadata scale instead of root body text", () => {
  const owners = [
    ["pages/(task-workspace)/tasks/controls.css", ".task-primary-button"],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/git.css",
      ".task-git-popover button",
    ],
    [
      "pages/(task-workspace)/tasks/components/detail/summary/github.css",
      ".task-github-popover button",
    ],
    ["pages/(task-workspace)/tasks/components/detail/summary/info.css", ".task-detail-popover dd"],
    ["pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css", ".github-pull-commit a"],
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
    "pages/(task-workspace)/tasks/components/composer.css",
  );
  const turnOptions = readFrontend(
    "pages/(task-workspace)/tasks/components/task-turn-options.css",
  );
  assert.match(
    composer,
    /\.task-composer textarea[\s\S]*font-size: var\(--conversation-font-size\)/,
  );
  assert.match(
    turnOptions,
    /\.task-model-button[\s\S]*min-height: var\(--interface-compact-visual-size\)/,
  );
  assert.match(
    turnOptions,
    /\.task-model-button \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/,
  );
  assert.match(
    turnOptions,
    /\.task-model-button\.is-fast \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto auto;/,
  );
  assert.doesNotMatch(turnOptions, /\.task-(?:model|permission)-(?:icon|caret)/);
  assert.match(
    turnOptions,
    /\.task-model-popover,[\s\S]*padding: 0\.5rem;/,
  );
  assert.match(
    turnOptions,
    /\.task-model-option \{[\s\S]*gap: 0\.5rem;[\s\S]*padding: 0\.375rem;/,
  );
  assert.match(
    turnOptions,
    /\.task-model-option \{[\s\S]*min-height: max\(2\.125rem, calc\(var\(--interface-target-floor\) - 2px\)\)/,
  );
  assert.match(
    turnOptions,
    /\.task-model-option strong \{[\s\S]*font-weight: 600;/,
  );
  assert.match(
    turnOptions,
    /\.task-model-fast-icon \{[\s\S]*width: 0\.75rem;[\s\S]*height: 0\.75rem;[\s\S]*fill: currentColor;[\s\S]*stroke-width: 2;/,
  );

  const conversation = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/conversation.css",
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
