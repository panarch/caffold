const CACHE_NAME = "caffold-shell-__CAFFOLD_BUILD_ID__";
const CACHE_PREFIX = "caffold-shell-";
const BUILD_ID = CACHE_NAME.slice(CACHE_PREFIX.length);
const SHELL_NETWORK_TIMEOUT_MS = 3000;
const ACTIVATE_PREPARED_BUILD_MESSAGE = "caffold:activate-prepared-build";
const CLAIM_PREPARED_BUILD_MESSAGE = "caffold:claim-prepared-build";
const GET_BUILD_ID_MESSAGE = "caffold:get-build-id";
const PRUNE_SHELL_CACHES_MESSAGE = "caffold:prune-shell-caches";
const UPDATE_CONTROLLED_MESSAGE = "caffold:update-controlled";
const UPDATE_READY_MESSAGE = "caffold:update-ready";
const NOTIFICATION_ACTIVATION_MESSAGE = "caffold:notification-activation";
// The kind a waiting Task's notice carries; a finished turn's notice carries a
// terminal status and no kind. A notice this worker cannot read is dropped
// rather than shown.
const ACTION_REQUIRED_KIND = "actionRequired";

const APP_SHELL_ASSETS = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/app.js",
  "/assets/build-info.js",
  "/assets/lit/index.js",
  "/assets/lit/directives/keyed.js",
  "/assets/lit/directives/live.js",
  "/assets/lit/directives/repeat.js",
  "/assets/lit/directives/unsafe-html.js",
  "/assets/lit-html/lit-html.js",
  "/assets/lit-html/directive.js",
  "/assets/lit-html/directive-helpers.js",
  "/assets/lit-html/directives/keyed.js",
  "/assets/lit-html/directives/live.js",
  "/assets/lit-html/directives/repeat.js",
  "/assets/lit-html/directives/unsafe-html.js",
  "/assets/lit-html/is-server.js",
  "/assets/lit-element/lit-element.js",
  "/assets/@lit/reactive-element/reactive-element.js",
  "/assets/@lit/reactive-element/css-tag.js",
  "/assets/api.js",
  "/assets/action-hint-scope.js",
  "/assets/component-styles.js",
  "/assets/component-styles/compact-icon-button.css",
  "/assets/component-styles/busy-spin.css",
  "/assets/origin-reachability.js",
  "/assets/file-status.ts",
  "/assets/chunked-fetch.ts",
  "/assets/chunked-fetch/cell-scheduler.ts",
  "/assets/chunked-fetch/in-flight-limit.ts",
  "/assets/chunked-fetch/transfer.ts",
  "/assets/fonts.js",
  "/assets/navigation-routes.js",
  "/assets/settings.js",
  "/assets/theme.js",
  "/assets/fonts/GeistSans-Variable.woff2",
  "/assets/fonts/Inter-Variable.woff2",
  "/assets/fonts/Pretendard-Variable.woff2",
  "/assets/fonts/D2Coding-Regular.woff2",
  "/assets/fonts/D2Coding-Bold.woff2",
  "/assets/fonts/0xProto-Regular.woff2",
  "/assets/fonts/0xProto-Bold.woff2",
  "/assets/fonts/GeistMono-Regular.woff2",
  "/assets/fonts/GeistMono-Bold.woff2",
  "/assets/fonts/IBMPlexMono-Regular.woff2",
  "/assets/fonts/IBMPlexMono-Bold.woff2",
  "/assets/fonts/JetBrainsMono-Regular.woff2",
  "/assets/fonts/JetBrainsMono-Bold.woff2",
  "/assets/fonts/MonaspaceNeon-Regular.woff2",
  "/assets/fonts/MonaspaceNeon-Bold.woff2",
  "/assets/fonts/D2KodingLigatureNerdFontMono-Regular.woff2",
  "/assets/fonts/D2KodingLigatureNerdFontMono-Bold.woff2",
  "/assets/fonts/0xProtoNerdFontMono-Regular.woff2",
  "/assets/fonts/0xProtoNerdFontMono-Bold.woff2",
  "/assets/fonts/GeistMonoNerdFontMono-Regular.woff2",
  "/assets/fonts/GeistMonoNerdFontMono-Bold.woff2",
  "/assets/fonts/BlexMonoNerdFontMono-Regular.woff2",
  "/assets/fonts/BlexMonoNerdFontMono-Bold.woff2",
  "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.woff2",
  "/assets/fonts/JetBrainsMonoNerdFontMono-Bold.woff2",
  "/assets/fonts/MonaspiceNeNerdFontMono-Regular.woff2",
  "/assets/fonts/MonaspiceNeNerdFontMono-Bold.woff2",
  "/assets/icons/caffold.png",
  "/assets/icons/favicon-32.png",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/maskable-192.png",
  "/assets/icons/maskable-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/assets/brand/git-logomark-light.svg",
  "/assets/brand/git-logomark-dark.svg",
  "/assets/brand/github-invertocat-light.svg",
  "/assets/brand/github-invertocat-dark.svg",
  "/assets/brand/codex-template.png",
  "/assets/brand/codex-template@2x.png",
  "/assets/brand/claude-template.png",
  "/assets/brand/grok-template.png",
  "/assets/pages/layout.css",
  "/assets/pages/layout.js",
  "/assets/pages/navigation-history.js",
  "/assets/pages/foreground-recovery.js",
  "/assets/pages/foreground-recovery/browser-signals.js",
  "/assets/pages/foreground-recovery/lifecycle.js",
  "/assets/pages/foreground-recovery/machine.js",
  "/assets/pages/foreground-recovery/diagnostics.js",
  "/assets/pages/pwa-update-lifecycle.js",
  "/assets/pages/pwa-update-lifecycle/machine.js",
  "/assets/pages/pwa-update-lifecycle/runtime.js",
  "/assets/pages/components/build-mismatch-alert.css",
  "/assets/pages/components/build-mismatch-alert.js",
  "/assets/pages/components/update-dialog.css",
  "/assets/pages/components/update-dialog.ts",
  "/assets/pages/components/update-result-dialog.css",
  "/assets/pages/components/update-result-dialog.ts",
  "/assets/components/file-tree.css",
  "/assets/components/file-tree.ts",
  "/assets/components/file-navigator.css",
  "/assets/components/file-navigator.ts",
  "/assets/components/file-navigator/components/list.css",
  "/assets/components/file-navigator/components/list.ts",
  "/assets/components/pane-resizer.css",
  "/assets/components/pane-resizer.ts",
  "/assets/components/review-responsive.ts",
  "/assets/watch.js",
  "/assets/pages/(task-workspace)/settings/appearance/page.css",
  "/assets/pages/(task-workspace)/settings/appearance/page.ts",
  "/assets/pages/(task-workspace)/settings/keyboard/page.css",
  "/assets/pages/(task-workspace)/settings/keyboard/page.ts",
  "/assets/pages/(task-workspace)/settings/files/page.css",
  "/assets/pages/(task-workspace)/settings/files/page.ts",
  "/assets/pages/(task-workspace)/settings/notifications/page.css",
  "/assets/pages/(task-workspace)/settings/notifications/page.ts",
  "/assets/pages/(task-workspace)/settings/notifications/lifecycle.ts",
  "/assets/pages/(task-workspace)/settings/remote-access/page.css",
  "/assets/pages/(task-workspace)/settings/remote-access/page.ts",
  "/assets/pages/(task-workspace)/settings/remote-access/tailscale.ts",
  "/assets/pages/(task-workspace)/settings/voice/page.css",
  "/assets/pages/(task-workspace)/settings/voice/page.ts",
  "/assets/pages/(task-workspace)/settings/voice/lifecycle.ts",
  "/assets/pages/(task-workspace)/settings/jev/page.css",
  "/assets/pages/(task-workspace)/settings/jev/page.ts",
  "/assets/pages/(task-workspace)/settings/jev/lifecycle.ts",
  "/assets/pages/(task-workspace)/layout.css",
  "/assets/pages/(task-workspace)/layout.js",
  "/assets/keyboard-navigation.js",
  "/assets/scroll-scope.js",
  "/assets/keyboard-navigation/control.js",
  "/assets/keyboard-navigation/context.js",
  "/assets/keyboard-navigation/model.js",
  "/assets/keyboard-navigation/shortcuts.js",
  "/assets/keyboard-navigation/components/hud.css",
  "/assets/keyboard-navigation/components/hud.js",
  "/assets/keyboard-navigation/components/selector.css",
  "/assets/keyboard-navigation/components/selector.js",
  "/assets/keyboard-navigation/components/presentation.css",
  "/assets/keyboard-navigation/components/presentation.js",
  "/assets/keyboard-navigation/components/shortcut-list.css",
  "/assets/keyboard-navigation/components/shortcut-list.js",
  "/assets/keyboard-navigation/components/shortcut-dialog.css",
  "/assets/keyboard-navigation/components/shortcut-dialog.js",
  "/assets/action-hints.js",
  "/assets/action-hints/control.js",
  "/assets/action-hints/model.js",
  "/assets/action-hints/components/dialog.css",
  "/assets/action-hints/components/dialog.js",
  "/assets/pages/(task-workspace)/live-updates.js",
  "/assets/pages/(task-workspace)/live-updates/lifecycle.js",
  "/assets/pages/(task-workspace)/components/navigation.css",
  "/assets/pages/(task-workspace)/components/navigation.js",
  "/assets/pages/(task-workspace)/components/update-task-dialog.css",
  "/assets/pages/(task-workspace)/components/update-task-dialog.js",
  "/assets/pages/(task-workspace)/components/workspace-brand.css",
  "/assets/pages/(task-workspace)/components/workspace-brand.ts",
  "/assets/pages/(task-workspace)/codex-status.js",
  "/assets/pages/(task-workspace)/codex-status/model.js",
  "/assets/pages/(task-workspace)/codex-status/lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/runtime-update-lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.ts",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-update-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-update-dialog.ts",
  "/assets/pages/(task-workspace)/codex-status/components/reset-credit-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/reset-credit-dialog.ts",
  "/assets/pages/(task-workspace)/task-store-status.js",
  "/assets/pages/(task-workspace)/task-store-status/model.js",
  "/assets/pages/(task-workspace)/task-store-status/lifecycle.js",
  "/assets/pages/(task-workspace)/notes/components/document.css",
  "/assets/pages/(task-workspace)/notes/components/document.ts",
  "/assets/pages/(task-workspace)/notes/components/info.css",
  "/assets/pages/(task-workspace)/notes/components/info.ts",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-markdown.css",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-markdown.ts",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-path.css",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-path.ts",
  "/assets/pages/(task-workspace)/notes/components/navigator.css",
  "/assets/pages/(task-workspace)/notes/components/navigator.ts",
  "/assets/pages/(task-workspace)/notes/layout.css",
  "/assets/pages/(task-workspace)/notes/layout.ts",
  "/assets/pages/(task-workspace)/notes/layout/selection.ts",
  "/assets/pages/(task-workspace)/notes/tree.ts",
  "/assets/pages/(task-workspace)/settings/layout.css",
  "/assets/pages/(task-workspace)/settings/layout.ts",
  "/assets/pages/(task-workspace)/settings/components/navigator.css",
  "/assets/pages/(task-workspace)/settings/components/navigator.ts",
  "/assets/pages/(task-workspace)/settings/components/navigator/components/item.css",
  "/assets/pages/(task-workspace)/settings/components/navigator/components/item.ts",
  "/assets/pages/(task-workspace)/settings/service-status.ts",
  "/assets/pages/(task-workspace)/settings/components/detail-list.css",
  "/assets/pages/(task-workspace)/settings/components/detail-list.ts",
  "/assets/pages/(task-workspace)/settings/components/refresh-button.css",
  "/assets/pages/(task-workspace)/settings/components/refresh-button.ts",
  "/assets/pages/(task-workspace)/settings/codex/page.css",
  "/assets/pages/(task-workspace)/settings/codex/page.ts",
  "/assets/pages/(task-workspace)/settings/claude/page.css",
  "/assets/pages/(task-workspace)/settings/claude/page.ts",
  "/assets/pages/(task-workspace)/settings/claude/display.ts",
  "/assets/pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.css",
  "/assets/pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.ts",
  "/assets/pages/(task-workspace)/settings/grok/page.css",
  "/assets/pages/(task-workspace)/settings/grok/page.ts",
  "/assets/pages/(task-workspace)/settings/grok/display.ts",
  "/assets/pages/(task-workspace)/settings/about/page.css",
  "/assets/pages/(task-workspace)/settings/about/page.ts",
  "/assets/pages/(task-workspace)/tasks/controls.css",
  "/assets/pages/(task-workspace)/tasks/layout.css",
  "/assets/pages/(task-workspace)/tasks/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/summary.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/summary.ts",
  "/assets/pages/(task-workspace)/tasks/runtime-state.js",
  "/assets/pages/(task-workspace)/tasks/stream.js",
  "/assets/pages/(task-workspace)/tasks/stream/machine.js",
  "/assets/pages/(task-workspace)/tasks/task-events.js",
  "/assets/pages/(task-workspace)/tasks/task-format.js",
  "/assets/pages/(task-workspace)/tasks/task-list-model.js",
  "/assets/pages/(task-workspace)/tasks/components/composer.css",
  "/assets/pages/(task-workspace)/tasks/components/composer.ts",
  "/assets/pages/(task-workspace)/tasks/components/composer/action-hints.ts",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/attachments.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/attachments.ts",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/context-usage.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/context-usage.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.css",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field.css",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field/control.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-create/directory-path.ts",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-switcher-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/task-switcher-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/voice-level-meter.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/voice-level-meter.ts",
  "/assets/pages/(task-workspace)/tasks/components/composer/voice-recorder.ts",
  "/assets/pages/(task-workspace)/tasks/components/composer/voice-worklet.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/session.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/conversation.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/history.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/prompt-attachments.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/prompt-submission.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/upload-discards.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/model.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/git-menu.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/git-menu.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/github-menu.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/github-menu.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/terminal-button.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/terminal-button.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/older-history.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/older-history.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/active-turn.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/copy-button.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/copy-button.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/suggested-prompts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/suggested-prompts.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/message-attachments.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/message-attachments.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/user-message.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/user-message.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/approval.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/approval.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command/model.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group/model.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/command-runs.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/broken-delete-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/broken-delete-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/permission-instructions-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/permission-instructions-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/entries.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout/paths.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout/route.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/changes-reading.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/representations.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file/content.ts",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.ts",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/move-list-item.ts",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section.ts",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.ts",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.ts",
  "/assets/pages/(task-workspace)/tasks/recovery/page.css",
  "/assets/pages/(task-workspace)/tasks/recovery/page.js",
  "/assets/pages/(task-workspace)/tasks/components/task-store-recovery.css",
  "/assets/pages/(task-workspace)/tasks/components/task-store-recovery.js",
  "/assets/pages/(task-workspace)/tasks/components/task-absence.css",
  "/assets/pages/(task-workspace)/tasks/components/task-absence.ts",
  "/assets/pages/(task-workspace)/tasks/components/navigator.css",
  "/assets/pages/(task-workspace)/tasks/components/navigator.ts",
  "/assets/pages/(task-workspace)/tasks/components/task-create.css",
  "/assets/pages/(task-workspace)/tasks/components/task-create.ts",
  "/assets/pages/(task-workspace)/tasks/new/page.css",
  "/assets/pages/(task-workspace)/tasks/new/page.js",
  "/assets/pages/(task-workspace)/tasks/components/task-status-chip.css",
  "/assets/pages/(task-workspace)/tasks/components/task-status-chip.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/components/controls.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/components/controls.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/compare/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/compare/page.ts",
  "/assets/components/git-compare-browser.css",
  "/assets/components/git-compare-browser.ts",
  "/assets/components/git-compare-tree.css",
  "/assets/components/git-compare-tree.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/connection.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/keyboard-inset.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/keys.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/model.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/components/special-keys.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/components/special-keys.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/markdown.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.ts",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.ts",
  "/assets/components/file-viewer/components/code-viewer.css",
  "/assets/components/file-viewer/components/code-viewer.ts",
  "/assets/components/file-viewer/components/diff-viewer.css",
  "/assets/components/file-viewer/components/diff-viewer.ts",
  "/assets/components/file-viewer/syntax-spans.ts",
  "/assets/components/dom.ts",
  "/assets/components/file-viewer.css",
  "/assets/components/file-viewer.ts",
  "/assets/components/markdown-preview.css",
  "/assets/components/markdown-preview.ts",
  "/assets/components/pdf-viewer.css",
  "/assets/components/pdf-viewer.ts",
  "/assets/components/docx-viewer.css",
  "/assets/components/docx-viewer.ts",
  "/assets/components/pptx-viewer.css",
  "/assets/components/pptx-viewer.ts",
  "/assets/components/xlsx-viewer.css",
  "/assets/components/xlsx-viewer.ts",
  "/assets/components/xlsx-viewer/window.ts",
  "/assets/components/xlsx-viewer/workbook.ts",
  "/assets/components/file-viewer-presentation.ts",
  "/assets/components/icons.ts",
  "/assets/components/loading-text.css",
  "/assets/components/loading-text.ts",
  "/assets/components/pagination.css",
  "/assets/components/pagination.ts",
  "/assets/components/pagination/components/button.css",
  "/assets/components/pagination/components/button.ts",
  "/assets/components/segmented-control.css",
  "/assets/components/segmented-control.ts",
  "/assets/components/terminal-view.css",
  "/assets/components/terminal-view.ts",
];

