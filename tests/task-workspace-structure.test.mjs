import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}

test("task workspace declares one shared master pane and one detail pane", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const workspaceNavigation = readFrontend(
    "pages/(task-workspace)/components/navigation.js",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/page.js");
  const settingsWorkspace = readFrontend(
    "pages/(task-workspace)/settings/layout.js",
  );

  const masterPane = workspace.match(
    /<aside class="task-workspace-master-pane"[\s\S]*?<\/aside>/,
  )?.[0];
  assert.ok(masterPane, "workspace must declare its master pane");
  assert.match(masterPane, /<caffold-task-navigator/);
  assert.match(masterPane, /<caffold-settings-navigator/);
  assert.match(masterPane, /<caffold-task-workspace-navigation/);
  assert.doesNotMatch(masterPane, /<nav class="task-workspace-navigation"/);
  assert.match(workspaceNavigation, /<nav class="task-workspace-navigation"/);
  assert.match(workspaceNavigation, /data-workspace-mode="tasks"/);
  assert.match(workspaceNavigation, /data-workspace-mode="settings"/);

  const detailPane = workspace.match(
    /<main class="task-workspace-detail-pane"[\s\S]*?<\/main>/,
  )?.[0];
  assert.ok(detailPane, "workspace must declare its detail pane");
  assert.match(detailPane, /<caffold-tasks-page/);
  assert.match(detailPane, /<caffold-settings-workspace/);

  assert.doesNotMatch(workspace, /syncNavigationOwner|\.append\(|\.prepend\(/);
  assert.doesNotMatch(tasksPage, /<caffold-task-navigator|workspaceNavigationHost/);
  assert.doesNotMatch(
    settingsWorkspace,
    /<caffold-settings-navigator|workspaceNavigationHost/,
  );
});
