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
        "pages/components/app-menu.css" => Some(css(include_str!(
            "../frontend/pages/components/app-menu.css"
        ))),
        "pages/components/app-menu.js" => {
            Some(js(include_str!("../frontend/pages/components/app-menu.js")))
        }
        "pages/components/pathbar.css" => Some(css(include_str!(
            "../frontend/pages/components/pathbar.css"
        ))),
        "pages/components/pathbar.js" => {
            Some(js(include_str!("../frontend/pages/components/pathbar.js")))
        }
        "pages/components/header-actions.css" => Some(css(include_str!(
            "../frontend/pages/components/header-actions.css"
        ))),
        "pages/components/header-actions.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions.js"
        ))),
        "pages/components/header-actions/codex-status.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions/codex-status.js"
        ))),
        "pages/components/header-actions/codex-status-model.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions/codex-status-model.js"
        ))),
        "pages/components/header-actions/git-status.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions/git-status.js"
        ))),
        "pages/components/header-actions/github-status.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions/github-status.js"
        ))),
        "pages/components/header-actions/shared.js" => Some(js(include_str!(
            "../frontend/pages/components/header-actions/shared.js"
        ))),
        "components/file-tree.css" => {
            Some(css(include_str!("../frontend/components/file-tree.css")))
        }
        "components/file-tree.js" => Some(js(include_str!("../frontend/components/file-tree.js"))),
        "components/file-browser.css" => {
            Some(css(include_str!("../frontend/components/file-browser.css")))
        }
        "components/file-browser.js" => {
            Some(js(include_str!("../frontend/components/file-browser.js")))
        }
        "components/file-navigator.css" => Some(css(include_str!(
            "../frontend/components/file-navigator.css"
        ))),
        "components/file-navigator.js" => {
            Some(js(include_str!("../frontend/components/file-navigator.js")))
        }
        "components/file-browser/list.css" => Some(css(include_str!(
            "../frontend/components/file-browser/list.css"
        ))),
        "components/file-browser/list.js" => Some(js(include_str!(
            "../frontend/components/file-browser/list.js"
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
        "pages/files/page.css" => Some(css(include_str!("../frontend/pages/files/page.css"))),
        "pages/files/page.js" => Some(js(include_str!("../frontend/pages/files/page.js"))),
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
        "pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.css" => {
            Some(css(include_str!(
                "../frontend/pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.css"
            )))
        }
        "pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.js" => {
            Some(js(include_str!(
                "../frontend/pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.js"
            )))
        }
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
        "pages/(review-workspace)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/layout.css"
        ))),
        "pages/(review-workspace)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/layout.js"
        ))),
        "pages/(review-workspace)/(git)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/layout.css"
        ))),
        "pages/(review-workspace)/(git)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/layout.js"
        ))),
        "pages/(review-workspace)/(git)/components/controls.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/components/controls.css"
        ))),
        "pages/(review-workspace)/(git)/components/controls.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/components/controls.js"
        ))),
        "pages/(review-workspace)/(git)/diff/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/diff/page.css"
        ))),
        "pages/(review-workspace)/(git)/diff/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/diff/page.js"
        ))),
        "components/git-diff-browser.css" => Some(css(include_str!(
            "../frontend/components/git-diff-browser.css"
        ))),
        "components/git-diff-browser.js" => Some(js(include_str!(
            "../frontend/components/git-diff-browser.js"
        ))),
        "components/git-diff-browser/changes-tree.css" => Some(css(include_str!(
            "../frontend/components/git-diff-browser/changes-tree.css"
        ))),
        "components/git-diff-browser/changes-tree.js" => Some(js(include_str!(
            "../frontend/components/git-diff-browser/changes-tree.js"
        ))),
        "pages/(review-workspace)/(git)/compare/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/compare/page.css"
        ))),
        "pages/(review-workspace)/(git)/compare/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/compare/page.js"
        ))),
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
        "pages/(review-workspace)/(git)/(log)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/layout.css"
        ))),
        "pages/(review-workspace)/(git)/(log)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/layout.js"
        ))),
        "pages/(review-workspace)/(git)/(log)/list/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/list/page.css"
        ))),
        "pages/(review-workspace)/(git)/(log)/list/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/list/page.js"
        ))),
        "pages/(review-workspace)/(git)/(log)/commit/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/commit/page.css"
        ))),
        "pages/(review-workspace)/(git)/(log)/commit/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(git)/(log)/commit/page.js"
        ))),
        "pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.css"
            )))
        }
        "pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.js"
            )))
        }
        "pages/(review-workspace)/(github)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/layout.css"
        ))),
        "pages/(review-workspace)/(github)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/layout.js"
        ))),
        "pages/(review-workspace)/(github)/components/markdown.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/components/markdown.js"
        ))),
        "pages/(review-workspace)/(github)/(issues)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/layout.css"
        ))),
        "pages/(review-workspace)/(github)/(issues)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/layout.js"
        ))),
        "pages/(review-workspace)/(github)/(issues)/list/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/list/page.css"
        ))),
        "pages/(review-workspace)/(github)/(issues)/list/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/list/page.js"
        ))),
        "pages/(review-workspace)/(github)/(issues)/detail/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/detail/page.css"
        ))),
        "pages/(review-workspace)/(github)/(issues)/detail/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(issues)/detail/page.js"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/layout.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/layout.css"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/layout.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/layout.js"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/list/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/list/page.css"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/list/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/list/page.js"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/detail/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/detail/page.css"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/detail/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/detail/page.js"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/files/page.css" => Some(css(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/files/page.css"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/files/page.js" => Some(js(include_str!(
            "../frontend/pages/(review-workspace)/(github)/(pulls)/files/page.js"
        ))),
        "pages/(review-workspace)/(github)/(pulls)/files/components/tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/(review-workspace)/(github)/(pulls)/files/components/tree.css"
            )))
        }
        "pages/(review-workspace)/(github)/(pulls)/files/components/tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/(review-workspace)/(github)/(pulls)/files/components/tree.js"
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

        let codex_status_js =
            get("pages/components/header-actions/codex-status.js").expect("codex status js asset");
        assert_eq!(
            codex_status_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(codex_status_js.body.starts_with(b"import "));

        assert!(get("pages/components/header-actions/codex-status.css").is_none());

        let codex_status_model = get("pages/components/header-actions/codex-status-model.js")
            .expect("codex status model asset");
        assert_eq!(
            codex_status_model.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(codex_status_model.body.starts_with(b"export "));

        let git_status_js =
            get("pages/components/header-actions/git-status.js").expect("git status js asset");
        assert_eq!(git_status_js.content_type, "text/javascript; charset=utf-8");
        assert!(git_status_js.body.starts_with(b"import "));

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

        let github_status_js = get("pages/components/header-actions/github-status.js")
            .expect("github status js asset");
        assert_eq!(
            github_status_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(github_status_js.body.starts_with(b"import "));

        let header_actions_shared = get("pages/components/header-actions/shared.js")
            .expect("header actions shared js asset");
        assert_eq!(
            header_actions_shared.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(header_actions_shared.body.starts_with(b"import "));
        assert!(get("components/header-actions/codex-status.js").is_none());
        assert!(get("components/header-actions/codex-status.css").is_none());
        assert!(get("components/header-actions/git-status.js").is_none());
        assert!(get("components/header-actions/github-status.js").is_none());
        assert!(get("components/header-actions/shared.js").is_none());
        assert!(get("components/header-actions.js").is_none());
        assert!(get("components/header-actions.css").is_none());
        assert!(get("components/pathbar.js").is_none());
        assert!(get("components/pathbar.css").is_none());
        assert!(get("components/project-switcher.js").is_none());
        assert!(get("components/project-switcher.css").is_none());

        let app_menu = get("pages/components/app-menu.js").expect("app menu js asset");
        assert_eq!(app_menu.content_type, "text/javascript; charset=utf-8");
        assert!(app_menu.body.starts_with(b"import "));

        assert!(get("pages/components/about-dialog.js").is_none());
        assert!(get("pages/components/about-dialog.css").is_none());

        let settings_module = get("settings.js").expect("settings module asset");
        assert_eq!(
            settings_module.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(settings_module.body.starts_with(b"import "));

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
            get("pages/(task-workspace)/settings/codex/components/runtime-restart-dialog.js")
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

        let review_workspace_layout_css =
            get("pages/(review-workspace)/layout.css").expect("review workspace layout css asset");
        assert_eq!(
            review_workspace_layout_css.content_type,
            "text/css; charset=utf-8"
        );
        assert!(
            review_workspace_layout_css
                .body
                .starts_with(b"caffold-review-workspace")
        );

        let git_review_layout =
            get("pages/(review-workspace)/(git)/layout.js").expect("git review layout js");
        assert_eq!(
            git_review_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(git_review_layout.body.starts_with(b"import "));
        assert!(
            git_review_layout
                .body
                .windows(b"caffold-git-review-layout".len())
                .any(|window| window == b"caffold-git-review-layout")
        );
        let git_review_controls = get("pages/(review-workspace)/(git)/components/controls.js")
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
        let git_review_controls_css = get("pages/(review-workspace)/(git)/components/controls.css")
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
            get("pages/(review-workspace)/(git)/compare/page.js").expect("compare page js");
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
        assert!(get("pages/(review-workspace)/(git)/compare/components/compare-tree.js").is_none());

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
        let tasks_navigator_css = get("pages/(task-workspace)/tasks/components/navigator.css")
            .expect("tasks navigator component css");
        assert_eq!(tasks_navigator_css.content_type, "text/css; charset=utf-8");
        assert!(
            tasks_navigator_css
                .body
                .starts_with(b"caffold-task-navigator")
        );
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
        for (path, tag) in [
            (
                "pages/(task-workspace)/tasks/components/composer.js",
                b"caffold-task-composer".as_slice(),
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

        let diff_page = get("pages/(review-workspace)/(git)/diff/page.js").expect("diff page js");
        assert_eq!(diff_page.content_type, "text/javascript; charset=utf-8");
        assert!(diff_page.body.starts_with(b"import "));
        assert!(
            diff_page
                .body
                .windows(b"caffold-git-diff-page".len())
                .any(|window| window == b"caffold-git-diff-page")
        );
        let diff_browser = get("components/git-diff-browser.js").expect("git diff browser js");
        assert_eq!(diff_browser.content_type, "text/javascript; charset=utf-8");
        assert!(
            diff_browser
                .body
                .windows(b"caffold-git-diff-browser".len())
                .any(|window| window == b"caffold-git-diff-browser")
        );
        let diff_changes_tree =
            get("components/git-diff-browser/changes-tree.js").expect("diff changes tree js");
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
        assert!(get("pages/(review-workspace)/(git)/working-tree/page.js").is_none());
        assert!(get("components/changes-tree.js").is_none());
        assert!(get("pages/(review-workspace)/(git)/diff/components/changes-tree.js").is_none());

        let github_review_layout =
            get("pages/(review-workspace)/(github)/layout.js").expect("github review layout js");
        assert_eq!(
            github_review_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(github_review_layout.body.starts_with(b"import "));
        assert!(
            github_review_layout
                .body
                .windows(b"caffold-github-review-layout".len())
                .any(|window| window == b"caffold-github-review-layout")
        );
        let github_markdown = get("pages/(review-workspace)/(github)/components/markdown.js")
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
            get("pages/(review-workspace)/(github)/(issues)/layout.js").expect("issues layout js");
        assert_eq!(issues_layout.content_type, "text/javascript; charset=utf-8");
        assert!(issues_layout.body.starts_with(b"import "));
        assert!(
            issues_layout
                .body
                .windows(b"caffold-github-issues-layout".len())
                .any(|window| window == b"caffold-github-issues-layout")
        );

        let issues_list_page = get("pages/(review-workspace)/(github)/(issues)/list/page.js")
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

        let issue_detail_page = get("pages/(review-workspace)/(github)/(issues)/detail/page.js")
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
        assert!(get("components/github-issues-list.js").is_none());
        assert!(get("components/github-issue-viewer.js").is_none());
        assert!(get("components/github-markdown.js").is_none());

        let pulls_layout =
            get("pages/(review-workspace)/(github)/(pulls)/layout.js").expect("pulls layout js");
        assert_eq!(pulls_layout.content_type, "text/javascript; charset=utf-8");
        assert!(pulls_layout.body.starts_with(b"import "));
        assert!(
            pulls_layout
                .body
                .windows(b"caffold-github-pulls-layout".len())
                .any(|window| window == b"caffold-github-pulls-layout")
        );

        let pulls_list_page = get("pages/(review-workspace)/(github)/(pulls)/list/page.js")
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

        let pull_detail_page = get("pages/(review-workspace)/(github)/(pulls)/detail/page.js")
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

        let pull_files_page = get("pages/(review-workspace)/(github)/(pulls)/files/page.js")
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
            get("pages/(review-workspace)/(github)/(pulls)/files/components/tree.js")
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

        let file_list_page = get("pages/files/page.js").expect("files page js asset");
        assert_eq!(
            file_list_page.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(file_list_page.body.starts_with(b"import "));
        assert!(
            file_list_page
                .body
                .windows(b"caffold-files-page".len())
                .any(|window| window == b"caffold-files-page")
        );

        let file_browser_component =
            get("components/file-browser.js").expect("file browser component js asset");
        assert_eq!(
            file_browser_component.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(file_browser_component.body.starts_with(b"import "));
        assert!(
            file_browser_component
                .body
                .windows(b"caffold-file-browser".len())
                .any(|window| window == b"caffold-file-browser")
        );
        let file_browser_css =
            get("components/file-browser.css").expect("file browser component css asset");
        assert_eq!(file_browser_css.content_type, "text/css; charset=utf-8");
        assert!(
            file_browser_css
                .body
                .starts_with(b"@import \"./file-navigator.css\"")
        );

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
                .starts_with(b"@import \"./file-browser/list.css\"")
        );

        let file_list_component =
            get("components/file-browser/list.js").expect("file list component js asset");
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
            get("pages/(review-workspace)/(git)/(log)/layout.js").expect("git log layout js asset");
        assert_eq!(log_layout.content_type, "text/javascript; charset=utf-8");
        assert!(log_layout.body.starts_with(b"import "));
        assert!(
            log_layout
                .body
                .windows(b"caffold-git-log-layout".len())
                .any(|window| window == b"caffold-git-log-layout")
        );
        let log_list_page = get("pages/(review-workspace)/(git)/(log)/list/page.js")
            .expect("log list page js asset");
        assert_eq!(log_list_page.content_type, "text/javascript; charset=utf-8");
        assert!(log_list_page.body.starts_with(b"import "));
        assert!(
            log_list_page
                .body
                .windows(b"caffold-git-log-list-page".len())
                .any(|window| window == b"caffold-git-log-list-page")
        );
        let log_commit_page = get("pages/(review-workspace)/(git)/(log)/commit/page.js")
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
            get("pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.js")
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
        assert!(get("pages/(review-workspace)/(git)/(log)/components/list.js").is_none());
        assert!(get("pages/(review-workspace)/(git)/(log)/components/commit-tree.js").is_none());

        let png = get("icons/icon-192.png").expect("png icon asset");
        assert_eq!(png.content_type, "image/png");
        assert!(png.body.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
