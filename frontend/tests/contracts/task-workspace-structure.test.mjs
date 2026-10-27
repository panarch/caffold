import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}

function frontendModules(directory = frontendRoot, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "tests") {
      return [];
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return frontendModules(absolutePath, relativePath);
    }
    return entry.isFile() &&
      /\.(js|ts)$/.test(entry.name) &&
      !/\.(test|d)\.(js|ts)$/.test(entry.name)
      ? [[relativePath, readFileSync(absolutePath, "utf8")]]
      : [];
  });
}

test("task workspace declares one shared master pane and one detail pane", () => {
  const appShell = readFrontend("pages/layout.ts");
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const workspaceNavigation = readFrontend(
    "pages/(task-workspace)/components/navigation.ts",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.ts");
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary.ts",
  );
  const reviewBranchChanges = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.ts",
  );
  const settingsWorkspace = readFrontend(
    "pages/(task-workspace)/settings/layout.ts",
  );
  const notesWorkspace = readFrontend(
    "pages/(task-workspace)/notes/layout.ts",
  );
  const actionHints = readFrontend(
    "action-hints.ts",
  );
  const keyboardNavigation = readFrontend(
    "keyboard-navigation.ts",
  );
  const actionHintDialog = readFrontend(
    "action-hints/components/dialog.ts",
  );
  const shortcutDialog = readFrontend(
    "keyboard-navigation/components/shortcut-dialog.ts",
  );
  const keyboardSettings = readFrontend(
    "pages/(task-workspace)/settings/keyboard/page.ts",
  );

  const masterPane = workspace.match(
    /<aside\s+\$\{drawn\(this\.parts\.of\("master-pane"\)\)\}\s+class="task-workspace-master-pane"[\s\S]*?<\/aside>/,
  )?.[0];
  assert.ok(masterPane, "workspace must declare its master pane");
  assert.match(masterPane, /<caffold-task-navigator/);
  assert.match(masterPane, /<caffold-notes-navigator/);
  assert.match(masterPane, /<caffold-settings-navigator/);
  assert.match(masterPane, /<caffold-task-workspace-navigation/);
  assert.doesNotMatch(masterPane, /<nav class="task-workspace-navigation"/);
  assert.match(workspaceNavigation, /<nav class="task-workspace-navigation"/);
  assert.match(workspaceNavigation, /mode: "tasks"/);
  assert.match(workspaceNavigation, /mode: "notes"/);
  assert.match(workspaceNavigation, /mode: "settings"/);

  const detailPane = workspace.match(
    /<div\s+\$\{drawn\(this\.parts\.of\("detail-pane"\)\)\}\s+class="task-workspace-detail-pane"[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(detailPane, "workspace must declare its detail pane");
  assert.match(detailPane, /<caffold-tasks-page/);
  assert.match(detailPane, /<caffold-notes-workspace/);
  assert.match(detailPane, /<caffold-settings-workspace/);

  assert.doesNotMatch(workspace, /syncNavigationOwner|\.append\(|\.prepend\(/);
  assert.doesNotMatch(
    workspace,
    /closeActiveSubview|tasksPage\.taskDetailView|tasksPage\?\.taskDetailView/,
  );
  const routeControls = workspace.match(
    /<div\s+\$\{drawn\(this\.parts\.of\("route-controls"\)\)\}\s+class="task-workspace-route-controls"\s*>[\s\S]*?<\/div>/,
  )?.[0];
  assert.ok(routeControls, "workspace must group its compact route controls");
  assert.match(
    routeControls,
    /class="task-workspace-route-control task-workspace-back"/,
  );
  assert.match(
    routeControls,
    /class="task-workspace-route-control task-workspace-switcher"/,
  );
  assert.doesNotMatch(tasksPage, /<caffold-task-navigator|workspaceNavigationHost/);
  assert.doesNotMatch(tasksPage, /closeActiveSubview/);
  assert.doesNotMatch(taskSummary, /getGitRefs|\/api\/git\/refs/);
  assert.match(reviewBranchChanges, /getGitRefs/);
  assert.doesNotMatch(
    settingsWorkspace,
    /<caffold-settings-navigator|workspaceNavigationHost/,
  );
  assert.doesNotMatch(
    notesWorkspace,
    /<caffold-notes-navigator|workspaceNavigationHost/,
  );
  assert.equal(
    [...workspace.matchAll(/<caffold-action-hint-dialog>/g)].length,
    0,
  );
  assert.equal(
    [...appShell.matchAll(/<caffold-keyboard-navigation-presentation\b/g)].length,
    1,
  );
  assert.equal(
    [...appShell.matchAll(/<caffold-keyboard-shortcut-dialog\b/g)].length,
    1,
  );
  assert.match(appShell, /shortcutDialog: this\.keyboardShortcutDialog/);
  assert.match(appShell, /new KeyboardNavigationController\(/);
  assert.doesNotMatch(workspace, /new KeyboardNavigationController\(/);
  assert.match(
    keyboardNavigation,
    /document\.addEventListener\("keydown", this\.boundKeydown, true\)/,
  );
  assert.doesNotMatch(actionHints, /document\.addEventListener\("keydown"/);
  for (const [path, source] of frontendModules()) {
    if (path !== "action-hints.ts" && !path.startsWith("action-hints/")) {
      assert.doesNotMatch(
        source,
        /(?:\.{1,2}\/)+action-hints\/(?:control|model)\.js/,
        path,
      );
    }
    if (
      path !== "keyboard-navigation.ts" &&
      !path.startsWith("keyboard-navigation/")
    ) {
      assert.doesNotMatch(
        source,
        /(?:\.{1,2}\/)+keyboard-navigation\/(?:context|control|model)\.js/,
        path,
      );
    }
  }
  assert.doesNotMatch(actionHints, /customElements\.define/);
  assert.match(
    actionHintDialog,
    /customElements\.define\(\s*"caffold-action-hint-dialog"/,
  );
  assert.match(
    shortcutDialog,
    /customElements\.define\(\s*"caffold-keyboard-shortcut-dialog"/,
  );
  assert.match(settingsWorkspace, /import "\.\/keyboard\/page\.js"/);
  assert.equal(
    [...settingsWorkspace.matchAll(/<caffold-settings-keyboard-page/g)].length,
    1,
  );
  assert.match(
    keyboardSettings,
    /customElements\.define\(\s*"caffold-settings-keyboard-page"/,
  );
});

test("App Shell owns one global keyboard listener over explicit Scroll providers", () => {
  const keyboardOwners = frontendModules()
    .filter(([, source]) =>
      /document\.addEventListener\(\s*["']keydown["']/.test(source)
    )
    .map(([path]) => path);
  assert.deepEqual(keyboardOwners, [
    "keyboard-navigation.ts",
  ]);

  const keyboardNavigation = readFrontend(
    "keyboard-navigation.ts",
  );
  const taskNavigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const conversation = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.ts",
  );
  const currentPlanDialog = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.ts",
  );

  assert.doesNotMatch(
    keyboardNavigation,
    /querySelector(?:All)?\([^\n]*(?:scroll|overflow)|elementFromPoint|last(?:Pointer|Scroll)/i,
  );
  assert.match(
    taskNavigator,
    /this\.surfaces\.surface\(\{\s*id: "task-list",[\s\S]*?\}\)\}\s*class="task-list-scroll"/,
  );
  assert.match(
    conversation,
    /\$\{drawn\(this\.scrollerElement\)\}\s*\$\{this\.surfaces\.surface\(\{[\s\S]*?\}\)\}\s*class="task-conversation-scroll"/,
  );
  assert.match(currentPlanDialog, /this\.preview\b/);
  assert.match(currentPlanDialog, /preview\.value\?\.scrollSurfaceScope\(/);
});

test("App Shell owns the normal context and route cleanup while Task Workspace provides product state", () => {
  const appShell = readFrontend("pages/layout.ts");
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const presentation = readFrontend(
    "keyboard-navigation/components/presentation.ts",
  );
  const context = readFrontend("keyboard-navigation/context.ts");

  assert.equal([...appShell.matchAll(/this\.keyboard\.workspace\(/g)].length, 1);
  assert.match(appShell, /this\.keyboardNavigation\.connect\(\)/);
  assert.match(appShell, /this\.keyboardNavigation\.disconnect\(\)/);
  assert.match(appShell, /this\.taskWorkspace\.actionHintScope\(\)/);
  assert.match(appShell, /this\.taskWorkspace\.scrollSurfaceScope\(\)/);
  assert.match(appShell, /this\.taskWorkspace\.actionHintEditingEscapeTarget/);
  assert.match(appShell, /this\.taskWorkspace\.afterActionHintActivation/);
  assert.doesNotMatch(workspace, /keyboardNavigation\.(?:connect|disconnect|routeWillChange)/);
  assert.match(workspace, /actionHintScope\(\)/);
  assert.match(workspace, /scrollSurfaceScope\(\)/);
  assert.match(workspace, /keyboardNavigationContexts\(\)/);
  assert.match(presentation, /<caffold-action-hint-dialog\b/);
  assert.match(presentation, /<caffold-scroll-mode-hud\b/);
  assert.match(presentation, /<caffold-scroll-surface-selector\b/);
  assert.doesNotMatch(presentation, /<caffold-keyboard-shortcut-dialog\b/);
  assert.match(context, /!context\.root\.contains\(context\.presentation\)/);

  const applyRoute = appShell.match(
    /async applyRoute\([\s\S]*?\n  \}\n/,
  )?.[0] ?? "";
  assert.ok(applyRoute);
  assert.ok(
    applyRoute.indexOf("routeWillChange()") <
      applyRoute.indexOf("this.currentRoute = route"),
  );
});

test("registered dialog contexts stay owned and compose through public providers", () => {
  const appShell = readFrontend("pages/layout.ts");
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const tasks = readFrontend("pages/(task-workspace)/tasks/layout.ts");
  const taskNew = readFrontend("pages/(task-workspace)/tasks/new/page.ts");
  const section = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/layout.ts",
  );
  const task = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.ts",
  );
  const github = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(github)/layout.ts",
  );

  for (const source of [appShell, workspace, tasks, section, task, github]) {
    assert.match(source, /mergeKeyboardNavigationContexts\(/);
  }
  assert.match(appShell, /this\.updateDialog\.value\?\.keyboardNavigationContexts/);
  assert.match(appShell, /this\.taskWorkspace\.keyboardNavigationContexts/);
  assert.match(workspace, /this\.codexRuntimeRestartDialog\.keyboardNavigationContexts/);
  assert.match(workspace, /this\.claudeRuntimeRestartDialog\.keyboardNavigationContexts/);
  assert.match(workspace, /this\.archivedDeleteDialog\.keyboardNavigationContexts/);
  assert.match(workspace, /this\.taskSwitcherDialog\.keyboardNavigationContexts/);
  assert.match(tasks, /this\.imagePreviewDialog\.value\?\.keyboardNavigationContexts/);
  assert.match(taskNew, /this\.create\.value\?\.keyboardNavigationContexts/);
  assert.match(section, /this\.conversationShortcuts\(\)\?\.keyboardNavigationContexts/);
  assert.match(task, /this\.currentPlanComponent\.value\?\.keyboardNavigationContexts/);
  assert.match(task, /this\.commandDialog\.value\?\.keyboardNavigationContexts/);
  assert.match(task, /this\.markdownPreviewDialog\.value\?\.keyboardNavigationContexts/);
  assert.match(github, /this\.taskStartDialog\.keyboardNavigationContexts/);
  assert.doesNotMatch(
    workspace,
    /querySelectorAll\([^\n]*(?:dialog[^\n]*button|button[^\n]*dialog)/,
  );
});

test("registered product dialogs retain one context-local keyboard presentation", () => {
  const dialogs = [
    "pages/components/update-dialog.ts",
    "pages/components/update-result-dialog.ts",
    "pages/(task-workspace)/components/update-task-dialog.ts",
    "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.ts",
    "pages/(task-workspace)/codex-status/components/runtime-update-dialog.ts",
    "pages/(task-workspace)/codex-status/components/reset-credit-dialog.ts",
    "pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.ts",
    "pages/(task-workspace)/tasks/components/archived-delete-dialog.ts",
    "pages/(task-workspace)/tasks/components/task-switcher-dialog.ts",
    "pages/(task-workspace)/tasks/components/image-preview-dialog.ts",
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.ts",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.ts",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.ts",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.ts",
    "pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.ts",
  ];

  for (const path of dialogs) {
    const source = readFrontend(path);
    assert.equal(
      [...source.matchAll(/<caffold-keyboard-navigation-presentation\b/g)].length,
      1,
      path,
    );
    assert.match(source, /this\.keyboard\.presentation\(\)/, path);
    assert.match(source, /this\.keyboard\.modal\(/, path);
  }
});

test("product dialog CSS does not style nested keyboard presentation dialogs", () => {
  const styles = [
    "pages/components/update-dialog.css",
    "pages/components/update-result-dialog.css",
    "pages/(task-workspace)/components/update-task-dialog.css",
    "pages/(task-workspace)/tasks/components/image-preview-dialog.css",
    "pages/(task-workspace)/tasks/components/task-switcher-dialog.css",
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.css",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.css",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.css",
    "pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.css",
    "pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.css",
  ];

  for (const path of styles) {
    const source = readFrontend(path);
    assert.match(source, /& > dialog \{/m, path);
    assert.match(source, /& > dialog::backdrop \{/m, path);
    assert.doesNotMatch(source, /^\s*& dialog(?:\b|::|\[)/m, path);
  }
});

test("Git and GitHub detail components independently own their native auto popovers", () => {
  const detailLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/layout.ts",
  );
  const taskSummary = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary.ts",
  );
  const git = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/components/git-menu.ts",
  );
  const github = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/components/github-menu.ts",
  );

  assert.match(detailLayout, /import "\.\/components\/git-menu\.js"/);
  assert.match(detailLayout, /import "\.\/components\/github-menu\.js"/);
  assert.match(
    detailLayout,
    /<caffold-task-detail-git\b/,
  );
  assert.match(
    detailLayout,
    /<caffold-task-detail-github\b/,
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
  assert.match(git, /popovertarget=\$\{this\.popoverId\}/);
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
  assert.match(github, /popovertarget=\$\{this\.popoverId\}/);
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
    "pages/(task-workspace)/tasks/(detail)/layout.ts",
  );
  const taskLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.ts",
  );
  const sectionLayout = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/layout.ts",
  );
  const sectionGithubShortcuts = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.ts",
  );
  const sectionConversationShortcuts = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.ts",
  );
  const conversationForkDialog = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.ts",
  );
  const taskCreate = readFrontend(
    "pages/(task-workspace)/tasks/components/task-create.ts",
  );
  const globalNew = readFrontend(
    "pages/(task-workspace)/tasks/new/page.ts",
  );
  const tasksLayout = readFrontend(
    "pages/(task-workspace)/tasks/layout.ts",
  );
  const activeTaskList = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.ts",
  );

  for (const child of ["(review)", "(git)", "(github)"]) {
    assert.ok(detailLayout.includes(`import "./${child}/layout.js"`));
  }
  assert.match(
    detailLayout,
    /<caffold-task-detail\s+\$\{drawn\(this\.taskDetail\)\}\s+hidden\b/,
  );
  assert.match(
    detailLayout,
    /<caffold-section-detail\s+\$\{drawn\(this\.sectionDetail\)\}\s+hidden\b/,
  );
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
  assert.match(taskLayout, /import "\.\/components\/markdown-preview-dialog\.js"/);
  assert.match(taskLayout, /<caffold-task-conversation\b/);
  assert.match(taskLayout, /<caffold-task-command-dialog\b/);
  assert.match(taskLayout, /<caffold-task-markdown-preview-dialog\b/);
  assert.doesNotMatch(taskLayout, /\(review\)|\(git\)|\(github\)/);
  assert.doesNotMatch(
    taskLayout,
    /<caffold-task-review|<caffold-task-git-layout|<caffold-task-github-layout|<caffold-task-detail-summary/,
  );

  assert.match(sectionLayout, /import "\.\.\/\.\.\/components\/task-create\.js"/);
  assert.match(sectionLayout, /import "\.\/components\/github-shortcuts\.js"/);
  assert.match(sectionLayout, /import "\.\/components\/conversation-shortcuts\.js"/);
  assert.match(sectionLayout, /<caffold-task-create\b/);
  assert.match(
    sectionLayout,
    /<caffold-section-conversation-shortcuts\s+\$\{drawn\(this\.conversations\)\}\s+hidden\s*>/,
  );
  assert.match(
    sectionLayout,
    /<caffold-section-github-shortcuts\s+\$\{drawn\(this\.github\)\}\s+hidden\s*>/,
  );
  assert.doesNotMatch(
    sectionLayout,
    /getGitHubStatus|statusRequestId|section-github-repository/,
  );
  assert.match(sectionGithubShortcuts, /getGitHubStatus/);
  assert.match(sectionGithubShortcuts, /statusRequestId/);
  assert.match(sectionGithubShortcuts, /caffold:section-detail-intent/);
  assert.match(sectionConversationShortcuts, /<caffold-conversation-fork-dialog\b/);
  assert.match(sectionConversationShortcuts, /Fork from Codex thread ID/);
  assert.match(conversationForkDialog, /previewTaskForkSource/);
  assert.match(conversationForkDialog, /createTaskFork/);
  assert.match(conversationForkDialog, /caffold:task-created/);
  assert.match(sectionLayout, /browseCwd: false/);
  assert.match(globalNew, /import "\.\.\/components\/task-create\.js"/);
  assert.match(globalNew, /browseCwd: true/);
  assert.match(taskCreate, /class CaffoldTaskCreate/);
  assert.match(taskCreate, /caffold:task-create-intent/);
  assert.doesNotMatch(taskCreate, /await createTask|caffold:task-created/);
  assert.match(tasksLayout, /^  createTask,$/m);
  assert.match(tasksLayout, /pendingTaskCreation/);
  assert.match(tasksLayout, /startTaskCreation/);
  assert.match(tasksLayout, /createAndAdoptTask/);
});

test("custom elements use routed owners or the nearest components namespace", () => {
  const invalidOwners = frontendModules()
    .filter(([, source]) => source.includes("customElements.define"))
    .filter(([path]) => {
      const segments = path.split("/");
      const fileName = segments.at(-1);
      return !["page.js", "page.ts", "layout.js", "layout.ts"].includes(fileName) &&
        segments.at(-2) !== "components";
    })
    .map(([path]) => path);

  assert.deepEqual(invalidOwners, []);
});

test("Task Info keeps action presentation in its private leaf", () => {
  const info = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.ts",
  );
  const actions = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.ts",
  );

  assert.match(info, /import "\.\/info\/components\/actions\.js"/);
  assert.match(info, /<caffold-task-detail-info-actions\b/);
  assert.match(info, /caffold:task-detail-info-action-intent/);
  assert.doesNotMatch(info, /data-task-info-action|forkDisabledReason/);

  assert.match(actions, /customElements\.define/);
  assert.match(actions, /data-task-info-action="fork"/);
  assert.match(actions, /data-task-info-action="archive"/);
  assert.match(actions, /caffold:task-detail-info-action-intent/);
  assert.doesNotMatch(actions, /forkTask|archiveTask/);
});

test("workspace brand owns the shared Tasks, Notes, and Settings navigator identity", () => {
  const brand = readFrontend(
    "pages/(task-workspace)/components/workspace-brand.ts",
  );
  const taskNavigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const settingsNavigator = readFrontend(
    "pages/(task-workspace)/settings/components/navigator.ts",
  );
  const notesNavigator = readFrontend(
    "pages/(task-workspace)/notes/components/navigator.ts",
  );
  const appearance = readFrontend(
    "pages/(task-workspace)/settings/appearance/page.ts",
  );
  const files = readFrontend(
    "pages/(task-workspace)/settings/files/page.ts",
  );

  assert.match(
    brand,
    /customElements\.define\("caffold-workspace-brand"/,
  );
  assert.match(brand, /class="workspace-brand-icon"/);
  assert.match(brand, /class="workspace-brand-title">Caffold/);
  for (const owner of [taskNavigator, notesNavigator, settingsNavigator]) {
    assert.match(
      owner,
      /<caffold-workspace-brand\b[^>]*><\/caffold-workspace-brand>/,
    );
  }
  assert.doesNotMatch(
    appearance,
    /<caffold-workspace-brand\b[^>]*><\/caffold-workspace-brand>/,
  );
  assert.doesNotMatch(
    files,
    /<caffold-workspace-brand\b[^>]*><\/caffold-workspace-brand>/,
  );
  assert.doesNotMatch(taskNavigator, /task-list-primary-(?:brand|icon)/);
  assert.doesNotMatch(settingsNavigator, /<strong>Settings<\/strong>/);
});

test("App Shell owns one foreground recovery UI and retry intent", () => {
  const appShell = readFrontend("pages/layout.ts");
  const foreground = readFrontend("pages/foreground-recovery.ts");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.ts",
  );
  const taskStatus = readFrontend(
    "pages/(task-workspace)/tasks/components/task-status-chip.css",
  );
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.ts");

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
  const foreground = readFrontend("pages/foreground-recovery/machine.ts");
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
  const foreground = readFrontend("pages/foreground-recovery.ts");
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
  const appShell = readFrontend("pages/layout.ts");
  const lifecycle = readFrontend("pages/pwa-update-lifecycle.ts");
  const machine = readFrontend("pages/pwa-update-lifecycle/machine.ts");
  const runtime = readFrontend("pages/pwa-update-lifecycle/runtime.ts");
  const serviceWorker = readFrontend("service-worker.ts");
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
  const appShell = readFrontend("pages/layout.ts");
  const foreground = readFrontend("pages/foreground-recovery.ts");
  const browserSignals = readFrontend(
    "pages/foreground-recovery/browser-signals.ts",
  );
  const foregroundLifecycle = readFrontend(
    "pages/foreground-recovery/lifecycle.ts",
  );
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.ts");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const detail = readFrontend(
    "pages/(task-workspace)/tasks/(detail)/(task)/layout.ts",
  );
  const stream = readFrontend("pages/(task-workspace)/tasks/stream.ts");
  const serviceWorker = readFrontend("service-worker.ts");

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
  assert.match(serviceWorker, /client\.postMessage\(\{/);
  assert.match(serviceWorker, /caffold:notification-activation/);
});

test("Task navigator keeps primary chrome outside its role-specific scrolling lists", () => {
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const renderMarkup = navigator.match(
    /\n  render\(\) \{[\s\S]*?return html`([\s\S]*?)`;\n {2}}/,
  )?.[1];

  assert.ok(renderMarkup, "navigator render markup must remain inspectable");
  const header = renderMarkup.indexOf(
    '<header class="task-list-section-header task-list-primary-header">',
  );
  const scroller = renderMarkup.search(/<div\b[^`]*?class="task-list-scroll"/);
  const active = renderMarkup.search(/<caffold-active-task-list\b/);
  const archived = renderMarkup.search(/<caffold-archived-task-list\s+\$\{drawn\(this\.archivedList\)\}\s+hidden\b/);

  assert.ok(header >= 0 && header < scroller);
  assert.ok(active > scroller);
  assert.ok(archived > active);
  assert.match(
    navigator,
    /class="task-list-section-header task-list-primary-header"/,
  );
  assert.match(navigator, /<caffold-workspace-brand\b[^>]*><\/caffold-workspace-brand>/);
});

test("active and archived Task lists own distinct state and lifecycle boundaries", () => {
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const active = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.ts",
  );
  const activeStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const archived = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-task-list.ts",
  );
  const activeRow = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.ts",
  );
  const activeRowStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  );
  const section = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.ts",
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
  assert.match(section, /new CaffoldActiveTaskRow\(\)/);
  assert.match(section, /\.\/section\/components\/row\.js/);
  assert.match(section, /@caffold:active-task-row-intent=/);
  assert.match(section, /detail: \{ subject: "task", \.\.\.event\.detail \}/);
  assert.doesNotMatch(activeRow, /ACTIVE_TASK_SECTION_INTENT_EVENT/);
  assert.match(
    section,
    /customElements\.define\(\s*"caffold-active-task-section"/,
  );
  assert.match(active, /new CaffoldActiveTaskSection\(\)/);
  assert.match(section, /<ol\s+\$\{drawn\(this\.list\)\}\s+class="task-list"/);
  assert.match(
    section,
    /reconcileRows\(availableRows: Map<string, HTMLLIElement>\)/,
  );
  assert.match(section, /transferableRows\(localThreadIds: Set<string>, listedThreadIds: Set<string>\)/);
  assert.match(section, /updateTask\(task: ListedTask\)/);
  assert.match(active, /sectionComponentFor\(listKey\)\?\.updateTask\(next\)/);
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

  assert.match(navigator, /<caffold-active-task-list\b/);
  assert.match(navigator, /<caffold-archived-task-list\s+\$\{drawn\(this\.archivedList\)\}\s+hidden\b/);
  assert.doesNotMatch(
    navigator,
    /\bgetTasks\b|\bgetArchivedTasks\b|\brestoreTask\b|\bdeleteTask\b|TaskStreamLifecycle/,
  );
});

test("Task and Section reordering keep navigation, ordering, and row presentation owners bounded", () => {
  const api = readFrontend("api.ts");
  const tasksPage = readFrontend("pages/(task-workspace)/tasks/layout.ts");
  const navigator = readFrontend(
    "pages/(task-workspace)/tasks/components/navigator.ts",
  );
  const active = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.ts",
  );
  const activeStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list.css",
  );
  const row = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.ts",
  );
  const rowStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  );
  const section = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.ts",
  );
  const sectionStyles = readFrontend(
    "pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
  );

  assert.match(api, /export async function reorderTask\(\s*threadId: string,\s*beforeThreadId: string \| null,\s*\)/);
  assert.match(api, /body: \{ beforeThreadId: beforeThreadId \?\? null \}/);
  assert.match(api, /export async function reorderSection\(\s*sectionId: string,\s*beforeSectionId: string \| null,\s*\)/);
  assert.match(api, /body: \{ beforeSectionId: beforeSectionId \?\? null \}/);
  const switcherControl = navigator.indexOf(
    'data-task-action="open-task-switcher"',
  );
  const reorderControl = navigator.indexOf('data-task-action="toggle-reorder"');
  const newControl = navigator.indexOf('data-task-action="open-new"');
  assert.ok(
    switcherControl >= 0 &&
      switcherControl < reorderControl &&
      reorderControl < newControl,
  );
  assert.match(navigator, /const reordering = this\.reorderMode !== "none"/);
  assert.match(navigator, /aria-pressed=\$\{reordering\}/);
  assert.match(navigator, /popover="auto"/);
  assert.match(navigator, />Reorder Tasks<\/button>/);
  assert.match(navigator, />Reorder Sections<\/button>/);
  assert.match(navigator, /inlineIcon\(\s*"ArrowDownUp"/);
  assert.match(navigator, /activeList\.setReorderMode\(mode, \{/);
  assert.match(tasksPage, /exitReorderMode\(\{ restoreFocus: false \}\)/);

  assert.match(active, /reorderTask\(threadId, beforeThreadId\)/);
  assert.match(active, /reorderSection\(sectionId, beforeSectionId\)/);
  assert.match(active, /this\.pendingMove/);
  assert.match(
    active,
    /class="sr-only task-reorder-announcement"\s+aria-live="polite"/,
  );
  assert.doesNotMatch(
    active,
    /ACTIVE_TASK_ROW_INTENT_EVENT|caffold-active-task-row|li\[data-thread-id/,
  );
  assert.match(active, /@caffold:active-task-section-intent=/);
  assert.match(active, /new CaffoldActiveTaskSection\(\)/);
  assert.match(section, /new CaffoldActiveTaskRow\(\)/);
  assert.match(section, /<ol\s+\$\{drawn\(this\.list\)\}\s+class="task-list"/);
  assert.match(section, /updateTaskDropTarget\(threadId: string, clientY: number\)/);
  assert.match(section, /clearTaskDropTarget\(\)/);
  assert.match(
    active,
    /sectionComponentFor\(\s*drag\.sectionId,?\s*\)[\s\S]*?updateTaskDropTarget/,
  );
  assert.match(active, /sectionComponentFor\(drag\.sectionId\)\?\.clearTaskDropTarget/);
  assert.doesNotMatch(active, /\.matches\("\.task-list"\)/);
  assert.doesNotMatch(active, /inlineIcon\(\s*"Grip",\s*"Reorder Section"/);
  assert.doesNotMatch(active, /addEventListener\("pointer(?:down|move|up|cancel)"/);
  assert.doesNotMatch(active, /function renderTaskRowMeta|function patchTaskListRow/);

  assert.match(row, /inlineIcon\(\s*"Grip"/);
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
  assert.match(section, /inlineIcon\(\s*"Grip",\s*"Reorder Section"/);
  assert.match(section, /const POINTER_DRAG_THRESHOLD_PX = 5/);
  assert.match(section, /event\.isPrimary === false/);
  assert.match(section, /handle\.focus\(\{ preventScroll: true \}\)/);
  assert.match(section, /handle\.setPointerCapture\(event\.pointerId\)/);
  assert.match(section, /"lostpointercapture"/);
  assert.match(section, /handle\.releasePointerCapture\(gesture\.pointerId\)/);
  assert.match(section, /event\.key === "ArrowUp"/);
  assert.match(section, /event\.key === "ArrowDown"/);
  assert.match(section, /!section\.recovery && reorderMode === "none"/);
  assert.doesNotMatch(activeStyles, /section-reorder-handle|task-repository-count/);
  assert.match(rowStyles, /min-height: var\(--task-list-row-height\)/);
  assert.match(rowStyles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("archived task deletion dialog owns its modal state and markup", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const deleteDialog = readFrontend(
    "pages/(task-workspace)/tasks/components/archived-delete-dialog.ts",
  );

  assert.match(
    workspace,
    /<caffold-task-archived-delete-dialog\b[^>]*><\/caffold-task-archived-delete-dialog>/,
  );
  assert.doesNotMatch(workspace, /<dialog|pendingDeleteTask|showModal\(/);
  assert.match(deleteDialog, /<dialog/);
  assert.match(deleteDialog, /pendingThreadId/);
  assert.match(deleteDialog, /dialog\.showModal\(\)/);
  assert.match(deleteDialog, /TASK_ARCHIVED_DELETE_CONFIRMED_EVENT/);
});

test("Codex status, Task-store status, and the Task-store card keep explicit lifecycle and UI owners", () => {
  const workspace = readFrontend("pages/(task-workspace)/layout.ts");
  const owner = readFrontend("pages/(task-workspace)/codex-status.ts");
  const model = readFrontend("pages/(task-workspace)/codex-status/model.ts");
  const lifecycle = readFrontend(
    "pages/(task-workspace)/codex-status/lifecycle.ts",
  );
  const storeOwner = readFrontend("pages/(task-workspace)/task-store-status.ts");
  const storeModel = readFrontend(
    "pages/(task-workspace)/task-store-status/model.ts",
  );
  const storeLifecycle = readFrontend(
    "pages/(task-workspace)/task-store-status/lifecycle.ts",
  );
  const storeRecovery = readFrontend(
    "pages/(task-workspace)/tasks/components/task-store-recovery.ts",
  );
  const restartLifecycle = readFrontend(
    "pages/(task-workspace)/codex-status/runtime-restart-lifecycle.ts",
  );
  const restartDialog = readFrontend(
    "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.ts",
  );
  const updateLifecycle = readFrontend(
    "pages/(task-workspace)/codex-status/runtime-update-lifecycle.ts",
  );
  const updateDialog = readFrontend(
    "pages/(task-workspace)/codex-status/components/runtime-update-dialog.ts",
  );
  const tasks = readFrontend("pages/(task-workspace)/tasks/layout.ts");
  const settings = readFrontend(
    "pages/(task-workspace)/settings/codex/page.ts",
  );

  assert.match(workspace, /from "\.\/codex-status\.js"/);
  assert.match(
    workspace,
    /from "\.\/codex-status\/components\/runtime-restart-dialog\.js"/,
  );
  assert.match(
    workspace,
    /<caffold-codex-runtime-restart-dialog\b[^>]*><\/caffold-codex-runtime-restart-dialog>/,
  );
  assert.match(
    workspace,
    /from "\.\/codex-status\/components\/runtime-update-dialog\.js"/,
  );
  assert.match(
    workspace,
    /<caffold-codex-runtime-update-dialog\b[^>]*><\/caffold-codex-runtime-update-dialog>/,
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
  for (const codexSource of [owner, model, lifecycle]) {
    assert.doesNotMatch(codexSource, /taskStore|TaskStore/);
  }
  assert.match(lifecycle, /class CodexStatusLifecycle/);
  assert.match(workspace, /from "\.\/task-store-status\.js"/);
  assert.match(storeOwner, /from "\.\/task-store-status\/model\.js"/);
  assert.match(storeOwner, /from "\.\/task-store-status\/lifecycle\.js"/);
  assert.match(storeOwner, /function createTaskStoreStatusLifecycle/);
  assert.doesNotMatch(storeOwner, /class TaskStoreStatusLifecycle/);
  assert.doesNotMatch(storeOwner, /export \*/);
  assert.match(storeModel, /function taskStoreBlocksTaskOperations/);
  assert.match(storeModel, /function taskStoreOperationsPresentation/);
  assert.match(storeLifecycle, /class TaskStoreStatusLifecycle/);
  assert.match(storeLifecycle, /TASK_STORE_STATUS_TRANSITIONS/);
  for (const storeSource of [storeOwner, storeModel, storeLifecycle]) {
    assert.doesNotMatch(storeSource, /codex/i);
  }
  assert.match(lifecycle, /new CodexRuntimeRestartLifecycle/);
  assert.match(lifecycle, /new CodexRuntimeUpdateLifecycle/);
  assert.match(restartLifecycle, /class CodexRuntimeRestartLifecycle/);
  assert.match(updateLifecycle, /class CodexRuntimeUpdateLifecycle/);
  assert.match(restartDialog, /<dialog/);
  assert.match(restartDialog, /customElements\.define\(/);
  assert.match(updateDialog, /<dialog/);
  assert.match(updateDialog, /customElements\.define\(/);
  assert.doesNotMatch(tasks, /codex-readiness-card|CODEX_INSTALL_COMMAND/);
  assert.match(tasks, /import "\.\/components\/task-store-recovery\.js"/);
  assert.match(
    tasks,
    /<caffold-task-store-recovery\s+\$\{drawn\(this\.taskStoreRecovery\)\}\s+\?hidden=\$\{!takeover\}/,
  );
  assert.match(storeRecovery, /class CaffoldTaskStoreRecovery/);
  assert.match(storeRecovery, /TASK_STORE_RETRY_REQUEST_EVENT/);
  assert.doesNotMatch(storeRecovery, /codex/i);

  assert.match(settings, /codex-status\.js"/);
  assert.doesNotMatch(settings, /codex-status\//);
  // Tasks treats Codex like any other agent: it reads no Codex status.
  assert.doesNotMatch(tasks, /codex-status/);
  assert.doesNotMatch(settings, /restartCodexRuntime|<dialog|runtime-restart-dialog/);
  assert.doesNotMatch(settings, /updateCodexRuntime|runtime-update-dialog/);

  for (const [path, source] of frontendModules()) {
    const insideOwner =
      path === "pages/(task-workspace)/codex-status.ts" ||
      path.startsWith("pages/(task-workspace)/codex-status/");
    const assetInventory = path === "service-worker.ts";
    if (!insideOwner && !assetInventory) {
      assert.doesNotMatch(
        source,
        /codex-status\/(?!components\/)/,
        `${path} must consume non-visual Codex status behavior through codex-status.ts`,
      );
    }
    const insideStoreOwner =
      path === "pages/(task-workspace)/task-store-status.ts" ||
      path.startsWith("pages/(task-workspace)/task-store-status/");
    if (!insideStoreOwner && !assetInventory) {
      assert.doesNotMatch(
        source,
        /task-store-status\//,
        `${path} must consume Task-store status through task-store-status.ts`,
      );
    }
    if (
      path !== "pages/(task-workspace)/layout.ts" &&
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

test("split panes remember their widths and collapse under one key pair per kind of pane", () => {
  const storageKeys = [
    "pages/(task-workspace)/layout.ts",
    "pages/(task-workspace)/tasks/(detail)/(review)/layout.ts",
    "components/git-compare-browser.ts",
    "pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.ts",
    "pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.ts",
  ].map((path) => {
    const resizers = [...readFrontend(path).matchAll(
      /<caffold-pane-resizer\b[^>]*>/g,
    )].map((match) => match[0]);
    assert.equal(resizers.length, 1, `${path} mounts one remembered pane resizer`);
    return {
      width: resizers[0].match(/\sstorage-key="([^"]+)"/)?.[1],
      collapsed: resizers[0].match(/\scollapsed-storage-key="([^"]+)"/)?.[1],
    };
  });

  assert.deepEqual(storageKeys, [
    "task-workspace",
    "task-review",
    "git-compare",
    "git-log-commit",
    "github-pull-files",
  ].map((kind) => ({
    width: `caffold:pane-width:${kind}`,
    collapsed: `caffold:pane-collapsed:${kind}`,
  })));
});
