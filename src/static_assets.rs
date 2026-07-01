pub const INDEX: &str = include_str!("../frontend/index.html");

pub struct StaticAsset {
    pub content_type: &'static str,
    pub body: &'static str,
}

pub fn get(path: &str) -> Option<StaticAsset> {
    match path {
        "styles.css" => Some(css(include_str!("../frontend/styles.css"))),
        "app.js" => Some(js(include_str!("../frontend/app.js"))),
        "api.js" => Some(js(include_str!("../frontend/api.js"))),
        "components/app-shell.css" => {
            Some(css(include_str!("../frontend/components/app-shell.css")))
        }
        "components/app-shell.js" => Some(js(include_str!("../frontend/components/app-shell.js"))),
        "components/changes-tree.css" => {
            Some(css(include_str!("../frontend/components/changes-tree.css")))
        }
        "components/changes-tree.js" => {
            Some(js(include_str!("../frontend/components/changes-tree.js")))
        }
        "components/commit-changes-tree.css" => Some(css(include_str!(
            "../frontend/components/commit-changes-tree.css"
        ))),
        "components/commit-changes-tree.js" => Some(js(include_str!(
            "../frontend/components/commit-changes-tree.js"
        ))),
        "components/compare-tree.css" => {
            Some(css(include_str!("../frontend/components/compare-tree.css")))
        }
        "components/compare-tree.js" => {
            Some(js(include_str!("../frontend/components/compare-tree.js")))
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
        "components/file-list.css" => {
            Some(css(include_str!("../frontend/components/file-list.css")))
        }
        "components/file-list.js" => Some(js(include_str!("../frontend/components/file-list.js"))),
        "components/file-viewer.css" => {
            Some(css(include_str!("../frontend/components/file-viewer.css")))
        }
        "components/file-viewer.js" => {
            Some(js(include_str!("../frontend/components/file-viewer.js")))
        }
        "components/header-actions.css" => Some(css(include_str!(
            "../frontend/components/header-actions.css"
        ))),
        "components/header-actions.js" => {
            Some(js(include_str!("../frontend/components/header-actions.js")))
        }
        "components/icons.js" => Some(js(include_str!("../frontend/components/icons.js"))),
        "components/log-list.css" => Some(css(include_str!("../frontend/components/log-list.css"))),
        "components/log-list.js" => Some(js(include_str!("../frontend/components/log-list.js"))),
        "components/pathbar.css" => Some(css(include_str!("../frontend/components/pathbar.css"))),
        "components/pathbar.js" => Some(js(include_str!("../frontend/components/pathbar.js"))),
        "components/project-switcher.css" => Some(css(include_str!(
            "../frontend/components/project-switcher.css"
        ))),
        "components/project-switcher.js" => Some(js(include_str!(
            "../frontend/components/project-switcher.js"
        ))),
        "components/review-workspace.css" => Some(css(include_str!(
            "../frontend/components/review-workspace.css"
        ))),
        "components/review-workspace.js" => Some(js(include_str!(
            "../frontend/components/review-workspace.js"
        ))),
        _ => None,
    }
}

fn css(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/css; charset=utf-8",
        body,
    }
}

fn js(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/javascript; charset=utf-8",
        body,
    }
}
