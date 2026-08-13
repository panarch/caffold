import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}

function frontendJavascriptFiles(directory = frontendRoot, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return frontendJavascriptFiles(absolutePath, relativePath);
    }
    return entry.isFile() && entry.name.endsWith(".js")
      ? [[relativePath, readFileSync(absolutePath, "utf8")]]
      : [];
  });
}

test("task workspace declares one shared master pane and one detail pane", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const workspaceNavigation = readFrontend(
    "pages/(task-workspace)/components/navigation.js",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/page.js");
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary.js",
  );
  const taskReview = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/review.js",
  );
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
    /<div class="task-workspace-detail-pane"[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(detailPane, "workspace must declare its detail pane");
  assert.match(detailPane, /<caffold-tasks-page/);
  assert.match(detailPane, /<caffold-settings-workspace/);

  assert.doesNotMatch(workspace, /syncNavigationOwner|\.append\(|\.prepend\(/);
  assert.doesNotMatch(
    workspace,
    /closeActiveSubview|tasksPage\.taskDetailView|tasksPage\?\.taskDetailView/,
  );
  assert.match(workspace, /class="task-workspace-route-control task-workspace-back"/);
  assert.match(workspace, /class="task-workspace-route-control task-workspace-close"/);
  assert.match(workspace, /aria-label="Close new task"/);
  assert.doesNotMatch(tasksPage, /<caffold-task-navigator|workspaceNavigationHost/);
  assert.doesNotMatch(tasksPage, /closeActiveSubview/);
  assert.doesNotMatch(taskSummary, /getGitRefs|\/api\/git\/refs/);
  assert.match(taskReview, /getGitRefs/);
  assert.doesNotMatch(
    settingsWorkspace,
    /<caffold-settings-navigator|workspaceNavigationHost/,
  );
});

test("Git and GitHub detail components independently own their native auto popovers", () => {
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary.js",
  );
  const git = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary/git.js",
  );
  const github = readFrontend(
    "pages/(task-workspace)/tasks/components/detail/summary/github.js",
  );

  assert.match(taskSummary, /import "\.\/summary\/git\.js"/);
  assert.match(taskSummary, /import "\.\/summary\/github\.js"/);
  assert.match(
    taskSummary,
    /<caffold-task-detail-git><\/caffold-task-detail-git>/,
  );
  assert.match(
    taskSummary,
    /<caffold-task-detail-github><\/caffold-task-detail-github>/,
  );
  assert.match(taskSummary, /syncGit\(\)/);
  assert.match(taskSummary, /syncGithub\(\)/);
  assert.match(taskSummary, /caffold:task-detail-git-intent/);
  assert.match(taskSummary, /caffold:task-detail-github-intent/);
  assert.doesNotMatch(
    taskSummary,
    /review-button|popoverId|popover="auto"|renderGitControl|renderGithubControl|patchReviewControls/,
  );

  assert.match(git, /class CaffoldTaskDetailGit/);
  assert.match(git, /class="task-git-button"/);
  assert.match(git, /class="task-git-popover"/);
  assert.match(git, /popover="auto"/);
  assert.match(git, /popovertarget="\$\{this\.popoverId\}"/);
  assert.match(git, /popovertargetaction="hide"/);
  assert.match(git, /data-git-button-action/);
  assert.match(git, /type: "open-git-tool"/);
  assert.match(
    git,
    /customElements\.define\("caffold-task-detail-git"/,
  );
  assert.doesNotMatch(git, /CaffoldTaskDetailGithub|caffold-task-detail-github/);

  assert.match(github, /class CaffoldTaskDetailGithub/);
  assert.match(github, /class="task-github-button"/);
  assert.match(github, /class="task-github-popover"/);
  assert.match(github, /popover="auto"/);
  assert.match(github, /popovertarget="\$\{this\.popoverId\}"/);
  assert.match(github, /popovertargetaction="hide"/);
  assert.match(github, /data-github-button-action/);
  assert.match(github, /type: "open-github-tool"/);
  assert.match(
    github,
    /customElements\.define\("caffold-task-detail-github"/,
  );
  assert.doesNotMatch(
    github,
    /CaffoldTaskDetailGit(?!hub)|caffold-task-detail-git(?!hub)/,
  );

  for (const component of [git, github]) {
    assert.doesNotMatch(
      component,
      /CaffoldTaskReviewButton|REVIEW_BUTTON_CONFIG|<details|<summary|role="menu(?:item)?"/,
    );
  }
});

test("workspace brand owns the shared Tasks and Settings navigator identity", () => {
  const brand = readFrontend(
    "pages/(task-workspace)/components/workspace-brand.js",
  );
  const taskNavigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const settingsNavigator = readFrontend(
    "pages/(task-workspace)/settings/navigator.js",
  );
  const appearance = readFrontend(
    "pages/(task-workspace)/settings/appearance/page.js",
  );

  assert.match(
    brand,
    /customElements\.define\("caffold-workspace-brand"/,
  );
  assert.match(brand, /class="workspace-brand-icon"/);
  assert.match(brand, /class="workspace-brand-title">Caffold/);
  for (const owner of [taskNavigator, settingsNavigator]) {
    assert.match(owner, /<caffold-workspace-brand><\/caffold-workspace-brand>/);
  }
  assert.doesNotMatch(
    appearance,
    /<caffold-workspace-brand><\/caffold-workspace-brand>/,
  );
  assert.doesNotMatch(taskNavigator, /task-list-primary-(?:brand|icon)/);
  assert.doesNotMatch(settingsNavigator, /<strong>Settings<\/strong>/);
});

test("Task transport overlay owns its shared UI and retry intent", () => {
  const overlay = readFrontend(
    "pages/(task-workspace)/tasks/components/task-transport-overlay.js",
  );
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/components/detail.js",
  );
  const taskStatus = readFrontend(
    "pages/(task-workspace)/tasks/components/task-status.css",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/page.js");

  assert.match(
    overlay,
    /customElements\.define\([\s\S]*"caffold-task-transport-overlay"/,
  );
  assert.match(overlay, /TASK_TRANSPORT_RETRY_EVENT/);
  assert.match(overlay, /data-task-transport-retry/);
  assert.match(overlay, /task-transport-spinner/);
  assert.match(overlay, /task-transport-icon/);
  assert.match(navigator, /<caffold-task-transport-overlay/);
  assert.match(detail, /<caffold-task-transport-overlay/);
  assert.doesNotMatch(navigator, /task-transport-(?:spinner|icon|retry)/);
  assert.doesNotMatch(detail, /task-transport-(?:spinner|icon|retry)/);
  assert.doesNotMatch(navigator, /retry-task-transports|retry-task-stream/);
  assert.doesNotMatch(detail, /retry-task-transports|data-task-action="retry-stream"/);
  assert.doesNotMatch(taskStatus, /task-transport-/);
  assert.match(tasksPage, /TASK_TRANSPORT_RETRY_EVENT/);
  assert.match(tasksPage, /retryStaleTaskTransports/);
});

test("Task navigator keeps primary chrome outside its role-specific scrolling lists", () => {
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const renderMarkup = navigator.match(
    /this\.innerHTML = `([\s\S]*?)`;\n\s*}/,
  )?.[1];

  assert.ok(renderMarkup, "navigator render markup must remain inspectable");
  const header = renderMarkup.indexOf("${this.renderPrimaryHeader()}");
  const scroller = renderMarkup.indexOf('<div class="task-list-scroll">');
  const active = renderMarkup.indexOf("<caffold-active-task-list>");
  const archived = renderMarkup.indexOf("<caffold-archived-task-list hidden>");

  assert.ok(header >= 0 && header < scroller);
  assert.ok(active > scroller);
  assert.ok(archived > active);
  assert.match(
    navigator,
    /class="task-list-section-header task-list-primary-header"/,
  );
  assert.match(navigator, /<caffold-workspace-brand><\/caffold-workspace-brand>/);
  assert.match(navigator, /\.task-list-scroll"\)\?\.before/);
});

test("active and archived Task lists own distinct state and lifecycle boundaries", () => {
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const active = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.js",
  );
  const archived = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-task-list.js",
  );
  const activeStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const archivedStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-task-list.css",
  );

  assert.match(active, /customElements\.define\("caffold-active-task-list"/);
  assert.match(active, /getTasks/);
  assert.match(active, /TaskStreamLifecycle/);
  assert.match(active, /aria-label", "Caffold Tasks"/);
  assert.doesNotMatch(active, /getArchivedTasks|restoreTask|deleteTask/);
  assert.doesNotMatch(active, /load-more-tasks|taskListNextCursor/);
  assert.match(activeStyles, /\.task-unseen-complete/);
  assert.doesNotMatch(
    activeStyles,
    /task-archived-|load-more-archived-tasks|load-more-tasks|task-list-pagination/,
  );

  assert.match(
    archived,
    /customElements\.define\("caffold-archived-task-list"/,
  );
  assert.match(archived, /getArchivedTasks/);
  assert.match(archived, /restoreTask/);
  assert.match(archived, /deleteTask/);
  assert.doesNotMatch(archived, /TaskStreamLifecycle|taskListStreamUrl/);
  assert.match(archivedStyles, /\.task-archived-action-button/);
  assert.doesNotMatch(archivedStyles, /task-unseen-complete|load-more-tasks/);

  assert.match(navigator, /<caffold-active-task-list>/);
  assert.match(navigator, /<caffold-archived-task-list hidden>/);
  assert.doesNotMatch(
    navigator,
    /\bgetTasks\b|\bgetArchivedTasks\b|\brestoreTask\b|\bdeleteTask\b|TaskStreamLifecycle/,
  );
});

test("archived task deletion dialog owns its modal state and markup", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const deleteDialog = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-delete-dialog.js",
  );

  assert.match(
    workspace,
    /<caffold-task-archived-delete-dialog><\/caffold-task-archived-delete-dialog>/,
  );
  assert.doesNotMatch(workspace, /<dialog|pendingDeleteTask|showModal\(/);
  assert.match(deleteDialog, /<dialog/);
  assert.match(deleteDialog, /pendingThreadId/);
  assert.match(deleteDialog, /dialog\.showModal\(\)/);
  assert.match(deleteDialog, /TASK_ARCHIVED_DELETE_CONFIRMED_EVENT/);
});

test("Codex status and Task recovery keep explicit lifecycle and UI owners", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const owner = readFrontend("pages/(task-workspace)/codex-status.js");
  const model = readFrontend("pages/(task-workspace)/codex-status/model.js");
  const lifecycle = readFrontend(
    "pages/(task-workspace)/codex-status/lifecycle.js",
  );
  const restartLifecycle = readFrontend(
    "pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js",
  );
  const restartDialog = readFrontend(
    "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js",
  );
  const tasks = readFrontend("pages/(task-workspace)/tasks/page.js");
  const taskRecovery = readFrontend(
    "pages/(task-workspace)/tasks/components/codex-readiness-recovery.js",
  );
  const settings = readFrontend(
    "pages/(task-workspace)/settings/codex/page.js",
  );

  assert.match(workspace, /from "\.\/codex-status\.js"/);
  assert.match(
    workspace,
    /from "\.\/codex-status\/components\/runtime-restart-dialog\.js"/,
  );
  assert.match(
    workspace,
    /<caffold-codex-runtime-restart-dialog><\/caffold-codex-runtime-restart-dialog>/,
  );
  assert.match(owner, /from "\.\/codex-status\/model\.js"/);
  assert.match(
    owner,
    /from "\.\/codex-status\/lifecycle\.js"/,
  );
  assert.match(owner, /function createCodexStatusLifecycle/);
  assert.doesNotMatch(owner, /class CodexStatusLifecycle/);
  assert.doesNotMatch(owner, /export \*/);
  assert.match(model, /function codexBlocksTaskOperations/);
  assert.match(model, /function codexTaskRecoveryVisible/);
  assert.match(lifecycle, /class CodexStatusLifecycle/);
  assert.match(lifecycle, /new CodexRuntimeRestartLifecycle/);
  assert.match(restartLifecycle, /class CodexRuntimeRestartLifecycle/);
  assert.match(restartDialog, /<dialog/);
  assert.match(restartDialog, /customElements\.define\(/);
  assert.match(tasks, /import "\.\/components\/codex-readiness-recovery\.js"/);
  assert.match(tasks, /<caffold-codex-readiness-recovery hidden>/);
  assert.doesNotMatch(tasks, /codex-readiness-card|CODEX_INSTALL_COMMAND/);
  assert.match(taskRecovery, /class CaffoldCodexReadinessRecovery/);
  assert.match(taskRecovery, /codex-readiness-card/);
  assert.match(taskRecovery, /CODEX_STATUS_REFRESH_REQUEST_EVENT/);
  assert.match(taskRecovery, /CODEX_RUNTIME_RESTART_REQUEST_EVENT/);

  for (const consumer of [tasks, settings]) {
    assert.match(consumer, /codex-status\.js"/);
    assert.doesNotMatch(consumer, /codex-status\//);
  }
  assert.doesNotMatch(settings, /restartCodexRuntime|<dialog|runtime-restart-dialog/);

  for (const [path, source] of frontendJavascriptFiles()) {
    const insideOwner =
      path === "pages/(task-workspace)/codex-status.js" ||
      path.startsWith("pages/(task-workspace)/codex-status/");
    const assetInventory = path === "service-worker.js";
    if (!insideOwner && !assetInventory) {
      assert.doesNotMatch(
        source,
        /codex-status\/(?!components\/)/,
        `${path} must consume non-visual Codex status behavior through codex-status.js`,
      );
    }
    if (
      path !== "pages/(task-workspace)/layout.js" &&
      !assetInventory &&
      !path.startsWith("pages/(task-workspace)/codex-status/")
    ) {
      assert.doesNotMatch(
        source,
        /codex-status\/components\//,
        `${path} does not mount a Codex status component`,
      );
    }
  }
});
