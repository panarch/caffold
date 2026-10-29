import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { effectiveSelectors } from "./css-ownership.mjs";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
// A shared style is any stylesheet directly under a `component-styles/`
// directory.
const sharedStyles = discoverFiles(frontendRoot, ".css").filter((path) =>
  /(?:^|\/)component-styles\/[^/]+\.css$/.test(path));
const baseStyles = "caffold-element/base.css";
// Renderer content has a separate shadow root, without the component base styles.
const documentRootStyles = [
  "components/docx-viewer/document.css",
  "components/pptx-viewer/document.css",
];
// Stylesheets a component puts in the shadow root it renders into, by owner.
const shadowRootStyles = new Map([
  ["action-hints/components/dialog.css", "caffold-action-hint-dialog"],
  ["components/docx-viewer.css", "caffold-docx-viewer"],
  ["components/file-navigator.css", "caffold-file-navigator"],
  ["components/file-navigator/components/list.css", "caffold-file-list"],
  ["components/file-tree.css", "caffold-file-tree"],
  ["components/file-viewer.css", "caffold-review-file-viewer"],
  ["components/file-viewer/components/code-viewer.css", "caffold-code-viewer"],
  ["components/file-viewer/components/diff-viewer.css", "caffold-diff-viewer"],
  ["components/git-compare-browser.css", "caffold-git-compare-browser"],
  ["components/git-compare-tree.css", "caffold-git-compare-tree"],
  ["components/loading-text.css", "caffold-loading-text"],
  ["components/markdown-preview.css", "caffold-markdown-preview"],
  ["components/pagination.css", "caffold-pagination"],
  ["components/pagination/components/button.css", "caffold-pagination-button"],
  ["components/pane-resizer.css", "caffold-pane-resizer"],
  ["components/pdf-viewer.css", "caffold-pdf-viewer"],
  ["components/pptx-viewer.css", "caffold-pptx-viewer"],
  ["components/segmented-control.css", "caffold-segmented-control"],
  ["components/terminal-view.css", "caffold-terminal-view"],
  ["components/xlsx-viewer.css", "caffold-xlsx-viewer"],
  ["keyboard-navigation/components/hud.css", "caffold-scroll-mode-hud"],
  ["keyboard-navigation/components/presentation.css", "caffold-keyboard-navigation-presentation"],
  ["keyboard-navigation/components/selector.css", "caffold-scroll-surface-selector"],
  ["keyboard-navigation/components/shortcut-dialog.css", "caffold-keyboard-shortcut-dialog"],
  ["keyboard-navigation/components/shortcut-list.css", "caffold-keyboard-shortcut-list"],
  ["pages/(task-workspace)/codex-status/components/reset-credit-dialog.css", "caffold-codex-reset-credit-dialog"],
  ["pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css", "caffold-codex-runtime-restart-dialog"],
  ["pages/(task-workspace)/codex-status/components/runtime-update-dialog.css", "caffold-codex-runtime-update-dialog"],
  ["pages/(task-workspace)/components/navigation.css", "caffold-task-workspace-navigation"],
  ["pages/(task-workspace)/components/update-task-dialog.css", "caffold-update-task-dialog"],
  ["pages/(task-workspace)/components/workspace-brand.css", "caffold-workspace-brand"],
  ["pages/(task-workspace)/layout.css", "caffold-task-workspace"],
  ["pages/(task-workspace)/notes/components/document.css", "caffold-note-document"],
  ["pages/(task-workspace)/notes/components/info.css", "caffold-notes-info"],
  ["pages/(task-workspace)/notes/components/info/components/copy-markdown.css", "caffold-notes-info-copy-markdown"],
  ["pages/(task-workspace)/notes/components/info/components/copy-path.css", "caffold-notes-info-copy-path"],
  ["pages/(task-workspace)/notes/components/navigator.css", "caffold-notes-navigator"],
  ["pages/(task-workspace)/notes/layout.css", "caffold-notes-workspace"],
  ["pages/(task-workspace)/settings/about/page.css", "caffold-settings-about-page"],
  ["pages/(task-workspace)/settings/appearance/page.css", "caffold-settings-appearance-page"],
  ["pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.css", "caffold-claude-runtime-restart-dialog"],
  ["pages/(task-workspace)/settings/claude/page.css", "caffold-settings-claude-page"],
  ["pages/(task-workspace)/settings/codex/page.css", "caffold-settings-codex-page"],
  ["pages/(task-workspace)/settings/components/detail-list.css", "caffold-settings-detail-list"],
  ["pages/(task-workspace)/settings/components/navigator.css", "caffold-settings-navigator"],
  ["pages/(task-workspace)/settings/components/navigator/components/item.css", "caffold-settings-navigator-item"],
  ["pages/(task-workspace)/settings/components/refresh-button.css", "caffold-settings-refresh-button"],
  ["pages/(task-workspace)/settings/files/page.css", "caffold-settings-files-page"],
  ["pages/(task-workspace)/settings/grok/page.css", "caffold-settings-grok-page"],
  ["pages/(task-workspace)/settings/jev/page.css", "caffold-settings-jev-page"],
  ["pages/(task-workspace)/settings/keyboard/page.css", "caffold-settings-keyboard-page"],
  ["pages/(task-workspace)/settings/layout.css", "caffold-settings-workspace"],
  ["pages/(task-workspace)/settings/notifications/page.css", "caffold-settings-notifications-page"],
  ["pages/(task-workspace)/settings/remote-access/page.css", "caffold-settings-remote-access-page"],
  ["pages/(task-workspace)/settings/voice/page.css", "caffold-settings-voice-page"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.css", "caffold-commit-changes-tree"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.css", "caffold-git-log-commit-page"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.css", "caffold-git-log-layout"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.css", "caffold-git-log-list-page"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/compare/page.css", "caffold-git-compare-page"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/components/controls.css", "caffold-git-review-controls"],
  ["pages/(task-workspace)/tasks/(detail)/(git)/layout.css", "caffold-task-git-layout"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.css", "caffold-github-issue-detail-page"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.css", "caffold-github-issues-layout"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.css", "caffold-github-issues-list-page"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.css", "caffold-github-pull-detail-page"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.css", "caffold-github-pull-files-tree"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.css", "caffold-github-pull-files-page"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.css", "caffold-github-pulls-layout"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.css", "caffold-github-pulls-list-page"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/components/markdown.css", "caffold-github-markdown"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.css", "caffold-github-task-start-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.css", "caffold-github-issue-task-source"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.css", "caffold-github-pull-task-source"],
  ["pages/(task-workspace)/tasks/(detail)/(github)/layout.css", "caffold-task-github-layout"],
  ["pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.css", "caffold-review-branch-changes"],
  ["pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file.css", "caffold-review-selected-file"],
  ["pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes.css", "caffold-review-working-tree-changes"],
  ["pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.css", "caffold-git-diff-changes-tree"],
  ["pages/(task-workspace)/tasks/(detail)/(review)/layout.css", "caffold-task-review"],
  ["pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.css", "caffold-section-conversation-shortcuts"],
  ["pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.css", "caffold-conversation-fork-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.css", "caffold-section-github-shortcuts"],
  ["pages/(task-workspace)/tasks/(detail)/(section)/components/summary.css", "caffold-section-detail-summary"],
  ["pages/(task-workspace)/tasks/(detail)/(section)/layout.css", "caffold-section-detail"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/broken-delete-dialog.css", "caffold-broken-task-delete-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.css", "caffold-task-command-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.css", "caffold-task-conversation"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.css", "caffold-task-active-turn"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/approval.css", "caffold-task-approval"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.css", "caffold-task-assistant-message"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/copy-button.css", "caffold-task-assistant-message-copy-button"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/suggested-prompts.css", "caffold-task-assistant-message-suggested-prompts"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.css", "caffold-task-changed-files"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group.css", "caffold-task-command-group"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.css", "caffold-task-command"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.css", "caffold-task-markdown"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.css", "caffold-task-markdown-code-block"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/message-attachments.css", "caffold-task-message-attachments"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/older-history.css", "caffold-task-older-history"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/user-message.css", "caffold-task-user-message"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.css", "caffold-task-work-details"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.css", "caffold-task-current-plan"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.css", "caffold-current-plan-document-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.css", "caffold-task-markdown-preview-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/permission-instructions-dialog.css", "caffold-task-permission-instructions-dialog"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/summary.css", "caffold-task-detail-summary"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.css", "caffold-task-detail-info"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.css", "caffold-task-detail-info-actions"],
  ["pages/(task-workspace)/tasks/(detail)/(task)/layout.css", "caffold-task-detail"],
  ["pages/(task-workspace)/tasks/(detail)/components/git-menu.css", "caffold-task-detail-git"],
  ["pages/(task-workspace)/tasks/(detail)/components/github-menu.css", "caffold-task-detail-github"],
  ["pages/(task-workspace)/tasks/(detail)/components/terminal-button.css", "caffold-task-detail-terminal"],
  ["pages/(task-workspace)/tasks/(detail)/layout.css", "caffold-detail-layout"],
  ["pages/(task-workspace)/tasks/(detail)/terminal/components/special-keys.css", "caffold-terminal-special-keys"],
  ["pages/(task-workspace)/tasks/(detail)/terminal/page.css", "caffold-terminal-page"],
  ["pages/(task-workspace)/tasks/components/active-task-list.css", "caffold-active-task-list"],
  ["pages/(task-workspace)/tasks/components/active-task-list/components/section.css", "caffold-active-task-section"],
  ["pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css", "caffold-active-task-row"],
  ["pages/(task-workspace)/tasks/components/archived-delete-dialog.css", "caffold-task-archived-delete-dialog"],
  ["pages/(task-workspace)/tasks/components/archived-task-list.css", "caffold-archived-task-list"],
  ["pages/(task-workspace)/tasks/components/composer.css", "caffold-task-composer"],
  ["pages/(task-workspace)/tasks/components/composer/components/attachments.css", "caffold-task-composer-attachments"],
  ["pages/(task-workspace)/tasks/components/composer/components/context-usage.css", "caffold-task-context-usage"],
  ["pages/(task-workspace)/tasks/components/composer/components/voice-level-meter.css", "caffold-voice-level-meter"],
  ["pages/(task-workspace)/tasks/components/image-preview-dialog.css", "caffold-task-image-preview-dialog"],
  ["pages/(task-workspace)/tasks/components/navigator.css", "caffold-task-navigator"],
  ["pages/(task-workspace)/tasks/components/task-absence.css", "caffold-task-absence"],
  ["pages/(task-workspace)/tasks/components/task-create.css", "caffold-task-create"],
  ["pages/(task-workspace)/tasks/components/task-create/components/directory-field.css", "caffold-task-directory-field"],
  ["pages/(task-workspace)/tasks/components/task-status-chip.css", "caffold-task-status-chip"],
  ["pages/(task-workspace)/tasks/components/task-store-recovery.css", "caffold-task-store-recovery"],
  ["pages/(task-workspace)/tasks/components/task-switcher-dialog.css", "caffold-task-switcher-dialog"],
  ["pages/(task-workspace)/tasks/components/task-turn-options.css", "caffold-task-turn-options"],
  ["pages/(task-workspace)/tasks/layout.css", "caffold-tasks-page"],
  ["pages/(task-workspace)/tasks/new/page.css", "caffold-task-new"],
  ["pages/(task-workspace)/tasks/recovery/page.css", "caffold-task-recovery"],
  ["pages/components/build-mismatch-alert.css", "caffold-build-mismatch-alert"],
  ["pages/components/update-dialog.css", "caffold-update-dialog"],
  ["pages/components/update-result-dialog.css", "caffold-update-result-dialog"],
  ["pages/layout.css", "caffold-app-shell"],
]);
// Child hosts another owner draws that an owner places in its shadow root.
const placedChildren = new Map([
  ["caffold-notes-workspace", ["caffold-notes-navigator"]],
]);
test("resolves flat and nested selectors to the same ownership surface", () => {
  const selectors = effectiveSelectors(`
    caffold-owner {
      color: var(--text);

      & .internal {
        display: grid;
      }

      @media (max-width: 860px) {
        > caffold-child {
          display: block;
        }
      }

      caffold-workspace[data-mode="review"] & .contextual {
        min-width: 0;
      }
    }
  `);

  assert.deepEqual(selectors, [
    "caffold-owner",
    "caffold-owner .internal",
    "caffold-owner > caffold-child",
    'caffold-workspace[data-mode="review"] caffold-owner .contextual',
  ]);
});

test("omits declaration-free nesting containers from effective selectors", () => {
  const selectors = effectiveSelectors(`
    @media (max-width: 860px) {
      caffold-owner {
        & .internal {
          display: grid;
        }
      }
    }
  `);

  assert.deepEqual(selectors, ["caffold-owner .internal"]);
});

test("frontend CSS manifest covers every stylesheet", () => {
  const discovered = discoverFiles(frontendRoot, ".css");
  const declared = [
    ...shadowRootStyles.keys(),
    ...documentRootStyles,
    ...sharedStyles,
    baseStyles,
    "styles.css",
  ].sort();
  assert.deepEqual(declared, discovered);
});

test("a shadow root's stylesheet is its owner's alone and names no element outside the root", () => {
  for (const [path, owner] of shadowRootStyles) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    const module = readFileSync(`${frontendRoot}${path.replace(/\.css$/, ".ts")}`, "utf8");
    const name = path.split("/").pop();
    assert.match(module, new RegExp(`customElement\\("${owner}"\\)`), path);
    assert.match(module, new RegExp(`from "\\./${name.replace(".", "\\.")}\\.js"`), path);
    // A constructed stylesheet drops `@import`; the host is `:host`.
    assert.doesNotMatch(css, /@import\b/, path);
    // A pseudo-element goes after `:host(…)`; inside it, the rule is dropped.
    assert.doesNotMatch(css, /:host\([^)]*::/, path);
    // `:has()` inside `:host()` looks at the host's own children, never the root's.
    assert.doesNotMatch(css, /:host\([^)]*:has\(/, path);
    const selectors = effectiveSelectors(css);
    assert.ok(selectors.some((selector) => selector.startsWith(":host")), path);
    // Another element by name only as a child host the owner draws and places.
    for (const selector of selectors) {
      for (const [element] of selector.matchAll(/caffold-[a-z0-9-]+/g)) {
        assert.ok(
          module.includes(`<${element}`) ||
            module.includes(`createElement("${element}")`) ||
            placedChildren.get(owner)?.includes(element),
          `${path} names ${element}, which ${owner} does not draw`,
        );
        // The element ends the selector, or an argument of a closing `:is()`.
        assert.match(
          selector,
          new RegExp(`${element}(?:\\[[^\\]]*\\]|:[\\w-]+)*(?:,[^()]*)?\\)?$`),
          `${path} reaches inside ${element}: ${selector}`,
        );
      }
    }
  }
});

// WebKit hides a container named on a host from the shadow roots of the
// components drawn inside it.
test("a container another stylesheet queries is not named on a host", () => {
  const stylesheets = discoverFiles(frontendRoot, ".css").map((path) => [
    path,
    readFileSync(`${frontendRoot}${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
  ]);
  for (const [path, css] of stylesheets) {
    for (const [, selectors, body] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
      if (!selectors.split(",").some((selector) => selector.trim().startsWith(":host"))) continue;
      const name = body.match(/\bcontainer(?:-name)?\s*:\s*([\w-]+)/)?.[1];
      if (!name || name === "none") continue;
      const outside = stylesheets
        .filter(([other, otherCss]) =>
          other !== path && new RegExp(`@container\\s+${name}(?![\\w-])`).test(otherCss))
        .map(([other]) => other);
      assert.deepEqual(outside, [], `${path} names ${name} on its host`);
    }
  }
});

test("the base rules every tree takes name no component and import nothing", () => {
  const css = readFileSync(`${frontendRoot}${baseStyles}`, "utf8");
  assert.doesNotMatch(css, /@import\b|caffold-/);
  const entrypoint = readFileSync(`${frontendRoot}styles.css`, "utf8");
  assert.deepEqual(
    [...entrypoint.matchAll(/@import\s+"([^"]+)"/g)].map(([, path]) => path),
    [`./${baseStyles}`],
  );
  assert.ok(entrypoint.startsWith(`@import "./${baseStyles}";`));
});

test("shared styles target only their scope root and pseudo surface", () => {
  assert.ok(sharedStyles.length > 0);
  for (const path of sharedStyles) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    const selectors = effectiveSelectors(css);
    assert.ok(selectors.length > 0, path);
    for (const selector of selectors) {
      assert.match(selector, /^:scope(?::(?:disabled|hover|focus-visible))?(?:::before)?$/, path);
    }
    // A source may name the keyframes it defines, but never a consumer.
    const ownKeyframes = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(([, name]) => name);
    const consumerFacing = ownKeyframes.reduce((text, name) => text.replaceAll(name, ""), css);
    assert.doesNotMatch(consumerFacing, /@import\b|url\s*\(|caffold-/i, path);
  }
});

test("components apply shared styles from `component-styles/` directories and use them for nothing else", () => {
  let applied = 0;
  for (const path of discoverFiles(frontendRoot, ".ts")) {
    const module = readFileSync(`${frontendRoot}${path}`, "utf8");
    const defaults = new Map(
      [...module.matchAll(/^import (\w+) from "([^"]+)";$/gm)].map(([, name, specifier]) => [name, specifier]),
    );
    for (const [, name] of module.matchAll(/\bscopedStyle\(\s*(\w+),/g)) {
      assert.match(defaults.get(name) ?? "", /(?:^|\/)component-styles\/[^/]+\.css\.js$/, `${path} applies ${name}`);
      applied += 1;
    }
    for (const [name, specifier] of defaults) {
      if (!/(?:^|\/)component-styles\//.test(specifier)) continue;
      const uses = module.match(new RegExp(`\\b${name}\\b`, "g")).length - 1;
      const applications =
        module.match(new RegExp(`\\bscopedStyle\\(\\s*${name},`, "g"))?.length ?? 0;
      assert.equal(uses, applications, `${path} uses ${name} other than as a shared style`);
    }
  }
  assert.ok(applied > 0);
});

test("global styles remain parseable without claiming a component owner", () => {
  const css = readFileSync(`${frontendRoot}styles.css`, "utf8");
  assert.ok(effectiveSelectors(css).length > 0);
});

test("Settings detail pages do not reserve space for the master-pane workspace navigation", () => {
  const paths = [
    "pages/(task-workspace)/settings/appearance/page.css",
    "pages/(task-workspace)/settings/files/page.css",
    "pages/(task-workspace)/settings/notifications/page.css",
    "pages/(task-workspace)/settings/remote-access/page.css",
    "pages/(task-workspace)/settings/codex/page.css",
    "pages/(task-workspace)/settings/claude/page.css",
    "pages/(task-workspace)/settings/grok/page.css",
    "pages/(task-workspace)/settings/voice/page.css",
    "pages/(task-workspace)/settings/about/page.css",
  ];
  for (const path of paths) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    assert.equal(
      /--task-workspace-navigation-(?:size|clearance)/.test(css),
      false,
      `${path} must not reserve space for an overlaid workspace navigation`,
    );
  }
});

function discoverFiles(directory, extension, prefix = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests") {
      continue;
    }
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...discoverFiles(`${directory}${entry.name}/`, extension, `${relativePath}/`));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}
