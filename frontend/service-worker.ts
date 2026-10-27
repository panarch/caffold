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
  "/assets/lit/async-directive.js",
  "/assets/lit/decorators.js",
  "/assets/lit/directives/keyed.js",
  "/assets/lit/directives/live.js",
  "/assets/lit/directives/repeat.js",
  "/assets/lit/directives/unsafe-html.js",
  "/assets/lit-html/lit-html.js",
  "/assets/lit-html/async-directive.js",
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
  "/assets/@lit/reactive-element/decorators/base.js",
  "/assets/@lit/reactive-element/decorators/custom-element.js",
  "/assets/@lit/reactive-element/decorators/event-options.js",
  "/assets/@lit/reactive-element/decorators/property.js",
  "/assets/@lit/reactive-element/decorators/query-all.js",
  "/assets/@lit/reactive-element/decorators/query-assigned-elements.js",
  "/assets/@lit/reactive-element/decorators/query-assigned-nodes.js",
  "/assets/@lit/reactive-element/decorators/query-async.js",
  "/assets/@lit/reactive-element/decorators/query.js",
  "/assets/@lit/reactive-element/decorators/state.js",
  "/assets/tslib/tslib.es6.mjs",
  "/assets/api.js",
  "/assets/action-hint-scope.js",
  "/assets/element-declarations.js",
  "/assets/shadow-roots.js",
  "/assets/caffold-element.js",
  "/assets/caffold-element/base.css",
  "/assets/caffold-element/base.css.js",
  "/assets/component-styles.js",
  "/assets/component-styles/compact-icon-button.css",
  "/assets/component-styles/compact-icon-button.css.js",
  "/assets/component-styles/secondary-button.css.js",
  "/assets/component-styles/busy-spin.css",
  "/assets/origin-reachability.js",
  "/assets/file-status.js",
  "/assets/chunked-fetch.js",
  "/assets/chunked-fetch/cell-scheduler.js",
  "/assets/chunked-fetch/in-flight-limit.js",
  "/assets/chunked-fetch/transfer.js",
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
  "/assets/pages/components/update-dialog.js",
  "/assets/pages/components/update-result-dialog.css",
  "/assets/pages/components/update-result-dialog.js",
  "/assets/components/file-tree.css.js",
  "/assets/components/file-tree.js",
  "/assets/components/file-navigator.css.js",
  "/assets/components/file-navigator.js",
  "/assets/components/file-navigator/components/list.css.js",
  "/assets/components/file-navigator/components/list.js",
  "/assets/components/pane-resizer.css.js",
  "/assets/components/pane-resizer.js",
  "/assets/components/review-responsive.js",
  "/assets/watch.js",
  "/assets/pages/(task-workspace)/settings/appearance/page.css",
  "/assets/pages/(task-workspace)/settings/appearance/page.js",
  "/assets/pages/(task-workspace)/settings/keyboard/page.css",
  "/assets/pages/(task-workspace)/settings/keyboard/page.js",
  "/assets/pages/(task-workspace)/settings/files/page.css",
  "/assets/pages/(task-workspace)/settings/files/page.js",
  "/assets/pages/(task-workspace)/settings/notifications/page.css",
  "/assets/pages/(task-workspace)/settings/notifications/page.js",
  "/assets/pages/(task-workspace)/settings/notifications/lifecycle.js",
  "/assets/pages/(task-workspace)/settings/remote-access/page.css",
  "/assets/pages/(task-workspace)/settings/remote-access/page.js",
  "/assets/pages/(task-workspace)/settings/remote-access/tailscale.js",
  "/assets/pages/(task-workspace)/settings/voice/page.css",
  "/assets/pages/(task-workspace)/settings/voice/page.js",
  "/assets/pages/(task-workspace)/settings/voice/lifecycle.js",
  "/assets/pages/(task-workspace)/settings/jev/page.css",
  "/assets/pages/(task-workspace)/settings/jev/page.js",
  "/assets/pages/(task-workspace)/settings/jev/lifecycle.js",
  "/assets/pages/(task-workspace)/layout.css",
  "/assets/pages/(task-workspace)/layout.js",
  "/assets/pages/(task-workspace)/task-create-intent-event.js",
  "/assets/keyboard-navigation.js",
  "/assets/scroll-scope.js",
  "/assets/keyboard-navigation/control.js",
  "/assets/keyboard-navigation/context.js",
  "/assets/keyboard-navigation/model.js",
  "/assets/keyboard-navigation/shortcuts.js",
  "/assets/keyboard-navigation/components/hud.css.js",
  "/assets/keyboard-navigation/components/hud.js",
  "/assets/keyboard-navigation/components/selector.css.js",
  "/assets/keyboard-navigation/components/selector.js",
  "/assets/keyboard-navigation/components/presentation.css.js",
  "/assets/keyboard-navigation/components/presentation.js",
  "/assets/keyboard-navigation/components/shortcut-list.css.js",
  "/assets/keyboard-navigation/components/shortcut-list.js",
  "/assets/keyboard-navigation/components/shortcut-dialog.css.js",
  "/assets/keyboard-navigation/components/shortcut-dialog.js",
  "/assets/action-hints.js",
  "/assets/action-hints/control.js",
  "/assets/action-hints/declarations.js",
  "/assets/action-hints/model.js",
  "/assets/action-hints/components/dialog.css.js",
  "/assets/action-hints/components/dialog.js",
  "/assets/pages/(task-workspace)/live-updates.js",
  "/assets/pages/(task-workspace)/live-updates/lifecycle.js",
  "/assets/pages/(task-workspace)/components/navigation.css",
  "/assets/pages/(task-workspace)/components/navigation.js",
  "/assets/pages/(task-workspace)/components/update-task-dialog.css",
  "/assets/pages/(task-workspace)/components/update-task-dialog.js",
  "/assets/pages/(task-workspace)/components/workspace-brand.css",
  "/assets/pages/(task-workspace)/components/workspace-brand.js",
  "/assets/pages/(task-workspace)/codex-status.js",
  "/assets/pages/(task-workspace)/codex-status/model.js",
  "/assets/pages/(task-workspace)/codex-status/lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/runtime-update-lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-update-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-update-dialog.js",
  "/assets/pages/(task-workspace)/codex-status/components/reset-credit-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/reset-credit-dialog.js",
  "/assets/pages/(task-workspace)/task-store-status.js",
  "/assets/pages/(task-workspace)/task-store-status/model.js",
  "/assets/pages/(task-workspace)/task-store-status/lifecycle.js",
  "/assets/pages/(task-workspace)/notes/components/document.css",
  "/assets/pages/(task-workspace)/notes/components/document.js",
  "/assets/pages/(task-workspace)/notes/components/info.css",
  "/assets/pages/(task-workspace)/notes/components/info.js",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-markdown.css",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-markdown.js",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-path.css",
  "/assets/pages/(task-workspace)/notes/components/info/components/copy-path.js",
  "/assets/pages/(task-workspace)/notes/components/navigator.css",
  "/assets/pages/(task-workspace)/notes/components/navigator.js",
  "/assets/pages/(task-workspace)/notes/layout.css",
  "/assets/pages/(task-workspace)/notes/layout.js",
  "/assets/pages/(task-workspace)/notes/layout/selection.js",
  "/assets/pages/(task-workspace)/notes/tree.js",
  "/assets/pages/(task-workspace)/settings/layout.css",
  "/assets/pages/(task-workspace)/settings/layout.js",
  "/assets/pages/(task-workspace)/settings/components/navigator.css",
  "/assets/pages/(task-workspace)/settings/components/navigator.js",
  "/assets/pages/(task-workspace)/settings/components/navigator/components/item.css",
  "/assets/pages/(task-workspace)/settings/components/navigator/components/item.js",
  "/assets/pages/(task-workspace)/settings/components/detail-list.css",
  "/assets/pages/(task-workspace)/settings/components/detail-list.js",
  "/assets/pages/(task-workspace)/settings/components/refresh-button.css",
  "/assets/pages/(task-workspace)/settings/components/refresh-button.js",
  "/assets/pages/(task-workspace)/settings/codex/page.css",
  "/assets/pages/(task-workspace)/settings/codex/page.js",
  "/assets/pages/(task-workspace)/settings/claude/page.css",
  "/assets/pages/(task-workspace)/settings/claude/page.js",
  "/assets/pages/(task-workspace)/settings/claude/display.js",
  "/assets/pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.css",
  "/assets/pages/(task-workspace)/settings/claude/components/runtime-restart-dialog.js",
  "/assets/pages/(task-workspace)/settings/grok/page.css",
  "/assets/pages/(task-workspace)/settings/grok/page.js",
  "/assets/pages/(task-workspace)/settings/grok/display.js",
  "/assets/pages/(task-workspace)/settings/about/page.css",
  "/assets/pages/(task-workspace)/settings/about/page.js",
  "/assets/pages/(task-workspace)/tasks/controls.css",
  "/assets/pages/(task-workspace)/tasks/layout.css",
  "/assets/pages/(task-workspace)/tasks/layout.js",
  "/assets/pages/(task-workspace)/tasks/task-navigator-intent-event.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/task-detail-intent-event.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/task-detail-transport-change-event.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/github-shortcuts.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/summary.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(section)/components/summary.js",
  "/assets/pages/(task-workspace)/tasks/runtime-state.js",
  "/assets/pages/(task-workspace)/tasks/stream.js",
  "/assets/pages/(task-workspace)/tasks/stream/machine.js",
  "/assets/pages/(task-workspace)/tasks/task-events.js",
  "/assets/pages/(task-workspace)/tasks/task-format.js",
  "/assets/pages/(task-workspace)/tasks/task-list-model.js",
  "/assets/pages/(task-workspace)/tasks/components/composer.css",
  "/assets/pages/(task-workspace)/tasks/components/composer.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/attachments.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/attachments.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/context-usage.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/context-usage.js",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.css",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.js",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field.css",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field.js",
  "/assets/pages/(task-workspace)/tasks/components/task-create/components/directory-field/control.js",
  "/assets/pages/(task-workspace)/tasks/components/task-create/directory-path.js",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/task-switcher-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/task-switcher-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/voice-level-meter.css",
  "/assets/pages/(task-workspace)/tasks/components/composer/components/voice-level-meter.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/voice-recorder.js",
  "/assets/pages/(task-workspace)/tasks/components/composer/voice-worklet.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/session.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/conversation.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/history.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/prompt-attachments.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/prompt-submission.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/layout/upload-discards.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/model.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/current-plan/components/document-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/git-menu.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/git-menu.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/github-menu.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/github-menu.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/terminal-button.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/components/terminal-button.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/summary/components/info/components/actions.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/older-history.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/older-history.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/active-turn.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/active-turn.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/copy-button.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/copy-button.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/suggested-prompts.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/assistant-message/components/suggested-prompts.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/message-attachments.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/message-attachments.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/user-message.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/user-message.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/changed-files.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/approval.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/approval.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command/model.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/command-group/model.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/command-runs.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/broken-delete-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/broken-delete-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/command-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/permission-instructions-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/markdown-preview-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/permission-instructions-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/markdown/components/code-block.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/entries.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(task)/components/conversation/components/work-details.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout/paths.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/layout/route.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/changes-reading.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/representations.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/working-tree-changes/components/changes-tree.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/branch-changes.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(review)/components/selected-file/content.js",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.js",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/move-list-item.js",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section.js",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list/components/section/components/row.js",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.js",
  "/assets/pages/(task-workspace)/tasks/recovery/page.css",
  "/assets/pages/(task-workspace)/tasks/recovery/page.js",
  "/assets/pages/(task-workspace)/tasks/components/task-store-recovery.css",
  "/assets/pages/(task-workspace)/tasks/components/task-store-recovery.js",
  "/assets/pages/(task-workspace)/tasks/components/task-absence.css",
  "/assets/pages/(task-workspace)/tasks/components/task-absence.js",
  "/assets/pages/(task-workspace)/tasks/components/navigator.css",
  "/assets/pages/(task-workspace)/tasks/components/navigator.js",
  "/assets/pages/(task-workspace)/tasks/components/task-create.css",
  "/assets/pages/(task-workspace)/tasks/components/task-create.js",
  "/assets/pages/(task-workspace)/tasks/new/page.css",
  "/assets/pages/(task-workspace)/tasks/new/page.js",
  "/assets/pages/(task-workspace)/tasks/components/task-status-chip.css",
  "/assets/pages/(task-workspace)/tasks/components/task-status-chip.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/components/controls.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/components/controls.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/(log)/commit/components/changes-tree.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/compare/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(git)/compare/page.js",
  "/assets/components/git-compare-browser.css.js",
  "/assets/components/git-compare-browser.js",
  "/assets/components/git-compare-tree.css.js",
  "/assets/components/git-compare-tree.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/connection.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/keyboard-inset.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/keys.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/page/model.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/components/special-keys.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/terminal/components/special-keys.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/markdown.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-issue.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/components/task-start-dialog/components/github-pull.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(issues)/detail/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/layout.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/detail/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/page.js",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.css",
  "/assets/pages/(task-workspace)/tasks/(detail)/(github)/(pulls)/files/components/tree.js",
  "/assets/components/file-viewer/components/code-viewer.css.js",
  "/assets/components/file-viewer/components/code-viewer.js",
  "/assets/components/file-viewer/components/diff-viewer.css.js",
  "/assets/components/file-viewer/components/diff-viewer.js",
  "/assets/components/file-viewer/syntax-spans.js",
  "/assets/components/dom.js",
  "/assets/components/file-viewer.css.js",
  "/assets/components/file-viewer.js",
  "/assets/components/markdown-preview.css.js",
  "/assets/components/markdown-preview.js",
  "/assets/components/pdf-viewer.css.js",
  "/assets/components/pdf-viewer.js",
  "/assets/components/docx-viewer.css.js",
  "/assets/components/docx-viewer.js",
  "/assets/components/pptx-viewer.css.js",
  "/assets/components/pptx-viewer.js",
  "/assets/components/xlsx-viewer.css.js",
  "/assets/components/xlsx-viewer.js",
  "/assets/components/xlsx-viewer/window.js",
  "/assets/components/xlsx-viewer/workbook.js",
  "/assets/components/file-viewer-presentation.js",
  "/assets/components/icons.js",
  "/assets/components/drawn-refs.js",
  "/assets/components/loading-text.css.js",
  "/assets/components/loading-text.js",
  "/assets/components/pagination.css.js",
  "/assets/components/pagination.js",
  "/assets/components/pagination/components/button.css.js",
  "/assets/components/pagination/components/button.js",
  "/assets/components/segmented-control.css.js",
  "/assets/components/segmented-control.js",
  "/assets/components/terminal-view.css.js",
  "/assets/components/terminal-view.js",
];

