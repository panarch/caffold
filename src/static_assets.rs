pub const INDEX: &str = include_str!("../frontend/index.html");

pub struct StaticAsset {
    pub content_type: &'static str,
    pub body: &'static [u8],
}

pub fn get(path: &str) -> Option<StaticAsset> {
    match path {
        "manifest.webmanifest" => Some(manifest(include_str!("../frontend/manifest.webmanifest"))),
        "service-worker.js" => Some(js(include_str!("../frontend/service-worker.js"))),
        "build-info.js" => Some(js_bytes(include_bytes!(concat!(
            env!("OUT_DIR"),
            "/build-info.js"
        )))),
        "styles.css" => Some(css(include_str!("../frontend/styles.css"))),
        "app.js" => Some(js(include_str!("../frontend/app.js"))),
        "api.js" => Some(js(include_str!("../frontend/api.js"))),
        "fonts.js" => Some(js(include_str!("../frontend/fonts.js"))),
        "navigation-routes.js" => Some(js(include_str!("../frontend/navigation-routes.js"))),
        "settings.js" => Some(js(include_str!("../frontend/settings.js"))),
        "theme.js" => Some(js(include_str!("../frontend/theme.js"))),
        "fonts/D2Coding-Regular.woff2" => Some(woff2(include_bytes!(
            "../frontend/assets/fonts/D2Coding-Regular.woff2"
        ))),
        "fonts/D2Coding-Bold.woff2" => Some(woff2(include_bytes!(
            "../frontend/assets/fonts/D2Coding-Bold.woff2"
        ))),
        "fonts/D2Coding-OFL.txt" => Some(plain_text(include_str!(
            "../frontend/assets/fonts/D2Coding-OFL.txt"
        ))),
        "icons/caffold.png" => Some(png(include_bytes!("../frontend/assets/icons/caffold.png"))),
        "icons/favicon-32.png" => Some(png(include_bytes!(
            "../frontend/assets/icons/favicon-32.png"
        ))),
        "icons/icon-192.png" => Some(png(include_bytes!("../frontend/assets/icons/icon-192.png"))),
        "icons/icon-512.png" => Some(png(include_bytes!("../frontend/assets/icons/icon-512.png"))),
        "icons/maskable-192.png" => Some(png(include_bytes!(
            "../frontend/assets/icons/maskable-192.png"
        ))),
        "icons/maskable-512.png" => Some(png(include_bytes!(
            "../frontend/assets/icons/maskable-512.png"
        ))),
        "icons/apple-touch-icon.png" => Some(png(include_bytes!(
            "../frontend/assets/icons/apple-touch-icon.png"
        ))),
        "brand/git-logomark-light.svg" => Some(svg(include_str!(
            "../frontend/assets/brand/git-logomark-light.svg"
        ))),
        "brand/git-logomark-dark.svg" => Some(svg(include_str!(
            "../frontend/assets/brand/git-logomark-dark.svg"
        ))),
        "brand/github-invertocat-light.svg" => Some(svg(include_str!(
            "../frontend/assets/brand/github-invertocat-light.svg"
        ))),
        "brand/github-invertocat-dark.svg" => Some(svg(include_str!(
            "../frontend/assets/brand/github-invertocat-dark.svg"
        ))),
        "brand/codex-template.png" => Some(png(include_bytes!(
            "../frontend/assets/brand/codex-template.png"
        ))),
        "brand/codex-template@2x.png" => Some(png(include_bytes!(
            "../frontend/assets/brand/codex-template@2x.png"
        ))),
        "pages/layout.css" => Some(css(include_str!("../frontend/pages/layout.css"))),
        "pages/layout.js" => Some(js(include_str!("../frontend/pages/layout.js"))),
        "pages/components/build-mismatch-alert.css" => Some(css(include_str!(
            "../frontend/pages/components/build-mismatch-alert.css"
        ))),
        "pages/components/build-mismatch-alert.js" => Some(js(include_str!(
            "../frontend/pages/components/build-mismatch-alert.js"
        ))),
        "pages/components/pwa-update-lifecycle.js" => Some(js(include_str!(
            "../frontend/pages/components/pwa-update-lifecycle.js"
        ))),
        "pages/components/update-dialog.css" => Some(css(include_str!(
            "../frontend/pages/components/update-dialog.css"
        ))),
        "pages/components/update-dialog.js" => Some(js(include_str!(
            "../frontend/pages/components/update-dialog.js"
        ))),
        "components/file-tree.css" => {
            Some(css(include_str!("../frontend/components/file-tree.css")))
        }
        "components/file-tree.js" => Some(js(include_str!("../frontend/components/file-tree.js"))),
        "components/file-navigator.css" => Some(css(include_str!(
            "../frontend/components/file-navigator.css"
        ))),
        "components/file-navigator.js" => {
            Some(js(include_str!("../frontend/components/file-navigator.js")))
        }
        "components/file-navigator/list.css" => Some(css(include_str!(
            "../frontend/components/file-navigator/list.css"
        ))),
        "components/file-navigator/list.js" => Some(js(include_str!(
            "../frontend/components/file-navigator/list.js"
        ))),
        "components/review-panel-resizer.css" => Some(css(include_str!(
            "../frontend/components/review-panel-resizer.css"
        ))),
        "components/review-panel-resizer.js" => Some(js(include_str!(
            "../frontend/components/review-panel-resizer.js"
        ))),
        "components/review-responsive.js" => Some(js(include_str!(
            "../frontend/components/review-responsive.js"
        ))),
        "watch.js" => Some(js(include_str!("../frontend/watch.js"))),
        "pages/(task-workspace)/settings/appearance/page.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/settings/appearance/page.css"
        ))),
        "pages/(task-workspace)/settings/appearance/page.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/settings/appearance/page.js"
        ))),
        "pages/(task-workspace)/settings/layout.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/settings/layout.css"
        ))),
        "pages/(task-workspace)/settings/layout.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/settings/layout.js"
        ))),
        "pages/(task-workspace)/settings/navigator.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/settings/navigator.css"
        ))),
        "pages/(task-workspace)/settings/navigator.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/settings/navigator.js"
        ))),
        "pages/(task-workspace)/settings/codex/page.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/settings/codex/page.css"
        ))),
        "pages/(task-workspace)/settings/codex/page.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/settings/codex/page.js"
        ))),
        "pages/(task-workspace)/settings/about/page.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/settings/about/page.css"
        ))),
        "pages/(task-workspace)/settings/about/page.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/settings/about/page.js"
        ))),
        "pages/(task-workspace)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/layout.css"
        ))),
        "pages/(task-workspace)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/layout.js"
        ))),
        "pages/(task-workspace)/components/navigation.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/components/navigation.css"
        ))),
        "pages/(task-workspace)/components/navigation.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/components/navigation.js"
        ))),
        "pages/(task-workspace)/components/workspace-brand.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/components/workspace-brand.css"
        ))),
        "pages/(task-workspace)/components/workspace-brand.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/components/workspace-brand.js"
        ))),
        "pages/(task-workspace)/codex-status.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/codex-status.js"
        ))),
        "pages/(task-workspace)/codex-status/model.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/codex-status/model.js"
        ))),
        "pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js"
            )))
        }
        "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css"
            )))
        }
        "pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js"
            )))
        }
        "pages/(task-workspace)/tasks/page.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/page.css"
        ))),
        "pages/(task-workspace)/tasks/controls.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/controls.css"
        ))),
        "pages/(task-workspace)/tasks/page.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/page.js"
        ))),
        "pages/(task-workspace)/tasks/runtime-state.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/runtime-state.js"
        ))),
        "pages/(task-workspace)/tasks/stream.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/stream.js"
        ))),
        "pages/(task-workspace)/tasks/task-events.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/task-events.js"
        ))),
        "pages/(task-workspace)/tasks/task-format.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/task-format.js"
        ))),
        "pages/(task-workspace)/tasks/task-list-model.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/task-list-model.js"
        ))),
        "pages/(task-workspace)/tasks/components/composer.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/composer.css"
        ))),
        "pages/(task-workspace)/tasks/components/composer.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/composer.js"
        ))),
        "pages/(task-workspace)/tasks/components/task-turn-options.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-turn-options.css"
        ))),
        "pages/(task-workspace)/tasks/components/task-turn-options.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-turn-options.js"
        ))),
        "pages/(task-workspace)/tasks/components/directory-picker.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/directory-picker.css"
        ))),
        "pages/(task-workspace)/tasks/components/directory-picker.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/directory-picker.js"
        ))),
        "pages/(task-workspace)/tasks/components/archived-delete-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/archived-delete-dialog.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/archived-delete-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/archived-delete-dialog.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/image-preview-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/image-preview-dialog.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/image-preview-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/image-preview-dialog.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/voice-level-meter.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/voice-level-meter.css"
        ))),
        "pages/(task-workspace)/tasks/components/voice-level-meter.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/voice-level-meter.js"
        ))),
        "pages/(task-workspace)/tasks/components/voice-recorder.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/voice-recorder.js"
        ))),
        "pages/(task-workspace)/tasks/components/voice-worklet.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/voice-worklet.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail.css"
        ))),
        "pages/(task-workspace)/tasks/components/detail.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/stream.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/stream.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/summary.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/summary.css"
        ))),
        "pages/(task-workspace)/tasks/components/detail/summary.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/summary.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/summary/git.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/summary/git.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/summary/git.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/summary/git.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/summary/github.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/summary/github.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/summary/github.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/summary/github.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/summary/info.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/summary/info.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/summary/info.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/summary/info.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/conversation.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/conversation.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation/markdown.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/markdown.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation/render.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/render.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation/work-details.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/work-details.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/conversation/work-details.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/conversation/work-details.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/review.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/review.css"
        ))),
        "pages/(task-workspace)/tasks/components/detail/review.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/review.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/review/changes-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/review/changes-tree.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/review/changes-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/review/changes-tree.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/active-task-list.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/active-task-list.css"
        ))),
        "pages/(task-workspace)/tasks/components/active-task-list.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/active-task-list.js"
        ))),
        "pages/(task-workspace)/tasks/components/archived-task-list.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/archived-task-list.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/archived-task-list.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/archived-task-list.js"
        ))),
        "pages/(task-workspace)/tasks/components/navigator.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/navigator.css"
        ))),
        "pages/(task-workspace)/tasks/components/navigator.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/navigator.js"
        ))),
        "pages/(task-workspace)/tasks/components/task-new.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-new.css"
        ))),
        "pages/(task-workspace)/tasks/components/task-new.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-new.js"
        ))),
        "pages/(task-workspace)/tasks/components/task-status.css" => Some(css(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-status.css"
        ))),
        "pages/(task-workspace)/tasks/components/task-status.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/task-status.js"
        ))),
        "pages/(task-workspace)/tasks/components/task-transport-overlay.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/task-transport-overlay.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/task-transport-overlay.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/task-transport-overlay.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/layout.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/layout.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/layout.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/components/controls.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/components/controls.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/compare/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/compare/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/compare/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/compare/page.js"
            )))
        }
        "components/git-compare-browser.css" => Some(css(include_str!(
            "../frontend/components/git-compare-browser.css"
        ))),
        "components/git-compare-browser.js" => Some(js(include_str!(
            "../frontend/components/git-compare-browser.js"
        ))),
        "components/git-compare-browser/compare-tree.css" => Some(css(include_str!(
            "../frontend/components/git-compare-browser/compare-tree.css"
        ))),
        "components/git-compare-browser/compare-tree.js" => Some(js(include_str!(
            "../frontend/components/git-compare-browser/compare-tree.js"
        ))),
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/layout.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/layout.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/layout.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/layout.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.js"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.css"
            )))
        }
        "pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.js"
            )))
        }
        "components/code-viewer.css" => {
            Some(css(include_str!("../frontend/components/code-viewer.css")))
        }
        "components/code-viewer.js" => {
            Some(js(include_str!("../frontend/components/code-viewer.js")))
        }
        "components/diff-viewer.css" => {
            Some(css(include_str!("../frontend/components/diff-viewer.css")))
        }
        "components/diff-viewer.js" => {
            Some(js(include_str!("../frontend/components/diff-viewer.js")))
        }
        "components/dom.js" => Some(js(include_str!("../frontend/components/dom.js"))),
        "components/file-viewer.css" => {
            Some(css(include_str!("../frontend/components/file-viewer.css")))
        }
        "components/file-viewer.js" => {
            Some(js(include_str!("../frontend/components/file-viewer.js")))
        }
        "components/file-viewer-presentation.js" => Some(js(include_str!(
            "../frontend/components/file-viewer-presentation.js"
        ))),
        "components/icons.js" => Some(js(include_str!("../frontend/components/icons.js"))),
        "components/pagination.css" => {
            Some(css(include_str!("../frontend/components/pagination.css")))
        }
        "components/pagination.js" => {
            Some(js(include_str!("../frontend/components/pagination.js")))
        }
        _ => None,
    }
}

