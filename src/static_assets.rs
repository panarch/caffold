pub const INDEX: &str = include_str!("../frontend/index.html");

pub struct StaticAsset {
    pub content_type: &'static str,
    pub body: &'static [u8],
}

pub fn get(path: &str) -> Option<StaticAsset> {
    match path {
        "manifest.webmanifest" => Some(manifest(include_str!("../frontend/manifest.webmanifest"))),
        "service-worker.js" => Some(js(include_str!("../frontend/service-worker.js"))),
        "styles.css" => Some(css(include_str!("../frontend/styles.css"))),
        "app.js" => Some(js(include_str!("../frontend/app.js"))),
        "api.js" => Some(js(include_str!("../frontend/api.js"))),
        "navigation-routes.js" => Some(js(include_str!("../frontend/navigation-routes.js"))),
        "icons/caffold.svg" => Some(svg(include_str!("../frontend/assets/icons/caffold.svg"))),
        "icons/caffold-mark.svg" => Some(svg(include_str!(
            "../frontend/assets/icons/caffold-mark.svg"
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
        "components/header-actions/codex-status.css" => Some(css(include_str!(
            "../frontend/components/header-actions/codex-status.css"
        ))),
        "components/header-actions/codex-status.js" => Some(js(include_str!(
            "../frontend/components/header-actions/codex-status.js"
        ))),
        "components/github-markdown.js" => Some(js(include_str!(
            "../frontend/components/github-markdown.js"
        ))),
        "components/github-issue-viewer.css" => Some(css(include_str!(
            "../frontend/components/github-issue-viewer.css"
        ))),
        "components/github-issue-viewer.js" => Some(js(include_str!(
            "../frontend/components/github-issue-viewer.js"
        ))),
        "components/github-issues-list.css" => Some(css(include_str!(
            "../frontend/components/github-issues-list.css"
        ))),
        "components/github-issues-list.js" => Some(js(include_str!(
            "../frontend/components/github-issues-list.js"
        ))),
        "components/github-pulls-list.css" => Some(css(include_str!(
            "../frontend/components/github-pulls-list.css"
        ))),
        "components/github-pulls-list.js" => Some(js(include_str!(
            "../frontend/components/github-pulls-list.js"
        ))),
        "components/github-pull-viewer.css" => Some(css(include_str!(
            "../frontend/components/github-pull-viewer.css"
        ))),
        "components/github-pull-viewer.js" => Some(js(include_str!(
            "../frontend/components/github-pull-viewer.js"
        ))),
        "components/github-pull-files-tree.css" => Some(css(include_str!(
            "../frontend/components/github-pull-files-tree.css"
        ))),
        "components/github-pull-files-tree.js" => Some(js(include_str!(
            "../frontend/components/github-pull-files-tree.js"
        ))),
        "components/icons.js" => Some(js(include_str!("../frontend/components/icons.js"))),
        "components/log-list.css" => Some(css(include_str!("../frontend/components/log-list.css"))),
        "components/log-list.js" => Some(js(include_str!("../frontend/components/log-list.js"))),
        "components/pagination.css" => {
            Some(css(include_str!("../frontend/components/pagination.css")))
        }
        "components/pagination.js" => {
            Some(js(include_str!("../frontend/components/pagination.js")))
        }
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
        body: body.as_bytes(),
    }
}

fn js(body: &'static str) -> StaticAsset {
    StaticAsset {
        content_type: "text/javascript; charset=utf-8",
        body: body.as_bytes(),
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

        let svg = get("icons/caffold.svg").expect("svg icon asset");
        assert_eq!(svg.content_type, "image/svg+xml");
        assert!(svg.body.starts_with(b"<svg"));

        let mark_svg = get("icons/caffold-mark.svg").expect("svg mark asset");
        assert_eq!(mark_svg.content_type, "image/svg+xml");
        assert!(mark_svg.body.starts_with(b"<svg"));

        let brand_svg = get("brand/github-invertocat-light.svg").expect("brand svg asset");
        assert_eq!(brand_svg.content_type, "image/svg+xml");
        assert!(brand_svg.body.starts_with(b"<svg"));

        let codex_brand = get("brand/codex-template@2x.png").expect("codex brand asset");
        assert_eq!(codex_brand.content_type, "image/png");
        assert!(codex_brand.body.starts_with(b"\x89PNG\r\n\x1a\n"));

        let codex_status_js =
            get("components/header-actions/codex-status.js").expect("codex status js asset");
        assert_eq!(
            codex_status_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(codex_status_js.body.starts_with(b"import "));

        let codex_status_css =
            get("components/header-actions/codex-status.css").expect("codex status css asset");
        assert_eq!(codex_status_css.content_type, "text/css; charset=utf-8");
        assert!(codex_status_css.body.starts_with(b"caffold-header-actions"));

        let png = get("icons/icon-192.png").expect("png icon asset");
        assert_eq!(png.content_type, "image/png");
        assert!(png.body.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
