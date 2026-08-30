import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  effectiveSelectors,
  ownershipViolations,
} from "./css-ownership.mjs";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const ownership = new Map([
  ["components/code-viewer.css", ["caffold-code-viewer"]],
  ["components/diff-viewer.css", ["caffold-diff-viewer"]],
  ["components/file-navigator.css", ["caffold-file-navigator"]],
  ["components/file-navigator/list.css", ["caffold-file-list"]],
  ["components/file-tree.css", ["caffold-file-tree"]],
  [
    "components/file-viewer.css",
    ["caffold-review-file-viewer"],
  ],
  [
    "components/markdown-preview.css",
    ["caffold-markdown-preview"],
  ],
  ["components/git-compare-browser.css", ["caffold-git-compare-browser"]],
  [
    "components/git-compare-browser/compare-tree.css",
    ["caffold-git-compare-tree"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(review)/components/changes-tree.css",
    ["caffold-git-diff-changes-tree"],
  ],
  ["components/pagination.css", ["caffold-pagination"]],
  [
    "components/review-panel-resizer.css",
    ["caffold-review-panel-resizer"],
  ],
  ["components/segmented-control.css", ["caffold-segmented-control"]],
  ["pages/(task-workspace)/layout.css", ["caffold-task-workspace"]],
  [
    "pages/(task-workspace)/components/navigation.css",
    ["caffold-task-workspace-navigation"],
  ],
  [
    "pages/(task-workspace)/components/workspace-brand.css",
    ["caffold-workspace-brand"],
  ],
  [
    "pages/(task-workspace)/tasks/components/composer.css",
    ["caffold-task-composer"],
  ],
  [
    "pages/(task-workspace)/tasks/components/task-turn-options.css",
    ["caffold-task-turn-options"],
  ],
  [
    "pages/(task-workspace)/tasks/components/voice-level-meter.css",
    ["caffold-voice-level-meter"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.css",
    ["caffold-task-conversation"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.css",
    ["caffold-task-active-turn"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.css",
    ["caffold-task-assistant-message"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.css",
    ["caffold-task-changed-files"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.css",
    ["caffold-task-command"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.css",
    ["caffold-task-markdown"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.css",
    ["caffold-task-markdown-code-block"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.css",
    ["caffold-task-command-dialog"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.css",
    ["caffold-task-current-plan"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.css",
    ["caffold-current-plan-document-dialog"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.css",
    ["caffold-task-work-details"],
  ],
  [
    "pages/(task-workspace)/tasks/new/components/directory-picker.css",
    ["caffold-task-directory-picker"],
  ],
  [
    "pages/(task-workspace)/tasks/components/archived-delete-dialog.css",
    ["caffold-task-archived-delete-dialog"],
  ],
  [
    "pages/(task-workspace)/tasks/components/image-preview-dialog.css",
    ["caffold-task-image-preview-dialog"],
  ],
  ["pages/(task-workspace)/tasks/(detail)/(task)/layout.css", ["caffold-task-detail"]],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary.css",
    ["caffold-task-detail-summary"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/components/git-menu.css",
    ["caffold-task-detail-git"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/components/github-menu.css",
    ["caffold-task-detail-github"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.css",
    ["caffold-task-detail-info"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.css",
    ["caffold-task-detail-info-actions"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/layout.css",
    ["caffold-detail-layout"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(section)/layout.css",
    ["caffold-section-detail"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.css",
    ["caffold-section-conversation-shortcuts"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.css",
    ["caffold-conversation-fork-dialog"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.css",
    ["caffold-section-github-shortcuts"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(section)/components/summary.css",
    ["caffold-section-detail-summary"],
  ],
  [
    "pages/(task-workspace)/tasks/components/navigator.css",
    ["caffold-task-navigator"],
  ],
  [
    "pages/(task-workspace)/tasks/components/active-task-list.css",
    ["caffold-active-task-list"],
  ],
  [
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
    ["caffold-active-task-section"],
  ],
  [
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
    ["caffold-active-task-row"],
  ],
  [
    "pages/(task-workspace)/tasks/components/archived-task-list.css",
    ["caffold-archived-task-list"],
  ],
  [
    "pages/(task-workspace)/tasks/components/codex-readiness-recovery.css",
    ["caffold-codex-readiness-recovery"],
  ],
  [
    "pages/(task-workspace)/tasks/recovery/page.css",
    ["caffold-task-recovery"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(review)/layout.css",
    ["caffold-task-review"],
  ],
  [
    "pages/(task-workspace)/tasks/components/task-create.css",
    ["caffold-task-create"],
  ],
  ["pages/(task-workspace)/tasks/new/page.css", ["caffold-task-new"]],
  [
    "pages/(task-workspace)/tasks/components/task-status.css",
    [
      "caffold-tasks-page",
      "caffold-active-task-row",
      "caffold-archived-task-list",
    ],
  ],
  ["pages/(task-workspace)/tasks/controls.css", ["caffold-tasks-page"]],
  ["pages/(task-workspace)/tasks/layout.css", ["caffold-tasks-page"]],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.css",
    ["caffold-commit-changes-tree"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.css",
    ["caffold-git-log-commit-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.css",
    ["caffold-git-log-layout"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.css",
    ["caffold-git-log-list-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/compare/page.css",
    ["caffold-git-compare-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/components/controls.css",
    ["caffold-git-review-controls"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(git)/layout.css",
    ["caffold-task-git-layout"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.css",
    ["caffold-github-issue-detail-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.css",
    ["caffold-github-task-start-dialog"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.css",
    ["caffold-github-issue-task-source"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.css",
    ["caffold-github-pull-task-source"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.css",
    ["caffold-github-issues-layout"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.css",
    ["caffold-github-issues-list-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.css",
    ["caffold-github-pull-detail-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.css",
    ["caffold-github-pull-files-tree"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.css",
    ["caffold-github-pull-files-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.css",
    ["caffold-github-pulls-layout"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.css",
    ["caffold-github-pulls-list-page"],
  ],
  [
    "pages/(task-workspace)/tasks/(detail)/(github)/layout.css",
    ["caffold-task-github-layout"],
  ],
  [
    "pages/(task-workspace)/settings/layout.css",
    ["caffold-settings-workspace"],
  ],
  [
    "pages/(task-workspace)/settings/navigator.css",
    ["caffold-settings-navigator"],
  ],
  [
    "pages/(task-workspace)/settings/appearance/page.css",
    ["caffold-settings-appearance-page"],
  ],
  [
    "pages/(task-workspace)/settings/files/page.css",
    ["caffold-settings-files-page"],
  ],
  [
    "pages/(task-workspace)/settings/notifications/page.css",
    ["caffold-settings-notifications-page"],
  ],
  [
    "pages/(task-workspace)/settings/remote-access/page.css",
    ["caffold-settings-remote-access-page"],
  ],
  [
    "pages/(task-workspace)/settings/codex/page.css",
    ["caffold-settings-codex-page"],
  ],
  [
    "pages/(task-workspace)/settings/claude/page.css",
    ["caffold-settings-claude-page"],
  ],
  [
    "pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.css",
    ["caffold-claude-runtime-restart-dialog"],
  ],
  [
    "pages/(task-workspace)/settings/components/detail-list.css",
    ["caffold-settings-detail-list"],
  ],
  [
    "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css",
    ["caffold-codex-runtime-restart-dialog"],
  ],
  [
    "pages/(task-workspace)/settings/about/page.css",
    ["caffold-settings-about-page"],
  ],
  [
    "pages/components/build-mismatch-alert.css",
    ["caffold-build-mismatch-alert"],
  ],
  ["pages/components/update-dialog.css", ["caffold-update-dialog"]],
  ["pages/layout.css", ["caffold-app-shell"]],
]);
const componentChildren = new Map([
  [
    "caffold-app-shell",
    [
      "caffold-task-workspace",
      "caffold-build-mismatch-alert",
      "caffold-update-dialog",
    ],
  ],
  ["caffold-file-navigator", ["caffold-file-list"]],
  [
    "caffold-review-file-viewer",
    ["caffold-code-viewer", "caffold-diff-viewer", "caffold-markdown-preview"],
  ],
  [
    "caffold-task-workspace",
    [
      "caffold-task-navigator",
      "caffold-settings-navigator",
      "caffold-tasks-page",
      "caffold-settings-workspace",
      "caffold-task-archived-delete-dialog",
      "caffold-codex-runtime-restart-dialog",
    ],
  ],
  [
    "caffold-settings-workspace",
    [
      "caffold-settings-appearance-page",
      "caffold-settings-files-page",
      "caffold-settings-codex-page",
      "caffold-settings-about-page",
    ],
  ],
  ["caffold-settings-navigator", ["caffold-workspace-brand"]],
  ["caffold-settings-appearance-page", ["caffold-workspace-brand"]],
  [
    "caffold-tasks-page",
    [
      "caffold-codex-readiness-recovery",
      "caffold-task-new",
      "caffold-detail-layout",
      "caffold-task-recovery",
      "caffold-task-image-preview-dialog",
    ],
  ],
  [
    "caffold-detail-layout",
    [
      "caffold-task-detail",
      "caffold-section-detail-summary",
      "caffold-segmented-control",
      "caffold-task-detail-git",
      "caffold-task-detail-github",
      "caffold-section-detail",
      "caffold-task-review",
      "caffold-task-git-layout",
      "caffold-task-github-layout",
    ],
  ],
  ["caffold-section-detail", ["caffold-task-create"]],
  [
    "caffold-task-new",
    ["caffold-task-create", "caffold-task-directory-picker"],
  ],
  ["caffold-task-create", ["caffold-task-composer"]],
  [
    "caffold-task-navigator",
    [
      "caffold-workspace-brand",
      "caffold-active-task-list",
      "caffold-archived-task-list",
    ],
  ],
  [
    "caffold-active-task-list",
    ["caffold-active-task-section"],
  ],
  ["caffold-active-task-section", ["caffold-active-task-row"]],
  ["caffold-task-directory-picker", ["caffold-file-tree"]],
  [
    "caffold-task-detail",
    [
      "caffold-task-conversation",
      "caffold-task-command-dialog",
      "caffold-task-current-plan",
      "caffold-task-composer",
      "caffold-task-review",
      "caffold-task-git-layout",
      "caffold-task-github-layout",
    ],
  ],
  [
    "caffold-task-current-plan",
    ["caffold-current-plan-document-dialog"],
  ],
  [
    "caffold-current-plan-document-dialog",
    ["caffold-markdown-preview"],
  ],
  [
    "caffold-task-conversation",
    [
      "caffold-task-changed-files",
      "caffold-task-command",
      "caffold-task-markdown",
      "caffold-task-work-details",
    ],
  ],
  ["caffold-task-markdown", ["caffold-task-markdown-code-block"]],
  [
    "caffold-task-work-details",
    ["caffold-task-changed-files", "caffold-task-command"],
  ],
  [
    "caffold-task-review",
    [
      "caffold-file-navigator",
      "caffold-git-diff-changes-tree",
      "caffold-git-compare-tree",
      "caffold-review-panel-resizer",
      "caffold-review-file-viewer",
      "caffold-segmented-control",
    ],
  ],
  [
    "caffold-git-compare-browser",
    ["caffold-git-compare-tree", "caffold-review-file-viewer"],
  ],
  [
    "caffold-task-git-layout",
    ["caffold-git-review-controls", "caffold-git-compare-page", "caffold-git-log-layout"],
  ],
  ["caffold-git-compare-page", ["caffold-git-compare-browser"]],
  [
    "caffold-git-log-layout",
    ["caffold-git-log-list-page", "caffold-git-log-commit-page"],
  ],
  [
    "caffold-git-log-commit-page",
    [
      "caffold-commit-changes-tree",
      "caffold-review-panel-resizer",
      "caffold-review-file-viewer",
    ],
  ],
  [
    "caffold-task-github-layout",
    [
      "caffold-github-issues-layout",
      "caffold-github-pulls-layout",
      "caffold-github-task-start-dialog",
    ],
  ],
  [
    "caffold-github-issues-layout",
    [
      "caffold-github-issues-list-page",
      "caffold-github-issue-detail-page",
    ],
  ],
  [
    "caffold-github-task-start-dialog",
    [
      "caffold-github-issue-task-source",
      "caffold-github-pull-task-source",
      "caffold-task-turn-options",
    ],
  ],
  [
    "caffold-github-pulls-layout",
    [
      "caffold-github-pulls-list-page",
      "caffold-github-pull-detail-page",
      "caffold-github-pull-files-page",
    ],
  ],
  [
    "caffold-github-pull-files-page",
    [
      "caffold-github-pull-files-tree",
      "caffold-review-panel-resizer",
      "caffold-review-file-viewer",
    ],
  ],
]);
const sharedDescendantClasses = new Map([
  [
    "caffold-tasks-page",
    new Set([
      "task-icon-button",
      "task-primary-button",
      "task-secondary-button",
      "task-action-icon",
      "task-status-chip",
      "task-status-spinner",
    ]),
  ],
]);
const KNOWN_OWNERSHIP_DEBT = new Set();

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

test("accepts component internals, contextual owners, and child hosts", () => {
  const css = `
    caffold-owner .internal,
    caffold-workspace[data-mode="review"] caffold-owner .contextual {
      display: grid;
    }

    caffold-owner {
      & > caffold-child[hidden] {
        display: none;
      }
    }
  `;

  assert.deepEqual(
    ownershipViolations(css, {
      owners: ["caffold-owner"],
      path: "valid.css",
    }),
    [],
  );
});

test("rejects missing owners and selectors that enter child internals", () => {
  const css = `
    .unscoped {
      display: block;
    }

    :is(caffold-owner, caffold-other-owner) {
      min-width: 0;
    }

    caffold-owner {
      & > caffold-child {
        & .child-internal {
          display: grid;
        }
      }

      & > :is(caffold-child .nested-child-internal) {
        display: block;
      }
    }
  `;

  assert.deepEqual(
    ownershipViolations(css, {
      owners: ["caffold-owner"],
      path: "invalid.css",
    }),
    [
      "invalid.css selector must include caffold-owner: .unscoped",
      "invalid.css selector includes undeclared component caffold-other-owner: :is(caffold-owner, caffold-other-owner)",
      "invalid.css selector crosses into caffold-child internals: caffold-owner > caffold-child .child-internal",
      "invalid.css selector crosses into caffold-child internals: caffold-owner > :is(caffold-child .nested-child-internal)",
    ],
  );
});

test("supports stylesheets shared by explicitly declared owners", () => {
  const css = `
    :is(caffold-primary-owner, caffold-secondary-owner) {
      display: grid;

      & .viewer-panel {
        min-width: 0;
      }
    }
  `;

  assert.deepEqual(
    ownershipViolations(css, {
      owners: ["caffold-primary-owner", "caffold-secondary-owner"],
      path: "shared.css",
    }),
    [],
  );
});

test("frontend CSS manifest covers every stylesheet", () => {
  const discovered = discoverCssFiles(frontendRoot);
  const declared = [...ownership.keys(), "styles.css"].sort();
  assert.deepEqual(declared, discovered);
});

test("all component styles stay inside their ownership boundaries", () => {
  const violations = [];
  for (const [path, owners] of ownership) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    violations.push(...ownershipViolations(css, { owners, path }));
  }
  assert.deepEqual(violations, []);
});

test("container styles add no untracked descendant ownership debt", () => {
  const classesByOwner = componentClassesByOwner();
  const violations = new Set();
  for (const [path, owners] of ownership) {
    if (!owners.some((owner) => componentChildren.has(owner))) {
      continue;
    }
    const descendantClasses = new Map();
    for (const owner of owners) {
      for (const descendant of componentDescendants(owner)) {
        for (const className of classesByOwner.get(descendant) ?? []) {
          const classOwners = descendantClasses.get(className) ?? new Set();
          classOwners.add(descendant);
          descendantClasses.set(className, classOwners);
        }
      }
    }

    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    for (const selector of effectiveSelectors(css)) {
      for (const className of selectorClasses(selector)) {
        const childOwners = descendantClasses.get(className);
        const explicitlyShared = owners.some((owner) =>
          [owner, ...componentAncestors(owner)].some((ancestor) =>
            sharedDescendantClasses.get(ancestor)?.has(className),
          ),
        );
        if (childOwners && !explicitlyShared) {
          violations.add(
            `${path} selector uses .${className} owned by ${[...childOwners].sort().join(" or ")}: ${compactSelector(selector)}`,
          );
        }
      }
    }
  }
  assert.deepEqual(
    [...violations].sort(),
    [...KNOWN_OWNERSHIP_DEBT].sort(),
    "Update KNOWN_OWNERSHIP_DEBT only when adding or removing an explicitly reviewed ownership boundary",
  );
});

test("global styles remain parseable without claiming a component owner", () => {
  const css = readFileSync(`${frontendRoot}styles.css`, "utf8");
  assert.ok(effectiveSelectors(css).length > 0);
});

test("workspace navigation uses in-flow pane ownership without padding compensation", () => {
  const paths = [
    "pages/(task-workspace)/layout.css",
    "pages/(task-workspace)/components/navigation.css",
    "pages/(task-workspace)/tasks/components/navigator.css",
    "pages/(task-workspace)/settings/navigator.css",
    "pages/(task-workspace)/settings/appearance/page.css",
    "pages/(task-workspace)/settings/files/page.css",
    "pages/(task-workspace)/settings/notifications/page.css",
    "pages/(task-workspace)/settings/remote-access/page.css",
    "pages/(task-workspace)/settings/codex/page.css",
    "pages/(task-workspace)/settings/claude/page.css",
    "pages/(task-workspace)/settings/about/page.css",
  ];
  for (const path of paths) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    assert.equal(
      css.includes("--task-workspace-navigation-size"),
      false,
      `${path} must not reserve space for an overlaid workspace navigation`,
    );
  }
});

function discoverCssFiles(directory, prefix = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "tests") {
      continue;
    }
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...discoverCssFiles(`${directory}${entry.name}/`, `${relativePath}/`));
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      paths.push(relativePath);
    }
  }
  return paths.sort();
}

function componentClassesByOwner() {
  const classesByOwner = new Map();
  for (const [path, owners] of ownership) {
    const css = readFileSync(`${frontendRoot}${path}`, "utf8");
    const classes = stylesheetClasses(css);
    for (const owner of owners) {
      const ownedClasses = classesByOwner.get(owner) ?? new Set();
      for (const className of classes) {
        ownedClasses.add(className);
      }
      classesByOwner.set(owner, ownedClasses);
    }
  }
  return classesByOwner;
}

function componentDescendants(owner, visited = new Set()) {
  const descendants = new Set();
  for (const child of componentChildren.get(owner) ?? []) {
    if (visited.has(child)) {
      continue;
    }
    visited.add(child);
    descendants.add(child);
    for (const descendant of componentDescendants(child, visited)) {
      descendants.add(descendant);
    }
  }
  return descendants;
}

function componentAncestors(owner) {
  const ancestors = new Set();
  for (const [parent, children] of componentChildren) {
    if (!children.includes(owner)) {
      continue;
    }
    ancestors.add(parent);
    for (const ancestor of componentAncestors(parent)) {
      ancestors.add(ancestor);
    }
  }
  return ancestors;
}

function stylesheetClasses(css) {
  const classes = new Set();
  for (const selector of effectiveSelectors(css)) {
    for (const className of selectorClasses(selector)) {
      classes.add(className);
    }
  }
  return classes;
}

function selectorClasses(selector) {
  return [...selector.matchAll(/(^|[^\\])\.(-?[_a-zA-Z][\w-]*)/g)].map(
    (match) => match[2],
  );
}

function compactSelector(selector) {
  return selector.replaceAll(/\s+/g, " ").trim();
}