const APP_SHELL_ASSET_PATHS = new Set(APP_SHELL_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activatePreparedShell());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === PRUNE_SHELL_CACHES_MESSAGE) {
    event.waitUntil(pruneShellCachesWhenUnused(event.data.cacheNames));
    return;
  }
  if (event.data?.type === GET_BUILD_ID_MESSAGE) {
    event.source?.postMessage(updateReadyMessage());
    return;
  }
  if (event.data?.type === ACTIVATE_PREPARED_BUILD_MESSAGE) {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type === CLAIM_PREPARED_BUILD_MESSAGE) {
    event.waitUntil(claimPreparedBuild(event.source));
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(showTaskNotification(event.data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification?.close();
  event.waitUntil(openNotificationRoute(event.notification?.data?.route));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  if (
    url.pathname === "/" ||
    url.pathname === "/notes" ||
    url.pathname.startsWith("/notes/") ||
    url.pathname === "/settings" ||
    url.pathname.startsWith("/settings/") ||
    url.pathname === "/tasks" ||
    url.pathname.startsWith("/tasks/")
  ) {
    event.respondWith(activeShellFirst(request, "/"));
    return;
  }

  if (APP_SHELL_ASSET_PATHS.has(url.pathname)) {
    event.respondWith(activeShellFirst(request, url.pathname));
  }
});

// Fills this build's cache. A file an earlier build's cache holds is asked
// about by its tag, and that copy goes in when the server says it is
// unchanged, so an update downloads only what changed even when the browser
// no longer keeps its own copies. Each answer is stored as it arrives, since
// unread bodies hold their connections and would leave later requests waiting.
// A file that cannot be fetched discards the cache, leaving nothing half made.
async function installShell() {
  const cache = await caches.open(CACHE_NAME);
  const previousCaches = await Promise.all(
    (await caches.keys())
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .reverse()
      .map((key) => caches.open(key)),
  );
  try {
    await Promise.all(
      APP_SHELL_ASSETS.map(async (path) => {
        await cache.put(path, await shellAssetResponse(path, previousCaches));
      }),
    );
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function shellAssetResponse(path, previousCaches) {
  let previous = null;
  for (const previousCache of previousCaches) {
    const copy = await previousCache.match(path);
    if (copy?.headers.get("ETag")) {
      previous = copy;
      break;
    }
  }
  const response = previous
    ? await fetch(path, {
        cache: "no-store",
        headers: { "If-None-Match": previous.headers.get("ETag") },
      })
    : await fetch(path);
  if (previous && response.status === 304) {
    return previous;
  }
  if (!response.ok) {
    throw new Error(`The app shell could not fetch ${path}: ${response.status}`);
  }
  return response;
}

async function activeShellFirst(request, cachePath) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cachePath, { ignoreSearch: true });
  if (cached) {
    return cached;
  }

  try {
    return await fetchWithTimeout(request);
  } catch {
    return new Response("Caffold app shell is unavailable.", {
      status: 504,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHELL_NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function pruneShellCachesWhenUnused(cacheNames) {
  const [controlledClients, allClients] = await Promise.all([
    self.clients.matchAll({ type: "window" }),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }),
  ]);
  const controlledIds = new Set(controlledClients.map((client) => client.id));
  if (allClients.some((client) => !controlledIds.has(client.id))) {
    return;
  }

  await Promise.all(
    (Array.isArray(cacheNames) ? cacheNames : [])
      .filter(
        (key) =>
          typeof key === "string" &&
          key.startsWith(CACHE_PREFIX) &&
          key !== CACHE_NAME,
      )
      .map((key) => caches.delete(key)),
  );
}

async function activatePreparedShell() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage(updateReadyMessage());
  }
}

function updateReadyMessage() {
  return { type: UPDATE_READY_MESSAGE, buildId: BUILD_ID };
}

async function claimPreparedBuild(client) {
  await self.clients.claim();
  client?.postMessage({ type: UPDATE_CONTROLLED_MESSAGE, buildId: BUILD_ID });
}

async function showTaskNotification(data) {
  let payload;
  try {
    payload = data?.json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const notice = payload.kind === ACTION_REQUIRED_KIND
    ? readActionRequiredPayload(payload)
    : readTerminalPayload(payload);
  if (!notice) {
    return;
  }
  const route = taskRoute(notice.threadId);
  if (!route) {
    return;
  }
  await self.registration.showNotification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/favicon-32.png",
    data: { route, threadId: notice.threadId },
  });
}