fn css(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/css; charset=utf-8",
        body: body.as_bytes(),
    }
}

fn js(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/javascript; charset=utf-8",
        body: body.as_bytes(),
    }
}

fn js_bytes(body: &'static [u8]) -> StaticAsset {
    StaticAsset {
        content_type: "text/javascript; charset=utf-8",
        body,
    }
}

fn manifest(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "application/manifest+json; charset=utf-8",
        body: body.as_bytes(),
    }
}

fn svg(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "image/svg+xml",
        body: body.as_bytes(),
    }
}

fn png(body: &'static [u8]) -> StaticAsset {
    StaticAsset {
        content_type: "image/png",
        body,
    }
}

fn woff2(body: &'static [u8]) -> StaticAsset {
    StaticAsset {
        content_type: "font/woff2",
        body,
    }
}

fn plain_text(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/plain; charset=utf-8",
        body: body.as_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::get;

    #[test]
    fn serves_pwa_icon_assets() {
        let manifest = get("manifest.webmanifest").expect("manifest asset");
        assert_eq!(
            manifest.content_type,
            "application/manifest+json; charset=utf-8"
        );
        assert!(manifest.body.starts_with(b"{\n"));

        let service_worker = get("service-worker.js").expect("service worker asset");
        assert_eq!(
            service_worker.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(service_worker.body.starts_with(b"const CACHE_NAME"));

        let build_info = get("build-info.js").expect("build info asset");
        assert_eq!(build_info.content_type, "text/javascript; charset=utf-8");
        assert!(build_info.body.starts_with(b"export const BUILD_INFO"));

        for path in ["icons/caffold.png", "icons/favicon-32.png"] {
            let icon = get(path).expect("PNG icon asset");
            assert_eq!(icon.content_type, "image/png");
            assert!(icon.body.starts_with(b"\x89PNG\r\n\x1a\n"));
        }

        let brand_svg = get("brand/github-invertocat-light.svg").expect("brand svg asset");
        assert_eq!(brand_svg.content_type, "image/svg+xml");
        assert!(brand_svg.body.starts_with(b"<svg"));

        let codex_brand = get("brand/codex-template@2x.png").expect("codex brand asset");
        assert_eq!(codex_brand.content_type, "image/png");
        assert!(codex_brand.body.starts_with(b"\x89PNG\r\n\x1a\n"));

        let codex_status_model =
            get("pages/(task-workspace)/codex-status/model.js").expect("Codex status model asset");
        assert_eq!(
            codex_status_model.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(codex_status_model.body.starts_with(b"export "));

        let review_responsive_js =
            get("components/review-responsive.js").expect("review responsive js asset");
        assert_eq!(
            review_responsive_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            review_responsive_js
                .body
                .starts_with(b"export const REVIEW_SINGLE_PANE_MAX_WIDTH_PX")
        );

        for path in [
            "pages/(task-workspace)/tasks/components/detail/summary/git.js",
            "pages/(task-workspace)/tasks/components/detail/summary/github.js",
        ] {
            let task_button_js = get(path).expect("Task button js asset");
            assert_eq!(
                task_button_js.content_type,
                "text/javascript; charset=utf-8"
            );
            assert!(task_button_js.body.starts_with(b"const "));
        }

        for (path, owner) in [
            (
                "pages/(task-workspace)/tasks/components/detail/summary/git.css",
                b"caffold-task-detail-git".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/summary/github.css",
                b"caffold-task-detail-github".as_slice(),
            ),
        ] {
            let task_button_css = get(path).expect("Task button css asset");
            assert_eq!(task_button_css.content_type, "text/css; charset=utf-8");
            assert!(task_button_css.body.starts_with(owner));
        }

        assert!(get("pages/components/header-actions.js").is_none());
        assert!(get("pages/components/app-menu.js").is_none());
        assert!(get("pages/components/pathbar.js").is_none());

        let build_mismatch_alert =
            get("pages/components/build-mismatch-alert.js").expect("build mismatch alert js asset");
        assert_eq!(
            build_mismatch_alert.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(build_mismatch_alert.body.starts_with(b"export "));

        let pwa_update_lifecycle =
            get("pages/components/pwa-update-lifecycle.js").expect("PWA update lifecycle js asset");
        assert_eq!(
            pwa_update_lifecycle.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(pwa_update_lifecycle.body.starts_with(b"const "));

        let update_dialog =
            get("pages/components/update-dialog.js").expect("update dialog js asset");
        assert_eq!(update_dialog.content_type, "text/javascript; charset=utf-8");
        assert!(update_dialog.body.starts_with(b"export "));

        assert!(get("pages/components/about-dialog.js").is_none());
        assert!(get("pages/components/about-dialog.css").is_none());

        let settings_module = get("settings.js").expect("settings module asset");
        assert_eq!(
            settings_module.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(settings_module.body.starts_with(b"import "));

        let theme_module = get("theme.js").expect("theme module asset");
        assert_eq!(theme_module.content_type, "text/javascript; charset=utf-8");
        assert!(theme_module.body.starts_with(b"const "));

        let fonts_module = get("fonts.js").expect("fonts module asset");
        assert_eq!(fonts_module.content_type, "text/javascript; charset=utf-8");
        assert!(fonts_module.body.starts_with(b"export const"));

        let regular_font =
            get("fonts/D2Coding-Regular.woff2").expect("D2 Coding regular font asset");
        assert_eq!(regular_font.content_type, "font/woff2");
        assert!(regular_font.body.starts_with(b"wOF2"));

        let bold_font = get("fonts/D2Coding-Bold.woff2").expect("D2 Coding bold font asset");
        assert_eq!(bold_font.content_type, "font/woff2");
        assert!(bold_font.body.starts_with(b"wOF2"));

        let font_license = get("fonts/D2Coding-OFL.txt").expect("D2 Coding license asset");
        assert_eq!(font_license.content_type, "text/plain; charset=utf-8");
        assert!(font_license.body.starts_with(b"Copyright"));

        let settings_page = get("pages/(task-workspace)/settings/appearance/page.js")
            .expect("settings appearance page js asset");
        assert_eq!(settings_page.content_type, "text/javascript; charset=utf-8");
        assert!(settings_page.body.starts_with(b"import "));

        for path in [
            "pages/(task-workspace)/settings/layout.js",
            "pages/(task-workspace)/settings/navigator.js",
            "pages/(task-workspace)/settings/codex/page.js",
            "pages/(task-workspace)/settings/about/page.js",
        ] {
            let asset = get(path).unwrap_or_else(|| panic!("missing settings asset {path}"));
            assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
            assert!(asset.body.starts_with(b"import "));
        }

        let runtime_restart_dialog =
            get("pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js")
                .expect("Codex runtime restart dialog asset");
        assert_eq!(
            runtime_restart_dialog.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(runtime_restart_dialog.body.starts_with(b"export const"));

        let app_shell_layout = get("pages/layout.js").expect("app shell layout js asset");
        assert_eq!(
            app_shell_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(app_shell_layout.body.starts_with(b"import "));

        assert!(get("pages/(review-workspace)/layout.css").is_none());

        let git_review_layout =
            get("pages/(task-workspace)/tasks/components/detail/(git)/layout.js")
                .expect("git review layout js");
        assert_eq!(
            git_review_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(git_review_layout.body.starts_with(b"import "));
        assert!(
            git_review_layout
                .body
                .windows(b"caffold-task-git-layout".len())
                .any(|window| window == b"caffold-task-git-layout")
        );
        let git_review_controls =
            get("pages/(task-workspace)/tasks/components/detail/(git)/components/controls.js")
                .expect("git review controls js");
        assert_eq!(
            git_review_controls.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            git_review_controls
                .body
                .windows(b"caffold-git-review-controls".len())
                .any(|window| window == b"caffold-git-review-controls")
        );
        let git_review_controls_css =
            get("pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css")
                .expect("git review controls css");
        assert_eq!(
            git_review_controls_css.content_type,
            "text/css; charset=utf-8"
        );
        assert!(
            git_review_controls_css
                .body
                .starts_with(b"caffold-git-review-controls")
        );
        let review_panel_resizer =
            get("components/review-panel-resizer.js").expect("review panel resizer js");
        assert_eq!(
            review_panel_resizer.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            review_panel_resizer
                .body
                .windows(b"caffold-review-panel-resizer".len())
                .any(|window| window == b"caffold-review-panel-resizer")
        );
        let review_panel_resizer_css =
            get("components/review-panel-resizer.css").expect("review panel resizer css");
        assert_eq!(
            review_panel_resizer_css.content_type,
            "text/css; charset=utf-8"
        );
        assert!(
            review_panel_resizer_css
                .body
                .starts_with(b"caffold-review-panel-resizer")
        );

        let compare_page =
            get("pages/(task-workspace)/tasks/components/detail/(git)/compare/page.js")
                .expect("compare page js");
        assert_eq!(compare_page.content_type, "text/javascript; charset=utf-8");
        assert!(compare_page.body.starts_with(b"import "));
        assert!(
            compare_page
                .body
                .windows(b"caffold-git-compare-page".len())
                .any(|window| window == b"caffold-git-compare-page")
        );
        let compare_browser = get("components/git-compare-browser.js").expect("compare browser js");
        assert_eq!(
            compare_browser.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            compare_browser
                .body
                .windows(b"caffold-git-compare-browser".len())
                .any(|window| window == b"caffold-git-compare-browser")
        );
        let compare_tree =
            get("components/git-compare-browser/compare-tree.js").expect("compare tree js");
        assert_eq!(compare_tree.content_type, "text/javascript; charset=utf-8");
        assert!(
            compare_tree
                .body
                .windows(b"caffold-git-compare-tree".len())
                .any(|window| window == b"caffold-git-compare-tree")
        );
        assert!(get("pages/(task-workspace)/tasks/components/detail/(git)/compare/components/compare-tree.js").is_none());

        let task_workspace_layout =
            get("pages/(task-workspace)/layout.js").expect("task workspace layout js");
        assert_eq!(
            task_workspace_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(task_workspace_layout.body.starts_with(b"import "));
        assert!(
            task_workspace_layout
                .body
                .windows(b"caffold-task-workspace".len())
                .any(|window| window == b"caffold-task-workspace")
        );
        let task_workspace_layout_css =
            get("pages/(task-workspace)/layout.css").expect("task workspace layout css");
        assert_eq!(
            task_workspace_layout_css.content_type,
            "text/css; charset=utf-8"
        );
        assert!(
            task_workspace_layout_css
                .body
                .starts_with(b"caffold-task-workspace")
        );
        let task_workspace_navigation = get("pages/(task-workspace)/components/navigation.js")
            .expect("task workspace navigation js");
        assert_eq!(
            task_workspace_navigation.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            task_workspace_navigation
                .body
                .windows(b"caffold-task-workspace-navigation".len())
                .any(|window| window == b"caffold-task-workspace-navigation")
        );
        let task_workspace_navigation_css = get("pages/(task-workspace)/components/navigation.css")
            .expect("task workspace navigation css");
        assert_eq!(
            task_workspace_navigation_css.content_type,
            "text/css; charset=utf-8"
        );
        assert!(
            task_workspace_navigation_css
                .body
                .starts_with(b"caffold-task-workspace-navigation")
        );
        let workspace_brand = get("pages/(task-workspace)/components/workspace-brand.js")
            .expect("workspace brand js");
        assert_eq!(
            workspace_brand.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            workspace_brand
                .body
                .windows(b"caffold-workspace-brand".len())
                .any(|window| window == b"caffold-workspace-brand")
        );
        let workspace_brand_css = get("pages/(task-workspace)/components/workspace-brand.css")
            .expect("workspace brand css");
        assert_eq!(workspace_brand_css.content_type, "text/css; charset=utf-8");
        assert!(
            workspace_brand_css
                .body
                .starts_with(b"caffold-workspace-brand")
        );

        let tasks_page = get("pages/(task-workspace)/tasks/page.js").expect("tasks page js");
        assert_eq!(tasks_page.content_type, "text/javascript; charset=utf-8");
        assert!(tasks_page.body.starts_with(b"import "));
        assert!(
            tasks_page
                .body
                .windows(b"caffold-tasks-page".len())
                .any(|window| window == b"caffold-tasks-page")
        );
        let tasks_runtime_state =
            get("pages/(task-workspace)/tasks/runtime-state.js").expect("tasks runtime state js");
        assert_eq!(
            tasks_runtime_state.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(tasks_runtime_state.body.starts_with(b"export "));
        for path in [
            "pages/(task-workspace)/tasks/task-events.js",
            "pages/(task-workspace)/tasks/task-format.js",
            "pages/(task-workspace)/tasks/task-list-model.js",
            "pages/(task-workspace)/tasks/components/task-status.js",
            "pages/(task-workspace)/tasks/components/detail/conversation/render.js",
        ] {
            let asset = get(path).expect("tasks state module");
            assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
            assert!(asset.body.starts_with(b"export ") || asset.body.starts_with(b"import "));
        }
        let tasks_page_css = get("pages/(task-workspace)/tasks/page.css").expect("tasks page css");
        assert_eq!(tasks_page_css.content_type, "text/css; charset=utf-8");
        assert!(tasks_page_css.body.starts_with(b"caffold-tasks-page"));
        let tasks_controls_css =
            get("pages/(task-workspace)/tasks/controls.css").expect("tasks controls css");
        assert_eq!(tasks_controls_css.content_type, "text/css; charset=utf-8");
        assert!(tasks_controls_css.body.starts_with(b"caffold-tasks-page"));
        let tasks_markdown =
            get("pages/(task-workspace)/tasks/components/detail/conversation/markdown.js")
                .expect("tasks markdown component js");
        assert_eq!(
            tasks_markdown.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            tasks_markdown
                .body
                .windows(b"caffold-task-markdown".len())
                .any(|window| window == b"caffold-task-markdown")
        );
        let tasks_navigator = get("pages/(task-workspace)/tasks/components/navigator.js")
            .expect("tasks navigator component js");
        assert_eq!(
            tasks_navigator.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            tasks_navigator
                .body
                .windows(b"caffold-task-navigator".len())
                .any(|window| window == b"caffold-task-navigator")
        );
        for (path, marker) in [
            (
                "pages/(task-workspace)/tasks/components/active-task-list.js",
                b"caffold-active-task-list".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/archived-task-list.js",
                b"caffold-archived-task-list".as_slice(),
            ),
        ] {
            let task_list_asset = get(path).expect("task list component asset");
            assert_eq!(
                task_list_asset.content_type,
                "text/javascript; charset=utf-8"
            );
            assert!(
                task_list_asset
                    .body
                    .windows(marker.len())
                    .any(|window| window == marker)
            );
        }
        let tasks_navigator_css = get("pages/(task-workspace)/tasks/components/navigator.css")
            .expect("tasks navigator component css");
        assert_eq!(tasks_navigator_css.content_type, "text/css; charset=utf-8");
        assert!(
            tasks_navigator_css
                .body
                .starts_with(b"caffold-task-navigator")
        );
        for (path, prefix) in [
            (
                "pages/(task-workspace)/tasks/components/active-task-list.css",
                b"caffold-active-task-list".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/archived-task-list.css",
                b"caffold-archived-task-list".as_slice(),
            ),
        ] {
            let task_list_css = get(path).expect("task list component css");
            assert_eq!(task_list_css.content_type, "text/css; charset=utf-8");
            assert!(task_list_css.body.starts_with(prefix));
        }
        let task_detail_stream = get("pages/(task-workspace)/tasks/components/detail/stream.js")
            .expect("task detail stream js");
        assert_eq!(
            task_detail_stream.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            task_detail_stream
                .body
                .windows(b"TaskDetailStream".len())
                .any(|window| window == b"TaskDetailStream")
        );
        let task_stream =
            get("pages/(task-workspace)/tasks/stream.js").expect("shared task stream js");
        assert_eq!(task_stream.content_type, "text/javascript; charset=utf-8");
        assert!(
            task_stream
                .body
                .windows(b"TaskStreamLifecycle".len())
                .any(|window| window == b"TaskStreamLifecycle")
        );
        for (path, tag) in [
            (
                "pages/(task-workspace)/tasks/components/composer.js",
                b"caffold-task-composer".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-turn-options.js",
                b"caffold-task-turn-options".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/directory-picker.js",
                b"caffold-task-directory-picker".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/archived-delete-dialog.js",
                b"caffold-task-archived-delete-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/image-preview-dialog.js",
                b"caffold-task-image-preview-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation.js",
                b"caffold-task-conversation".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.js",
                b"caffold-task-command-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation/work-details.js",
                b"caffold-task-work-details".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-new.js",
                b"caffold-task-new".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-transport-overlay.js",
                b"caffold-task-transport-overlay".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail.js",
                b"caffold-task-detail".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/summary.js",
                b"caffold-task-detail-summary".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/summary/info.js",
                b"caffold-task-detail-info".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/review.js",
                b"caffold-task-review".as_slice(),
            ),
        ] {
            let asset = get(path).expect("tasks component js");
            assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
            assert!(asset.body.windows(tag.len()).any(|window| window == tag));
        }
        for (path, marker) in [
            (
                "pages/(task-workspace)/tasks/components/voice-level-meter.js",
                b"caffold-voice-level-meter".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/voice-recorder.js",
                b"VoiceRecorder".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/voice-worklet.js",
                b"caffold-voice-capture".as_slice(),
            ),
        ] {
            let asset = get(path).expect("voice input js");
            assert_eq!(asset.content_type, "text/javascript; charset=utf-8");
            assert!(
                asset
                    .body
                    .windows(marker.len())
                    .any(|window| window == marker)
            );
        }
        for path in [
            "/assets/pages/(task-workspace)/tasks/stream.js",
            "/assets/pages/(task-workspace)/tasks/components/active-task-list.css",
            "/assets/pages/(task-workspace)/tasks/components/active-task-list.js",
            "/assets/pages/(task-workspace)/tasks/components/archived-task-list.css",
            "/assets/pages/(task-workspace)/tasks/components/archived-task-list.js",
            "/assets/pages/(task-workspace)/tasks/components/voice-level-meter.css",
            "/assets/pages/(task-workspace)/tasks/components/voice-level-meter.js",
        ] {
            assert!(
                service_worker
                    .body
                    .windows(path.len())
                    .any(|window| window == path.as_bytes()),
                "service worker is missing {path}"
            );
        }
        for (path, prefix) in [
            (
                "pages/(task-workspace)/tasks/components/composer.css",
                b"caffold-task-composer".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/directory-picker.css",
                b"caffold-task-directory-picker".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/archived-delete-dialog.css",
                b"caffold-task-archived-delete-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/image-preview-dialog.css",
                b"caffold-task-image-preview-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/voice-level-meter.css",
                b"caffold-voice-level-meter".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation.css",
                b"caffold-task-conversation".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css",
                b"caffold-task-command-dialog".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/conversation/work-details.css",
                b"caffold-task-work-details".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-new.css",
                b"caffold-task-new".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-transport-overlay.css",
                b"caffold-task-transport-overlay".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail.css",
                b"caffold-task-detail".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/summary.css",
                b"caffold-task-detail-summary".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/summary/info.css",
                b"caffold-task-detail-info".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/detail/review.css",
                b"caffold-task-review".as_slice(),
            ),
            (
                "pages/(task-workspace)/tasks/components/task-status.css",
                b"caffold-tasks-page".as_slice(),
            ),
        ] {
            let asset = get(path).expect("tasks component css");
            assert_eq!(asset.content_type, "text/css; charset=utf-8");
            assert!(asset.body.starts_with(prefix));
        }
        assert!(get("pages/tasks/page.js").is_none());
        assert!(get("pages/tasks/page.css").is_none());

        let diff_changes_tree =
            get("pages/(task-workspace)/tasks/components/detail/review/changes-tree.js")
                .expect("integrated review changes tree js");
        assert_eq!(
            diff_changes_tree.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            diff_changes_tree
                .body
                .windows(b"caffold-git-diff-changes-tree".len())
                .any(|window| window == b"caffold-git-diff-changes-tree")
        );
        assert!(get("components/git-diff-browser.js").is_none());
        assert!(get("pages/(task-workspace)/tasks/components/detail/(git)/diff/page.js").is_none());

        let github_review_layout =
            get("pages/(task-workspace)/tasks/components/detail/(github)/layout.js")
                .expect("github review layout js");
        assert_eq!(
            github_review_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(github_review_layout.body.starts_with(b"import "));
        assert!(
            github_review_layout
                .body
                .windows(b"caffold-task-github-layout".len())
                .any(|window| window == b"caffold-task-github-layout")
        );
        let github_markdown =
            get("pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js")
                .expect("github markdown component js");
        assert_eq!(
            github_markdown.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            github_markdown
                .body
                .starts_with(b"const FORBIDDEN_ELEMENTS")
        );
        assert!(
            github_markdown
                .body
                .windows(b"caffold-github-markdown".len())
                .any(|window| window == b"caffold-github-markdown")
        );

        let issues_layout =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.js")
                .expect("issues layout js");
        assert_eq!(issues_layout.content_type, "text/javascript; charset=utf-8");
        assert!(issues_layout.body.starts_with(b"import "));
        assert!(
            issues_layout
                .body
                .windows(b"caffold-github-issues-layout".len())
                .any(|window| window == b"caffold-github-issues-layout")
        );

        let issues_list_page =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.js")
                .expect("issues list page js");
        assert_eq!(
            issues_list_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(issues_list_page.body.starts_with(b"import "));
        assert!(
            issues_list_page
                .body
                .windows(b"caffold-github-issues-list-page".len())
                .any(|window| window == b"caffold-github-issues-list-page")
        );

        let issue_detail_page =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.js")
                .expect("issue detail page js");
        assert_eq!(
            issue_detail_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(issue_detail_page.body.starts_with(b"import "));
        assert!(
            issue_detail_page
                .body
                .windows(b"caffold-github-issue-detail-page".len())
                .any(|window| window == b"caffold-github-issue-detail-page")
        );
        let github_task_start_dialog =
            get("pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.js")
                .expect("github task start dialog js");
        assert_eq!(
            github_task_start_dialog.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(
            github_task_start_dialog
                .body
                .windows(b"caffold-github-task-start-dialog".len())
                .any(|window| window == b"caffold-github-task-start-dialog")
        );
        let github_issue_task_source = get(
            "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.js",
        )
        .expect("github issue task source js");
        assert!(
            github_issue_task_source
                .body
                .windows(b"caffold-github-issue-task-source".len())
                .any(|window| window == b"caffold-github-issue-task-source")
        );
        let github_pull_task_source = get(
            "pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.js",
        )
        .expect("github pull task source js");
        assert!(
            github_pull_task_source
                .body
                .windows(b"caffold-github-pull-task-source".len())
                .any(|window| window == b"caffold-github-pull-task-source")
        );
        assert!(get("components/github-issues-list.js").is_none());
        assert!(get("components/github-issue-viewer.js").is_none());
        assert!(get("components/github-markdown.js").is_none());

        let pulls_layout =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.js")
                .expect("pulls layout js");
        assert_eq!(pulls_layout.content_type, "text/javascript; charset=utf-8");
        assert!(pulls_layout.body.starts_with(b"import "));
        assert!(
            pulls_layout
                .body
                .windows(b"caffold-github-pulls-layout".len())
                .any(|window| window == b"caffold-github-pulls-layout")
        );

        let pulls_list_page =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.js")
                .expect("pulls list page js");
        assert_eq!(
            pulls_list_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(pulls_list_page.body.starts_with(b"import "));
        assert!(
            pulls_list_page
                .body
                .windows(b"caffold-github-pulls-list-page".len())
                .any(|window| window == b"caffold-github-pulls-list-page")
        );

        let pull_detail_page =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.js")
                .expect("pull detail page js");
        assert_eq!(
            pull_detail_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(pull_detail_page.body.starts_with(b"import "));
        assert!(
            pull_detail_page
                .body
                .windows(b"caffold-github-pull-detail-page".len())
                .any(|window| window == b"caffold-github-pull-detail-page")
        );

        let pull_files_page =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.js")
                .expect("pull files page js");
        assert_eq!(
            pull_files_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(pull_files_page.body.starts_with(b"import "));
        assert!(
            pull_files_page
                .body
                .windows(b"caffold-github-pull-files-page".len())
                .any(|window| window == b"caffold-github-pull-files-page")
        );
        let pull_files_tree =
            get("pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.js")
                .expect("pull files tree js");
        assert_eq!(
            pull_files_tree.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(pull_files_tree.body.starts_with(b"import "));
        assert!(
            pull_files_tree
                .body
                .windows(b"caffold-github-pull-files-tree".len())
                .any(|window| window == b"caffold-github-pull-files-tree")
        );
        assert!(get("components/github-pulls-list.js").is_none());
        assert!(get("components/github-pull-viewer.js").is_none());
        assert!(get("components/github-pull-files-tree.js").is_none());

        assert!(get("pages/files/page.js").is_none());
        assert!(get("components/file-browser.js").is_none());

        let file_navigator_component =
            get("components/file-navigator.js").expect("file navigator component js asset");
        assert_eq!(
            file_navigator_component.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(file_navigator_component.body.starts_with(b"import "));
        assert!(
            file_navigator_component
                .body
                .windows(b"caffold-file-navigator".len())
                .any(|window| window == b"caffold-file-navigator")
        );
        let file_navigator_css =
            get("components/file-navigator.css").expect("file navigator component css asset");
        assert_eq!(file_navigator_css.content_type, "text/css; charset=utf-8");
        assert!(
            file_navigator_css
                .body
                .starts_with(b"@import \"./file-navigator/list.css\"")
        );

        let file_list_component = get("components/file-navigator/list.js")
            .expect("file navigator list component js asset");
        assert_eq!(
            file_list_component.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(file_list_component.body.starts_with(b"import "));
        assert!(
            file_list_component
                .body
                .windows(b"caffold-file-list".len())
                .any(|window| window == b"caffold-file-list")
        );
        let file_tree_component =
            get("components/file-tree.js").expect("file tree component js asset");
        assert_eq!(
            file_tree_component.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(file_tree_component.body.starts_with(b"import "));
        assert!(
            file_tree_component
                .body
                .windows(b"caffold-file-tree".len())
                .any(|window| window == b"caffold-file-tree")
        );
        let file_tree_css = get("components/file-tree.css").expect("file tree component css asset");
        assert_eq!(file_tree_css.content_type, "text/css; charset=utf-8");
        assert!(file_tree_css.body.starts_with(b"caffold-file-tree"));
        assert!(get("pages/files/components/list.js").is_none());
        assert!(get("pages/files/components/list.css").is_none());
        let watch_module = get("watch.js").expect("watch js asset");
        assert_eq!(watch_module.content_type, "text/javascript; charset=utf-8");
        assert!(watch_module.body.starts_with(b"import "));
        let log_layout =
            get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.js")
                .expect("git log layout js asset");
        assert_eq!(log_layout.content_type, "text/javascript; charset=utf-8");
        assert!(log_layout.body.starts_with(b"import "));
        assert!(
            log_layout
                .body
                .windows(b"caffold-git-log-layout".len())
                .any(|window| window == b"caffold-git-log-layout")
        );
        let log_list_page =
            get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.js")
                .expect("log list page js asset");
        assert_eq!(log_list_page.content_type, "text/javascript; charset=utf-8");
        assert!(log_list_page.body.starts_with(b"import "));
        assert!(
            log_list_page
                .body
                .windows(b"caffold-git-log-list-page".len())
                .any(|window| window == b"caffold-git-log-list-page")
        );
        let log_commit_page =
            get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.js")
                .expect("log commit page js asset");
        assert_eq!(
            log_commit_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(log_commit_page.body.starts_with(b"import "));
        assert!(
            log_commit_page
                .body
                .windows(b"caffold-git-log-commit-page".len())
                .any(|window| window == b"caffold-git-log-commit-page")
        );
        let commit_tree_component =
            get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.js")
                .expect("commit changes tree component js asset");
        assert_eq!(
            commit_tree_component.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(commit_tree_component.body.starts_with(b"import "));
        assert!(
            commit_tree_component
                .body
                .windows(b"caffold-commit-changes-tree".len())
                .any(|window| window == b"caffold-commit-changes-tree")
        );
        assert!(get("components/file-list.js").is_none());
        assert!(get("components/log-list.js").is_none());
        assert!(get("components/commit-changes-tree.js").is_none());
        assert!(
            get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/components/list.js")
                .is_none()
        );
        assert!(get("pages/(task-workspace)/tasks/components/detail/(git)/(log)/components/commit-tree.js").is_none());

        let png = get("icons/icon-192.png").expect("png icon asset");
        assert_eq!(png.content_type, "image/png");
        assert!(png.body.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
