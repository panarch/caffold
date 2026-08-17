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
    return entry.isFile() &&
      entry.name.endsWith(".js") &&
      !entry.name.endsWith(".test.js")
      ? [[relativePath, readFileSync(absolutePath, "utf8")]]
      : [];
  });
}

test("task workspace declares one shared master pane and one detail pane", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const workspaceNavigation = readFrontend(
    "pages/(task-workspace)/components/navigation.js",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.js");
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary.js",
  );
  const taskReview = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(review)/layout.js",
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
  const detailLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/layout.js",
  );
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary.js",
  );
  const git = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/components/git-menu.js",
  );
  const github = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/components/github-menu.js",
  );

  assert.match(detailLayout, /import "\.\/components\/git-menu\.js"/);
  assert.match(detailLayout, /import "\.\/components\/github-menu\.js"/);
  assert.match(
    detailLayout,
    /<caffold-task-detail-git><\/caffold-task-detail-git>/,
  );
  assert.match(
    detailLayout,
    /<caffold-task-detail-github><\/caffold-task-detail-github>/,
  );
  assert.match(detailLayout, /caffold:task-detail-git-intent/);
  assert.match(detailLayout, /caffold:task-detail-github-intent/);
  assert.doesNotMatch(taskSummary, /git-menu|github-menu|caffold-task-detail-git/);
  assert.doesNotMatch(
    detailLayout,
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

test("common Detail owns shared surfaces while Task and Section keep subject work", () => {
  const detailLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/layout.js",
  );
  const taskLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.js",
  );
  const sectionLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/layout.js",
  );
  const sectionGithubShortcuts = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.js",
  );
  const taskCreate = readFrontend(
    "pages/(task-workspace)/tasks/components/task-create.js",
  );
  const globalNew = readFrontend(
    "pages/(task-workspace)/tasks/new/page.js",
  );
  const tasksLayout = readFrontend(
    "pages/(task-workspace)/tasks/layout.js",
  );
  const activeTaskList = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.js",
  );

  for (const child of ["(review)", "(git)", "(github)"]) {
    assert.ok(detailLayout.includes(`import "./${child}/layout.js"`));
  }
  assert.match(detailLayout, /<caffold-task-detail hidden>/);
  assert.match(detailLayout, /<caffold-section-detail hidden>/);
  assert.match(detailLayout, /class="detail-review-slot"/);
  assert.match(detailLayout, /class="detail-git-slot"/);
  assert.match(detailLayout, /class="detail-github-slot"/);
  assert.match(detailLayout, /detailIdentityKey/);
  assert.match(detailLayout, /CLEAN_REVIEW_CACHE_LIMIT/);
  assert.match(detailLayout, /sectionContextKey/);
  assert.match(detailLayout, /rebindSharedDomainContext/);
  assert.match(tasksLayout, /reconcileSelectedSection/);
  assert.match(activeTaskList, /selectedSection: this\.sectionFor/);

  assert.match(taskLayout, /import "\.\/components\/conversation\.js"/);
  assert.match(taskLayout, /import "\.\/components\/command-dialog\.js"/);
  assert.match(taskLayout, /<caffold-task-conversation>/);
  assert.match(taskLayout, /<caffold-task-command-dialog>/);
  assert.doesNotMatch(taskLayout, /\(review\)|\(git\)|\(github\)/);
  assert.doesNotMatch(
    taskLayout,
    /<caffold-task-review|<caffold-task-git-layout|<caffold-task-github-layout|<caffold-task-detail-summary/,
  );

  assert.match(sectionLayout, /import "\.\.\/\.\.\/components\/task-create\.js"/);
  assert.match(sectionLayout, /import "\.\/components\/github-shortcuts\.js"/);
  assert.match(sectionLayout, /<caffold-task-create>/);
  assert.match(sectionLayout, /<caffold-section-github-shortcuts hidden>/);
  assert.doesNotMatch(
    sectionLayout,
    /getGitHubStatus|statusRequestId|section-github-repository/,
  );
  assert.match(sectionGithubShortcuts, /getGitHubStatus/);
  assert.match(sectionGithubShortcuts, /statusRequestId/);
  assert.match(sectionGithubShortcuts, /caffold:section-detail-intent/);
  assert.match(sectionLayout, /browseCwd: false/);
  assert.match(globalNew, /import "\.\.\/components\/task-create\.js"/);
  assert.match(globalNew, /browseCwd: true/);
  assert.match(taskCreate, /class CaffoldTaskCreate/);
  assert.match(taskCreate, /caffold:task-created/);
});