function readTerminalPayload(payload) {
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
  const taskName = safeTaskName(payload.taskName);
  const tag = typeof payload.tag === "string" ? payload.tag : "";
  if (
    !safeTaskId(threadId) ||
    !safeTaskId(turnId) ||
    !["completed", "failed", "interrupted"].includes(payload.status) ||
    !safeNotificationTag(tag) ||
    taskName === null
  ) {
    return null;
  }
  const status = terminalStatusCopy(payload.status);
  return {
    threadId,
    tag,
    title: taskName || "Caffold",
    body: taskName ? status : `Task ${status.toLowerCase()}`,
  };
}

// A Task stopped for a person. Which question it stopped on is not sent, so
// the copy says only that one is waiting.
function readActionRequiredPayload(payload) {
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const taskName = safeTaskName(payload.taskName);
  const tag = typeof payload.tag === "string" ? payload.tag : "";
  if (!safeTaskId(threadId) || !safeNotificationTag(tag) || taskName === null) {
    return null;
  }
  return {
    threadId,
    tag,
    title: taskName || "Caffold",
    body: "Approval required",
  };
}

function safeNotificationTag(tag) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tag);
}

// The bounded name, "" when the notice carries none, and null when it carries
// one that no notification should show.
function safeTaskName(taskName) {
  if (typeof taskName !== "string" || !taskName.trim()) {
    return "";
  }
  const name = [...taskName.trim()].slice(0, 120).join("");
  return [...name].some((character) => isControlCharacter(character)) ? null : name;
}

