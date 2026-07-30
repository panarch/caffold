import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  effectiveSelectors,
  ownershipViolations,
} from "./css-ownership.mjs";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));
const ownership = new Map([
  ["components/code-viewer.css", ["caffold-code-viewer"]],
  ["components/diff-viewer.css", ["caffold-diff-viewer"]],
  ["components/file-browser.css", ["caffold-file-browser"]],
  ["components/file-browser/list.css", ["caffold-file-list"]],
  [
    "components/file-viewer.css",
    ["caffold-file-viewer", "caffold-review-file-viewer"],
  ],
  ["components/git-compare-browser.css", ["caffold-git-compare-browser"]],
  [
    "components/git-compare-browser/compare-tree.css",
    ["caffold-git-compare-tree"],
  ],
  ["components/git-diff-browser.css", ["caffold-git-diff-browser"]],
  [
    "components/git-diff-browser/changes-tree.css",
    ["caffold-git-diff-changes-tree"],
  ],
  ["components/pagination.css", ["caffold-pagination"]],
  [
    "components/review-panel-resizer.css",
    ["caffold-review-panel-resizer"],
  ],
  ["pages/(codex)/layout.css", ["caffold-codex-workspace"]],
  [
    "pages/(codex)/tasks/components/composer.css",
    ["caffold-task-composer"],
  ],
  [
    "pages/(codex)/tasks/components/conversation.css",
    ["caffold-task-conversation"],
  ],
  ["pages/(codex)/tasks/components/detail.css", ["caffold-task-detail"]],
  [
    "pages/(codex)/tasks/components/navigator.css",
    ["caffold-task-navigator"],
  ],
  ["pages/(codex)/tasks/components/review.css", ["caffold-task-review"]],
  ["pages/(codex)/tasks/components/task-new.css", ["caffold-task-new"]],
  ["pages/(codex)/tasks/components/task-status.css", ["caffold-tasks-page"]],
  ["pages/(codex)/tasks/controls.css", ["caffold-tasks-page"]],
  ["pages/(codex)/tasks/page.css", ["caffold-tasks-page"]],
  [
    "pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.css",
    ["caffold-commit-changes-tree"],
  ],
  [
    "pages/(review-workspace)/(git)/(log)/commit/page.css",
    ["caffold-git-log-commit-page"],
  ],
  [
    "pages/(review-workspace)/(git)/(log)/layout.css",
    ["caffold-git-log-layout"],
  ],
  [
    "pages/(review-workspace)/(git)/(log)/list/page.css",
    ["caffold-git-log-list-page"],
  ],
  [
    "pages/(review-workspace)/(git)/compare/page.css",
    ["caffold-git-compare-page"],
  ],
  [
    "pages/(review-workspace)/(git)/components/controls.css",
    ["caffold-git-review-controls"],
  ],
  [
    "pages/(review-workspace)/(git)/diff/page.css",
    ["caffold-git-diff-page"],
  ],
  [
    "pages/(review-workspace)/(git)/layout.css",
    ["caffold-git-review-layout"],
  ],
  [
    "pages/(review-workspace)/(github)/(issues)/detail/page.css",
    ["caffold-github-issue-detail-page"],
  ],
  [
    "pages/(review-workspace)/(github)/(issues)/layout.css",
    ["caffold-github-issues-layout"],
  ],
  [
    "pages/(review-workspace)/(github)/(issues)/list/page.css",
    ["caffold-github-issues-list-page"],
  ],
  [
    "pages/(review-workspace)/(github)/(pulls)/detail/page.css",
    ["caffold-github-pull-detail-page"],
  ],
  [
    "pages/(review-workspace)/(github)/(pulls)/files/components/tree.css",
    ["caffold-github-pull-files-tree"],
  ],
  [
    "pages/(review-workspace)/(github)/(pulls)/files/page.css",
    ["caffold-github-pull-files-page"],
  ],
  [
    "pages/(review-workspace)/(github)/(pulls)/layout.css",
    ["caffold-github-pulls-layout"],
  ],
  [
    "pages/(review-workspace)/(github)/(pulls)/list/page.css",
    ["caffold-github-pulls-list-page"],
  ],
  [
    "pages/(review-workspace)/(github)/layout.css",
    ["caffold-github-review-layout"],
  ],
  ["pages/(review-workspace)/layout.css", ["caffold-review-workspace"]],
  ["pages/components/app-menu.css", ["caffold-app-menu"]],
  ["pages/components/header-actions.css", ["caffold-header-actions"]],
  [
    "pages/components/header-actions/codex-status.css",
    ["caffold-header-actions"],
  ],
  ["pages/components/pathbar.css", ["caffold-pathbar"]],
  ["pages/files/page.css", ["caffold-files-page"]],
  ["pages/layout.css", ["caffold-app-shell"]],
  ["pages/settings/page.css", ["caffold-settings-page"]],
]);
const componentChildren = new Map([
  [
    "caffold-app-shell",
    [
      "caffold-app-menu",
      "caffold-header-actions",
      "caffold-pathbar",
      "caffold-files-page",
      "caffold-codex-workspace",
      "caffold-review-workspace",
      "caffold-settings-page",
    ],
  ],
  ["caffold-files-page", ["caffold-file-browser"]],
  ["caffold-file-browser", ["caffold-file-list", "caffold-file-viewer"]],
  ["caffold-file-viewer", ["caffold-code-viewer", "caffold-diff-viewer"]],
  ["caffold-review-file-viewer", ["caffold-code-viewer", "caffold-diff-viewer"]],
  ["caffold-codex-workspace", ["caffold-tasks-page"]],
  [
    "caffold-tasks-page",
    ["caffold-task-navigator", "caffold-task-new", "caffold-task-detail"],
  ],
  ["caffold-task-new", ["caffold-task-composer"]],
  [
    "caffold-task-detail",
    ["caffold-task-conversation", "caffold-task-composer", "caffold-task-review"],
  ],
  [
    "caffold-task-review",
    [
      "caffold-file-browser",
      "caffold-git-diff-browser",
      "caffold-git-compare-browser",
    ],
  ],
  [
    "caffold-git-diff-browser",
    ["caffold-git-diff-changes-tree", "caffold-review-file-viewer"],
  ],
  [
    "caffold-git-compare-browser",
    ["caffold-git-compare-tree", "caffold-review-file-viewer"],
  ],
  [
    "caffold-review-workspace",
    [
      "caffold-git-review-controls",
      "caffold-git-review-layout",
      "caffold-github-review-layout",
    ],
  ],
  [
    "caffold-git-review-layout",
    ["caffold-git-diff-page", "caffold-git-compare-page", "caffold-git-log-layout"],
  ],
  ["caffold-git-diff-page", ["caffold-git-diff-browser"]],
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
    "caffold-github-review-layout",
    ["caffold-github-issues-layout", "caffold-github-pulls-layout"],
  ],
  [
    "caffold-github-issues-layout",
    ["caffold-github-issues-list-page", "caffold-github-issue-detail-page"],
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
      "task-secondary-button",
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
    :is(caffold-file-viewer, caffold-review-file-viewer) {
      display: grid;

      & .viewer-panel {
        min-width: 0;
      }
    }
  `;

  assert.deepEqual(
    ownershipViolations(css, {
      owners: ["caffold-file-viewer", "caffold-review-file-viewer"],
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

function discoverCssFiles(directory, prefix = "") {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
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