test("Tasks custom elements use routed owners or the nearest components namespace", () => {
  const taskRoot = "pages/(task-workspace)/tasks/";
  const invalidOwners = frontendJavascriptFiles()
    .filter(([path, source]) =>
      path.startsWith(taskRoot) && source.includes("customElements.define")
    )
    .filter(([path]) => {
      const segments = path.split("/");
      const fileName = segments.at(-1);
      return !["page.js", "layout.js"].includes(fileName) &&
        segments.at(-2) !== "components";
    })
    .map(([path]) => path);

  assert.deepEqual(invalidOwners, []);
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
  const files = readFrontend(
    "pages/(task-workspace)/settings/files/page.js",
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
  assert.doesNotMatch(
    files,
    /<caffold-workspace-brand><\/caffold-workspace-brand>/,
  );
  assert.doesNotMatch(taskNavigator, /task-list-primary-(?:brand|icon)/);
  assert.doesNotMatch(settingsNavigator, /<strong>Settings<\/strong>/);
});

test("App Shell owns one foreground recovery UI and retry intent", () => {
  const appShell = readFrontend("pages/layout.js");
  const foreground = readFrontend("pages/foreground-recovery.js");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.js",
  );
  const taskStatus = readFrontend(
    "pages/(task-workspace)/tasks/components/task-status.css",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.js");

  assert.match(appShell, /class="app-foreground-recovery"/);
  assert.match(appShell, /data-action="retry-foreground-recovery"/);
  assert.match(appShell, /requestManualRetry\(\)/);
  assert.match(foreground, /selectForegroundRecoveryPresentation/);
  assert.doesNotMatch(navigator, /<caffold-task-transport-overlay/);
  assert.doesNotMatch(detail, /<caffold-task-transport-overlay/);
  assert.doesNotMatch(navigator, /task-transport-(?:spinner|icon|retry)/);
  assert.doesNotMatch(detail, /task-transport-(?:spinner|icon|retry)/);
  assert.doesNotMatch(navigator, /retry-task-transports|retry-task-stream/);
  assert.doesNotMatch(detail, /retry-task-transports|data-task-action="retry-stream"/);
  assert.doesNotMatch(taskStatus, /task-transport-/);
  assert.match(tasksPage, /caffold:task-transport-status/);
  assert.doesNotMatch(tasksPage, /retryStaleTaskTransports/);
});

test("foreground recovery machine reads from graph to private projection", () => {
  const foreground = readFrontend("pages/foreground-recovery/machine.js");
  const declarations = [
    "export const FOREGROUND_RECOVERY_NODE",
    "export const FOREGROUND_RECOVERY_TRANSITIONS",
    "export const FOREGROUND_RECOVERY_EVENT",
    "export const FOREGROUND_RECOVERY_TRIGGER",
    "export const FOREGROUND_RECOVERY_INTENT",
    "export function createForegroundRecoveryState",
    "export function transitionForegroundRecovery",
    "export function selectForegroundRecoveryPresentation",
  ];
  const positions = declarations.map((declaration) =>
    foreground.indexOf(declaration)
  );

  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.doesNotMatch(foreground, /RECOVERY_REASONS|lastReason|reason:/);
});

test("foreground recovery public exports contain only consumer contracts", () => {
  const foreground = readFrontend("pages/foreground-recovery.js");
  const exportedNames = [...foreground.matchAll(
    /^export (?:class|const|function)\s+([A-Za-z0-9_]+)/gm,
  )].map((match) => match[1]);

  assert.deepEqual(exportedNames, [
    "FOREGROUND_RECOVERY_PRESENTATION",
    "ForegroundRecoveryLifecycle",
  ]);
  assert.doesNotMatch(foreground, /^export\s*\{/m);
  assert.doesNotMatch(
    foreground,
    /export (?:class|const|function) FOREGROUND_RECOVERY_(?:EVENT|INTENT|NODE|TRANSITIONS|TRIGGER)|export function (?:createForegroundRecoveryState|selectForegroundRecoveryPresentation|transitionForegroundRecovery)/,
  );
});

test("PWA update lifecycle keeps one public non-visual owner and private graph", () => {
  const appShell = readFrontend("pages/layout.js");
  const lifecycle = readFrontend("pages/pwa-update-lifecycle.js");
  const machine = readFrontend("pages/pwa-update-lifecycle/machine.js");
  const runtime = readFrontend("pages/pwa-update-lifecycle/runtime.js");
  const serviceWorker = readFrontend("service-worker.js");
  const exportedNames = [...lifecycle.matchAll(
    /^export (?:class|const|function)\s+([A-Za-z0-9_]+)/gm,
  )].map((match) => match[1]);
  const declarations = [
    "export const PWA_UPDATE_HANDOFF_NODE",
    "export const PWA_UPDATE_HANDOFF_TRANSITIONS",
    "export const PWA_UPDATE_TARGET_PHASE",
    "export const PWA_UPDATE_HANDOFF_EVENT",
    "export const PWA_UPDATE_HANDOFF_EFFECT",
    "export function createPwaUpdateHandoffState",
    "export function transitionPwaUpdateHandoff",
  ];
  const positions = declarations.map((declaration) => machine.indexOf(declaration));

  assert.deepEqual(exportedNames, ["PwaUpdateLifecycle"]);
  assert.match(appShell, /from "\.\/pwa-update-lifecycle\.js"/);
  assert.doesNotMatch(appShell, /pwa-update-lifecycle\/(?:machine|runtime)\.js/);
  assert.doesNotMatch(appShell, /components\/pwa-update-lifecycle\.js/);
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.match(runtime, /from "\.\/machine\.js"/);
  assert.match(runtime, /"controllerchange"/);
  assert.match(runtime, /transitionPwaUpdateHandoff\(this\.handoffState, event\)/);
  assert.doesNotMatch(lifecycle, /addEventListener|postMessage|controllerchange/);
  for (const path of [
    "/assets/pages/pwa-update-lifecycle.js",
    "/assets/pages/pwa-update-lifecycle/machine.js",
    "/assets/pages/pwa-update-lifecycle/runtime.js",
  ]) {
    assert.match(serviceWorker, new RegExp(path.replaceAll("/", "\\/")));
  }
});

test("App Shell solely coordinates foreground recovery through public owners", () => {
  const appShell = readFrontend("pages/layout.js");
  const foreground = readFrontend("pages/foreground-recovery.js");
  const browserSignals = readFrontend(
    "pages/foreground-recovery/browser-signals.js",
  );
  const foregroundLifecycle = readFrontend(
    "pages/foreground-recovery/lifecycle.js",
  );
  const workspace = readFrontend("pages/(task-workspace)/layout.js");
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.js");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.js",
  );
  const stream = readFrontend("pages/(task-workspace)/tasks/stream.js");
  const serviceWorker = readFrontend("service-worker.js");

  assert.match(appShell, /new ForegroundRecoveryLifecycle\(/);
  assert.match(appShell, /onRecover: \(request\) => this\.recoverForeground\(request\)/);
  assert.match(appShell, /onSuspend: \(\) => this\.taskWorkspace\.suspendForeground\(\)/);
  assert.match(appShell, /requestInitialActivation\(\{/);
  assert.match(appShell, /requestManualRetry\(\)/);
  assert.doesNotMatch(
    appShell,
    /FOREGROUND_RECOVERY_(?:EVENT|INTENT|NODE|TRANSITIONS|TRIGGER)|reportStage|selectForegroundRecoveryPresentation/,
  );
  for (const signal of [
    "visibilitychange",
    "pageshow",
    "resume",
    "focus",
    "offline",
    "online",
  ]) {
    assert.match(browserSignals, new RegExp(signal));
  }
  assert.match(browserSignals, /connectionTarget/);
  assert.match(foregroundLifecycle, /caffold:notification-activation/);
  assert.doesNotMatch(foreground, /addEventListener|setTimeout\(/);
  assert.match(
    foregroundLifecycle,
    /const next = transitionForegroundRecovery\(this\.state, event\)/,
  );
  assert.match(
    foregroundLifecycle,
    /from "\.\/browser-signals\.js"/,
  );
  assert.doesNotMatch(
    appShell,
    /foreground-recovery\/(?:browser-signals|lifecycle|machine)\.js/,
  );
  assert.match(workspace, /async recoverForeground\(/);
  assert.match(tasksPage, /async recoverForeground\(/);
  assert.doesNotMatch(
    `${workspace}\n${tasksPage}`,
    /FOREGROUND_RECOVERY_(?:EVENT|INTENT|NODE|TRANSITIONS|TRIGGER)|reportStage/,
  );
  assert.match(foreground, /progress: foregroundRecoveryProgress\(reportStage\)/);
  assert.match(foreground, /validatingTransports:/);
  assert.match(navigator, /recoverForeground\(\)/);
  assert.match(detail, /async recoverForeground\(\)/);
  assert.doesNotMatch(stream, /visibilitychange|addEventListener\("focus"/);
  assert.match(serviceWorker, /matching\.postMessage\(\{/);
  assert.match(serviceWorker, /caffold:notification-activation/);
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
});

test("active and archived Task lists own distinct state and lifecycle boundaries", () => {
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const active = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.js",
  );
  const activeStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const archived = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-task-list.js",
  );
  const activeRow = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.js",
  );
  const activeRowStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  );
  const section = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.js",
  );
  const sectionStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
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
  assert.match(activeRow, /customElements\.define\("caffold-active-task-row"/);
  assert.doesNotMatch(
    active,
    /ACTIVE_TASK_ROW_INTENT_EVENT|caffold-active-task-row|li\[data-thread-id/,
  );
  assert.match(section, /createElement\("caffold-active-task-row"\)/);
  assert.match(section, /\.\/section\/components\/row\.js/);
  assert.match(section, /ACTIVE_TASK_ROW_INTENT_EVENT/);
  assert.match(section, /detail: \{ subject: "task", \.\.\.event\.detail \}/);
  assert.doesNotMatch(activeRow, /ACTIVE_TASK_SECTION_INTENT_EVENT/);
  assert.match(
    section,
    /customElements\.define\(\s*"caffold-active-task-section"/,
  );
  assert.match(active, /createElement\(\s*"caffold-active-task-section"/);
  assert.match(section, /list\.className = "task-list"/);
  assert.match(
    section,
    /reconcileRows\(\{ availableRows = new Map\(\), prune = true \} = \{\}\)/,
  );
  assert.match(section, /transferableRows\(localThreadIds, projectedThreadIds\)/);
  assert.match(section, /updateTask\(task\)/);
  assert.match(active, /section\?\.updateTask\(nextTask\)/);
  assert.doesNotMatch(section, /closest\("caffold-active-task-list"\)/);
  assert.doesNotMatch(
    navigator,
    /task-reorder-handle|section-reorder-handle/,
  );
  assert.match(activeRowStyles, /\.task-unseen-complete/);
  assert.match(sectionStyles, /\.task-repository-header|task-repository-select/);
  assert.doesNotMatch(activeStyles, /\.task-row(?:\s|\{|:)/);
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

test("Task and Section reordering keep navigation, ordering, and row presentation owners bounded", () => {
  const api = readFrontend("api.js");
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.js");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.js",
  );
  const active = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.js",
  );
  const activeStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const row = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.js",
  );
  const rowStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  );
  const section = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.js",
  );
  const sectionStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
  );

  assert.match(api, /export async function reorderTask\(threadId, beforeThreadId\)/);
  assert.match(api, /body: \{ beforeThreadId: beforeThreadId \?\? null \}/);
  assert.match(api, /export async function reorderSection\(sectionId, beforeSectionId\)/);
  assert.match(api, /body: \{ beforeSectionId: beforeSectionId \?\? null \}/);
  const reorderControl = navigator.indexOf('data-task-action="toggle-reorder"');
  const newControl = navigator.indexOf('data-task-action="open-new"');
  assert.ok(reorderControl >= 0 && reorderControl < newControl);
  assert.match(navigator, /aria-pressed="\$\{this\.reorderMode !== "none"\}"/);
  assert.match(navigator, /popover="auto"/);
  assert.match(navigator, />Reorder Tasks<\/button>/);
  assert.match(navigator, />Reorder Sections<\/button>/);
  assert.match(navigator, /renderInlineIcon\(\s*"ArrowDownUp"/);
  assert.match(navigator, /this\.activeTaskList\.setReorderMode\(next, \{/);
  assert.match(tasksPage, /exitReorderMode\(\{ restoreFocus: false \}\)/);

  assert.match(active, /reorderTask\(threadId, move\.beforeThreadId\)/);
  assert.match(active, /reorderSection\(sectionId, move\.beforeSectionId\)/);
  assert.match(active, /this\.pendingMove/);
  assert.match(active, /class="sr-only task-reorder-announcement" aria-live="polite"/);
  assert.doesNotMatch(
    active,
    /ACTIVE_TASK_ROW_INTENT_EVENT|caffold-active-task-row|li\[data-thread-id/,
  );
  assert.match(active, /ACTIVE_TASK_SECTION_INTENT_EVENT/);
  assert.match(active, /createElement\(\s*"caffold-active-task-section"/);
  assert.match(section, /createElement\("caffold-active-task-row"\)/);
  assert.match(section, /list\.className = "task-list"/);
  assert.match(section, /updateTaskDropTarget\(threadId, clientY\)/);
  assert.match(section, /clearTaskDropTarget\(\)/);
  assert.match(active, /sectionComponentFor\(drag\.sectionId\)[\s\S]*?updateTaskDropTarget/);
  assert.match(active, /sectionComponentFor\(drag\.sectionId\)\?\.clearTaskDropTarget/);
  assert.doesNotMatch(active, /\.matches\("\.task-list"\)/);
  assert.doesNotMatch(active, /renderInlineIcon\(\s*"Grip",\s*"Reorder Section"/);
  assert.doesNotMatch(active, /addEventListener\("pointer(?:down|move|up|cancel)"/);
  assert.doesNotMatch(active, /function renderTaskRowMeta|function patchTaskListRow/);

  assert.match(row, /renderInlineIcon\("Grip"/);
  assert.match(row, /event\.key === "ArrowUp"/);
  assert.match(row, /event\.key === "ArrowDown"/);
  assert.match(row, /class="task-row task-row-reorder-mode"/);
  assert.doesNotMatch(row, /<button[^>]*class="task-row task-row-reorder-mode"/);
  assert.match(
    rowStyles,
    /grid-template-columns: minmax\(0, 1fr\) 3rem/,
  );
  assert.match(
    rowStyles,
    /& \.task-row-reorder-slot \{[\s\S]*?justify-items: stretch/,
  );
  assert.match(
    rowStyles,
    /& \.task-reorder-handle \{[\s\S]*?width: 100%/,
  );
  assert.match(
    rowStyles,
    /& \.task-row-indicators:not\(\.task-row-reorder-slot\) \{[\s\S]*?@starting-style/,
  );
  assert.match(
    rowStyles,
    /& \.task-reorder-handle-icon \{[\s\S]*?translate: 0\.5rem 0/,
  );
  assert.match(
    sectionStyles,
    /&\[data-reorder-mode="tasks"\] \.task-repository-count,[\s\S]*?transition-duration: 0ms/,
  );
  assert.match(sectionStyles, /translateY\(-8px\)/);
  assert.match(
    sectionStyles,
    /& button\.task-repository-select \{[\s\S]*?position: absolute[\s\S]*?inset: 0/,
  );
  assert.match(
    sectionStyles,
    /& \.task-repository-count \{[\s\S]*?@starting-style/,
  );
  assert.match(section, /renderInlineIcon\(\s*"Grip",\s*"Reorder Section"/);
  assert.match(section, /const POINTER_DRAG_THRESHOLD_PX = 5/);
  assert.match(section, /event\.isPrimary === false/);
  assert.match(section, /handle\.focus\(\{ preventScroll: true \}\)/);
  assert.match(section, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(section, /"lostpointercapture"/);
  assert.match(section, /handle\.releasePointerCapture\(gesture\.pointerId\)/);
  assert.match(section, /event\.key === "ArrowUp"/);
  assert.match(section, /event\.key === "ArrowDown"/);
  assert.match(
    section,
    /const selectable = !section\.recovery && this\.snapshot\.reorderMode === "none"/,
  );
  assert.doesNotMatch(activeStyles, /section-reorder-handle|task-repository-count/);
  assert.match(rowStyles, /min-height: var\(--task-list-row-height\)/);
  assert.match(rowStyles, /@media \(prefers-reduced-motion: reduce\)/);
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
  const tasks = readFrontend("pages/(task-workspace)/tasks/layout.js");
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