// An open window is focused and told which route to apply, because loading the
// route into that window would discard the workspace state it still holds.
async function openNotificationRoute(route) {
  const safeRoute = safeNotificationRoute(route);
  if (!safeRoute) {
    return;
  }
  for (const client of await notificationTargets(safeRoute)) {
    try {
      await client.focus();
      client.postMessage({
        type: NOTIFICATION_ACTIVATION_MESSAGE,
        route: safeRoute,
      });
      return;
    } catch {
      // The client may have closed between enumeration and focus.
    }
  }
  try {
    await self.clients.openWindow(safeRoute);
  } catch {
    // Notification navigation is best-effort.
  }
}

// Caffold windows, the one already showing the Task first.
async function notificationTargets(route) {
  const windows = (await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  })).filter((client) => sameOriginClient(client.url));
  return [
    ...windows.filter((client) => clientShowsTask(client.url, route)),
    ...windows.filter((client) => !clientShowsTask(client.url, route)),
  ];
}

function safeNotificationRoute(route) {
  if (typeof route !== "string") {
    return "";
  }
  let url;
  try {
    url = new URL(route, self.location.origin);
  } catch {
    return "";
  }
  if (url.origin !== self.location.origin || url.search || url.hash) {
    return "";
  }
  const match = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (!match) {
    return "";
  }
  let threadId;
  try {
    threadId = decodeURIComponent(match[1]);
  } catch {
    return "";
  }
  return taskRoute(threadId);
}

function taskRoute(threadId) {
  return safeTaskId(threadId) ? `/tasks/${encodeURIComponent(threadId)}` : "";
}

function safeTaskId(value) {
  if (typeof value !== "string") {
    return false;
  }
  const characters = [...value];
  return characters.length > 0 &&
    characters.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !characters.some((character) => isControlCharacter(character));
}

function isControlCharacter(character) {
  const code = character.codePointAt(0);
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function terminalStatusCopy(status) {
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Completed";
}

function clientShowsTask(clientUrl, route) {
  try {
    const url = new URL(clientUrl);
    return url.origin === self.location.origin &&
      (url.pathname === route || url.pathname.startsWith(`${route}/`));
  } catch {
    return false;
  }
}

function sameOriginClient(clientUrl) {
  try {
    return new URL(clientUrl).origin === self.location.origin;
  } catch {
    return false;
  }
}