const APP_SHELL_ASSET_PATHS = new Set(APP_SHELL_ASSETS);

// This is a classic script, where TypeScript types `self` as a plain worker.
const worker = self as unknown as ServiceWorkerGlobalScope;

type NoticePayload = Record<string, unknown>;

worker.addEventListener("install", (event) => {
  event.waitUntil(installShell());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(activatePreparedShell());
});

worker.addEventListener("message", (event) => {
  if (event.data?.type === PRUNE_SHELL_CACHES_MESSAGE) {
    event.waitUntil(pruneShellCachesWhenUnused(event.data.cacheNames));
    return;
  }
  if (event.data?.type === GET_BUILD_ID_MESSAGE) {
    event.source?.postMessage(updateReadyMessage());
    return;
  }
  if (event.data?.type === ACTIVATE_PREPARED_BUILD_MESSAGE) {
    event.waitUntil(worker.skipWaiting());
    return;
  }
  if (event.data?.type === CLAIM_PREPARED_BUILD_MESSAGE) {
    event.waitUntil(claimPreparedBuild(event.source));
  }
});

worker.addEventListener("push", (event) => {
  event.waitUntil(showTaskNotification(event.data));
});

worker.addEventListener("notificationclick", (event) => {
  event.notification?.close();
  event.waitUntil(openNotificationRoute(event.notification?.data?.route));
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (
    url.origin !== worker.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
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
async function installShell(): Promise<void> {
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

async function shellAssetResponse(
  path: string,
  previousCaches: Cache[],
): Promise<Response> {
  let previous: Response | undefined;
  let previousTag = "";
  for (const previousCache of previousCaches) {
    const copy = await previousCache.match(path);
    const tag = copy?.headers.get("ETag");
    if (copy && tag) {
      previous = copy;
      previousTag = tag;
      break;
    }
  }
  const response = previous
    ? await fetch(path, {
        cache: "no-store",
        headers: { "If-None-Match": previousTag },
      })
    : await fetch(path);
  if (previous && response.status === 304) {
    return previous;
  }
  if (!response.ok) {
    throw new Error(
      `The app shell could not fetch ${path}: ${response.status}`,
    );
  }
  return response;
}

async function activeShellFirst(
  request: Request,
  cachePath: string,
): Promise<Response> {
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

async function fetchWithTimeout(request: Request): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SHELL_NETWORK_TIMEOUT_MS,
  );
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function pruneShellCachesWhenUnused(cacheNames: unknown): Promise<void> {
  const [controlledClients, allClients] = await Promise.all([
    worker.clients.matchAll({ type: "window" }),
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }),
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

async function activatePreparedShell(): Promise<void> {
  const clients = await worker.clients.matchAll({
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

async function claimPreparedBuild(
  client: ExtendableMessageEvent["source"],
): Promise<void> {
  await worker.clients.claim();
  client?.postMessage({ type: UPDATE_CONTROLLED_MESSAGE, buildId: BUILD_ID });
}

async function showTaskNotification(
  data: PushMessageData | null,
): Promise<void> {
  let payload: NoticePayload | undefined;
  try {
    payload = data?.json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const notice =
    payload.kind === ACTION_REQUIRED_KIND
      ? readActionRequiredPayload(payload)
      : readTerminalPayload(payload);
  if (!notice) {
    return;
  }
  const route = taskRoute(notice.threadId);
  if (!route) {
    return;
  }
  await worker.registration.showNotification(notice.title, {
    body: notice.body,
    tag: notice.tag,
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/favicon-32.png",
    data: { route, threadId: notice.threadId },
  });
}

function readTerminalPayload(payload: NoticePayload) {
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
  const taskName = safeTaskName(payload.taskName);
  const tag = typeof payload.tag === "string" ? payload.tag : "";
  if (
    !safeTaskId(threadId) ||
    !safeTaskId(turnId) ||
    typeof payload.status !== "string" ||
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
function readActionRequiredPayload(payload: NoticePayload) {
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

function safeNotificationTag(tag: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tag);
}

// The bounded name, "" when the notice carries none, and null when it carries
// one that no notification should show.
function safeTaskName(taskName: unknown): string | null {
  if (typeof taskName !== "string" || !taskName.trim()) {
    return "";
  }
  const name = [...taskName.trim()].slice(0, 120).join("");
  return [...name].some((character) => isControlCharacter(character))
    ? null
    : name;
}

// An open window is focused and told which route to apply, because loading the
// route into that window would discard the workspace state it still holds.
async function openNotificationRoute(route: unknown): Promise<void> {
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
    await worker.clients.openWindow(safeRoute);
  } catch {
    // Notification navigation is best-effort.
  }
}

// Caffold windows, the one already showing the Task first.
async function notificationTargets(route: string): Promise<WindowClient[]> {
  const windows = (
    await worker.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    })
  ).filter((client) => sameOriginClient(client.url));
  return [
    ...windows.filter((client) => clientShowsTask(client.url, route)),
    ...windows.filter((client) => !clientShowsTask(client.url, route)),
  ];
}

function safeNotificationRoute(route: unknown): string {
  if (typeof route !== "string") {
    return "";
  }
  let url: URL;
  try {
    url = new URL(route, worker.location.origin);
  } catch {
    return "";
  }
  if (url.origin !== worker.location.origin || url.search || url.hash) {
    return "";
  }
  const match = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (!match) {
    return "";
  }
  let threadId: string;
  try {
    threadId = decodeURIComponent(match[1]);
  } catch {
    return "";
  }
  return taskRoute(threadId);
}

function taskRoute(threadId: string): string {
  return safeTaskId(threadId) ? `/tasks/${encodeURIComponent(threadId)}` : "";
}

function safeTaskId(value: string): boolean {
  const characters = [...value];
  return (
    characters.length > 0 &&
    characters.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !characters.some((character) => isControlCharacter(character))
  );
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function terminalStatusCopy(status: string): string {
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Interrupted";
  return "Completed";
}

function clientShowsTask(clientUrl: string, route: string): boolean {
  try {
    const url = new URL(clientUrl);
    return (
      url.origin === worker.location.origin &&
      (url.pathname === route || url.pathname.startsWith(`${route}/`))
    );
  } catch {
    return false;
  }
}

function sameOriginClient(clientUrl: string): boolean {
  try {
    return new URL(clientUrl).origin === worker.location.origin;
  } catch {
    return false;
  }
}
