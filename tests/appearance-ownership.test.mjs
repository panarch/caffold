import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));

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
    /\.task-model-button[\s\S]*min-height: var\(--interface-control-size\)/,
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

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }
    return /\.(?:css|js)$/.test(entry.name) ? [path] : [];
  });
}
