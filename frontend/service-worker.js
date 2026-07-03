const CACHE_NAME = "caffold-shell-v10";

const APP_SHELL_ASSETS = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/app.js",
  "/assets/api.js",
  "/assets/navigation-routes.js",
  "/assets/icons/caffold.svg",
  "/assets/icons/caffold-mark.svg",
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
  "/assets/pages/app-shell/layout.css",
  "/assets/pages/app-shell/layout.js",
  "/assets/pages/app-shell/files/page.css",
  "/assets/pages/app-shell/files/page.js",
  "/assets/pages/app-shell/review-workspace/layout.css",
  "/assets/pages/app-shell/review-workspace/layout.js",
  "/assets/pages/app-shell/review-workspace/git/working-tree/page.css",
  "/assets/pages/app-shell/review-workspace/git/working-tree/page.js",
  "/assets/pages/app-shell/review-workspace/git/log/page.css",
  "/assets/pages/app-shell/review-workspace/git/log/page.js",
  "/assets/pages/app-shell/review-workspace/git/compare/page.css",
  "/assets/pages/app-shell/review-workspace/git/compare/page.js",
  "/assets/pages/app-shell/review-workspace/github/issues/layout.css",
  "/assets/pages/app-shell/review-workspace/github/issues/layout.js",
  "/assets/pages/app-shell/review-workspace/github/issues/list/page.css",
  "/assets/pages/app-shell/review-workspace/github/issues/list/page.js",
  "/assets/pages/app-shell/review-workspace/github/issues/detail/page.css",
  "/assets/pages/app-shell/review-workspace/github/issues/detail/page.js",
  "/assets/pages/app-shell/review-workspace/github/pulls/layout.css",
  "/assets/pages/app-shell/review-workspace/github/pulls/layout.js",
  "/assets/pages/app-shell/review-workspace/github/pulls/list/page.css",
  "/assets/pages/app-shell/review-workspace/github/pulls/list/page.js",
  "/assets/pages/app-shell/review-workspace/github/pulls/detail/page.css",
  "/assets/pages/app-shell/review-workspace/github/pulls/detail/page.js",
  "/assets/pages/app-shell/review-workspace/github/pulls/files/page.css",
  "/assets/pages/app-shell/review-workspace/github/pulls/files/page.js",
  "/assets/pages/app-shell/review-workspace/github/pulls/files/components/tree.css",
  "/assets/pages/app-shell/review-workspace/github/pulls/files/components/tree.js",
  "/assets/components/code-viewer.css",
  "/assets/components/code-viewer.js",
  "/assets/components/commit-changes-tree.css",
  "/assets/components/commit-changes-tree.js",
  "/assets/components/diff-viewer.css",
  "/assets/components/diff-viewer.js",
  "/assets/components/dom.js",
  "/assets/components/file-list.css",
  "/assets/components/file-list.js",
  "/assets/components/file-viewer.css",
  "/assets/components/file-viewer.js",
  "/assets/components/github-markdown.js",
  "/assets/components/header-actions.css",
  "/assets/components/header-actions.js",
  "/assets/components/header-actions/codex-status.css",
  "/assets/components/header-actions/codex-status.js",
  "/assets/components/header-actions/git-status.js",
  "/assets/components/header-actions/github-status.js",
  "/assets/components/header-actions/shared.js",
  "/assets/components/icons.js",
  "/assets/components/log-list.css",
  "/assets/components/log-list.js",
  "/assets/components/pagination.css",
  "/assets/components/pagination.js",
  "/assets/components/pathbar.css",
  "/assets/components/pathbar.js",
  "/assets/components/project-switcher.css",
  "/assets/components/project-switcher.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
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
    url.pathname === "/projects" ||
    url.pathname.startsWith("/projects/")
  ) {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(networkFirst(request));
  }
});

async function networkFirst(request, fallbackPath = null) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? (fallbackPath ? caches.match(fallbackPath) : Response.error());
  }
}
