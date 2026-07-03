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
        "pages/app-shell/layout.css" => {
            Some(css(include_str!("../frontend/pages/app-shell/layout.css")))
        }
        "pages/app-shell/layout.js" => {
            Some(js(include_str!("../frontend/pages/app-shell/layout.js")))
        }
        "pages/app-shell/components/pathbar.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/components/pathbar.css"
        ))),
        "pages/app-shell/components/pathbar.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/pathbar.js"
        ))),
        "pages/app-shell/components/project-switcher.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/components/project-switcher.css"
        ))),
        "pages/app-shell/components/project-switcher.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/project-switcher.js"
        ))),
        "pages/app-shell/components/header-actions.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/components/header-actions.css"
        ))),
        "pages/app-shell/components/header-actions.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/header-actions.js"
        ))),
        "pages/app-shell/components/header-actions/codex-status.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/components/header-actions/codex-status.css"
        ))),
        "pages/app-shell/components/header-actions/codex-status.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/header-actions/codex-status.js"
        ))),
        "pages/app-shell/components/header-actions/git-status.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/header-actions/git-status.js"
        ))),
        "pages/app-shell/components/header-actions/github-status.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/header-actions/github-status.js"
        ))),
        "pages/app-shell/components/header-actions/shared.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/components/header-actions/shared.js"
        ))),
        "pages/app-shell/files/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/files/page.css"
        ))),
        "pages/app-shell/files/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/files/page.js"
        ))),
        "pages/app-shell/files/components/list.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/files/components/list.css"
        ))),
        "pages/app-shell/files/components/list.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/files/components/list.js"
        ))),
        "pages/app-shell/review-workspace/layout.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/layout.css"
        ))),
        "pages/app-shell/review-workspace/layout.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/layout.js"
        ))),
        "pages/app-shell/review-workspace/git/layout.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/layout.css"
        ))),
        "pages/app-shell/review-workspace/git/layout.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/layout.js"
        ))),
        "pages/app-shell/review-workspace/git/diff/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/diff/page.css"
        ))),
        "pages/app-shell/review-workspace/git/diff/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/diff/page.js"
        ))),
        "pages/app-shell/review-workspace/git/diff/components/changes-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/diff/components/changes-tree.css"
            )))
        }
        "pages/app-shell/review-workspace/git/diff/components/changes-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/diff/components/changes-tree.js"
            )))
        }
        "pages/app-shell/review-workspace/git/compare/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/compare/page.css"
        ))),
        "pages/app-shell/review-workspace/git/compare/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/compare/page.js"
        ))),
        "pages/app-shell/review-workspace/git/compare/components/compare-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/compare/components/compare-tree.css"
            )))
        }
        "pages/app-shell/review-workspace/git/compare/components/compare-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/compare/components/compare-tree.js"
            )))
        }
        "pages/app-shell/review-workspace/git/log/layout.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/layout.css"
        ))),
        "pages/app-shell/review-workspace/git/log/layout.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/layout.js"
        ))),
        "pages/app-shell/review-workspace/git/log/list/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/list/page.css"
        ))),
        "pages/app-shell/review-workspace/git/log/list/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/list/page.js"
        ))),
        "pages/app-shell/review-workspace/git/log/commit/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/commit/page.css"
        ))),
        "pages/app-shell/review-workspace/git/log/commit/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/git/log/commit/page.js"
        ))),
        "pages/app-shell/review-workspace/git/log/commit/components/changes-tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/log/commit/components/changes-tree.css"
            )))
        }
        "pages/app-shell/review-workspace/git/log/commit/components/changes-tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/app-shell/review-workspace/git/log/commit/components/changes-tree.js"
            )))
        }
        "pages/app-shell/review-workspace/github/issues/layout.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/issues/layout.css"
        ))),
        "pages/app-shell/review-workspace/github/issues/layout.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/issues/layout.js"
        ))),
        "pages/app-shell/review-workspace/github/issues/list/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/issues/list/page.css"
        ))),
        "pages/app-shell/review-workspace/github/issues/list/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/issues/list/page.js"
        ))),
        "pages/app-shell/review-workspace/github/issues/detail/page.css" => {
            Some(css(include_str!(
                "../frontend/pages/app-shell/review-workspace/github/issues/detail/page.css"
            )))
        }
        "pages/app-shell/review-workspace/github/issues/detail/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/issues/detail/page.js"
        ))),
        "pages/app-shell/review-workspace/github/pulls/layout.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/layout.css"
        ))),
        "pages/app-shell/review-workspace/github/pulls/layout.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/layout.js"
        ))),
        "pages/app-shell/review-workspace/github/pulls/list/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/list/page.css"
        ))),
        "pages/app-shell/review-workspace/github/pulls/list/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/list/page.js"
        ))),
        "pages/app-shell/review-workspace/github/pulls/detail/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/detail/page.css"
        ))),
        "pages/app-shell/review-workspace/github/pulls/detail/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/detail/page.js"
        ))),
        "pages/app-shell/review-workspace/github/pulls/files/page.css" => Some(css(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/files/page.css"
        ))),
        "pages/app-shell/review-workspace/github/pulls/files/page.js" => Some(js(include_str!(
            "../frontend/pages/app-shell/review-workspace/github/pulls/files/page.js"
        ))),
        "pages/app-shell/review-workspace/github/pulls/files/components/tree.css" => {
            Some(css(include_str!(
                "../frontend/pages/app-shell/review-workspace/github/pulls/files/components/tree.css"
            )))
        }
        "pages/app-shell/review-workspace/github/pulls/files/components/tree.js" => {
            Some(js(include_str!(
                "../frontend/pages/app-shell/review-workspace/github/pulls/files/components/tree.js"
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
        "components/github-markdown.js" => Some(js(include_str!(
            "../frontend/components/github-markdown.js"
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

        let codex_status_js = get("pages/app-shell/components/header-actions/codex-status.js")
            .expect("codex status js asset");
        assert_eq!(
            codex_status_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(codex_status_js.body.starts_with(b"import "));

        let codex_status_css = get("pages/app-shell/components/header-actions/codex-status.css")
            .expect("codex status css asset");
        assert_eq!(codex_status_css.content_type, "text/css; charset=utf-8");
        assert!(codex_status_css.body.starts_with(b"caffold-header-actions"));

        let git_status_js = get("pages/app-shell/components/header-actions/git-status.js")
            .expect("git status js asset");
        assert_eq!(git_status_js.content_type, "text/javascript; charset=utf-8");
        assert!(git_status_js.body.starts_with(b"import "));

        let github_status_js = get("pages/app-shell/components/header-actions/github-status.js")
            .expect("github status js asset");
        assert_eq!(
            github_status_js.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(github_status_js.body.starts_with(b"import "));

        let header_actions_shared = get("pages/app-shell/components/header-actions/shared.js")
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

        let app_shell_layout = get("pages/app-shell/layout.js").expect("app shell layout js asset");
        assert_eq!(
            app_shell_layout.content_type,
            "text/javascript; charset=utf-8"
        );
        assert!(app_shell_layout.body.starts_with(b"import "));

        let review_workspace_layout_css = get("pages/app-shell/review-workspace/layout.css")
            .expect("review workspace layout css asset");
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
            get("pages/app-shell/review-workspace/git/layout.js").expect("git review layout js");
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

        let compare_page =
            get("pages/app-shell/review-workspace/git/compare/page.js").expect("compare page js");
        assert_eq!(compare_page.content_type, "text/javascript; charset=utf-8");
        assert!(compare_page.body.starts_with(b"import "));
        assert!(
            compare_page
                .body
                .windows(b"caffold-git-compare-page".len())
                .any(|window| window == b"caffold-git-compare-page")
        );
        let compare_tree =
            get("pages/app-shell/review-workspace/git/compare/components/compare-tree.js")
                .expect("compare tree js");
        assert_eq!(compare_tree.content_type, "text/javascript; charset=utf-8");
        assert!(
            compare_tree
                .body
                .windows(b"caffold-git-compare-tree".len())
                .any(|window| window == b"caffold-git-compare-tree")
        );
        assert!(get("components/compare-tree.js").is_none());

        let diff_page =
            get("pages/app-shell/review-workspace/git/diff/page.js").expect("diff page js");
        assert_eq!(diff_page.content_type, "text/javascript; charset=utf-8");
        assert!(diff_page.body.starts_with(b"import "));
        assert!(
            diff_page
                .body
                .windows(b"caffold-git-diff-page".len())
                .any(|window| window == b"caffold-git-diff-page")
        );
        let diff_changes_tree =
            get("pages/app-shell/review-workspace/git/diff/components/changes-tree.js")
                .expect("diff changes tree js");
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
        assert!(get("pages/app-shell/review-workspace/git/working-tree/page.js").is_none());
        assert!(get("components/changes-tree.js").is_none());

        let issues_layout = get("pages/app-shell/review-workspace/github/issues/layout.js")
            .expect("issues layout js");
        assert_eq!(issues_layout.content_type, "text/javascript; charset=utf-8");
        assert!(issues_layout.body.starts_with(b"import "));
        assert!(
            issues_layout
                .body
                .windows(b"caffold-github-issues-layout".len())
                .any(|window| window == b"caffold-github-issues-layout")
        );

        let issues_list_page = get("pages/app-shell/review-workspace/github/issues/list/page.js")
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
            get("pages/app-shell/review-workspace/github/issues/detail/page.js")
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

        let pulls_layout = get("pages/app-shell/review-workspace/github/pulls/layout.js")
            .expect("pulls layout js");
        assert_eq!(pulls_layout.content_type, "text/javascript; charset=utf-8");
        assert!(pulls_layout.body.starts_with(b"import "));
        assert!(
            pulls_layout
                .body
                .windows(b"caffold-github-pulls-layout".len())
                .any(|window| window == b"caffold-github-pulls-layout")
        );

        let pulls_list_page = get("pages/app-shell/review-workspace/github/pulls/list/page.js")
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

        let pull_detail_page = get("pages/app-shell/review-workspace/github/pulls/detail/page.js")
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

        let pull_files_page = get("pages/app-shell/review-workspace/github/pulls/files/page.js")
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
            get("pages/app-shell/review-workspace/github/pulls/files/components/tree.js")
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

        let file_list_page = get("pages/app-shell/files/page.js").expect("files page js asset");
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

        let file_list_component =
            get("pages/app-shell/files/components/list.js").expect("file list component js asset");
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
        let log_layout = get("pages/app-shell/review-workspace/git/log/layout.js")
            .expect("git log layout js asset");
        assert_eq!(log_layout.content_type, "text/javascript; charset=utf-8");
        assert!(log_layout.body.starts_with(b"import "));
        assert!(
            log_layout
                .body
                .windows(b"caffold-git-log-layout".len())
                .any(|window| window == b"caffold-git-log-layout")
        );
        let log_list_page = get("pages/app-shell/review-workspace/git/log/list/page.js")
            .expect("log list page js asset");
        assert_eq!(log_list_page.content_type, "text/javascript; charset=utf-8");
        assert!(log_list_page.body.starts_with(b"import "));
        assert!(
            log_list_page
                .body
                .windows(b"caffold-git-log-list-page".len())
                .any(|window| window == b"caffold-git-log-list-page")
        );
        let log_commit_page = get("pages/app-shell/review-workspace/git/log/commit/page.js")
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
            get("pages/app-shell/review-workspace/git/log/commit/components/changes-tree.js")
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
        assert!(get("pages/app-shell/review-workspace/git/log/components/list.js").is_none());
        assert!(
            get("pages/app-shell/review-workspace/git/log/components/commit-tree.js").is_none()
        );

        let png = get("icons/icon-192.png").expect("png icon asset");
        assert_eq!(png.content_type, "image/png");
        assert!(png.body.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
