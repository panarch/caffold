const CACHE_NAME = "caffold-shell-v53";

const APP_SHELL_ASSETS = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/app.js",
  "/assets/api.js",
  "/assets/navigation-routes.js",
  "/assets/settings.js",
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
  "/assets/pages/layout.css",
  "/assets/pages/layout.js",
  "/assets/pages/components/app-menu.css",
  "/assets/pages/components/app-menu.js",
  "/assets/pages/components/pathbar.css",
  "/assets/pages/components/pathbar.js",
  "/assets/pages/components/header-actions.css",
  "/assets/pages/components/header-actions.js",
  "/assets/pages/components/header-actions/codex-status.css",
  "/assets/pages/components/header-actions/codex-status.js",
  "/assets/pages/components/header-actions/git-status.js",
  "/assets/pages/components/header-actions/github-status.js",
  "/assets/pages/components/header-actions/shared.js",
  "/assets/components/file-browser.css",
  "/assets/components/file-browser.js",
  "/assets/components/file-browser/list.css",
  "/assets/components/file-browser/list.js",
  "/assets/watch.js",
  "/assets/pages/files/page.css",
  "/assets/pages/files/page.js",
  "/assets/pages/settings/page.css",
  "/assets/pages/settings/page.js",
  "/assets/pages/(codex)/layout.css",
  "/assets/pages/(codex)/layout.js",
  "/assets/pages/(codex)/tasks/page.css",
  "/assets/pages/(codex)/tasks/page.js",
  "/assets/pages/(codex)/tasks/components/markdown.js",
  "/assets/pages/(review-workspace)/layout.css",
  "/assets/pages/(review-workspace)/layout.js",
  "/assets/pages/(review-workspace)/(git)/layout.css",
  "/assets/pages/(review-workspace)/(git)/layout.js",
  "/assets/pages/(review-workspace)/(git)/diff/page.css",
  "/assets/pages/(review-workspace)/(git)/diff/page.js",
  "/assets/components/git-diff-browser.css",
  "/assets/components/git-diff-browser.js",
  "/assets/components/git-diff-browser/changes-tree.css",
  "/assets/components/git-diff-browser/changes-tree.js",
  "/assets/pages/(review-workspace)/(git)/(log)/layout.css",
  "/assets/pages/(review-workspace)/(git)/(log)/layout.js",
  "/assets/pages/(review-workspace)/(git)/(log)/list/page.css",
  "/assets/pages/(review-workspace)/(git)/(log)/list/page.js",
  "/assets/pages/(review-workspace)/(git)/(log)/commit/page.css",
  "/assets/pages/(review-workspace)/(git)/(log)/commit/page.js",
  "/assets/pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.css",
  "/assets/pages/(review-workspace)/(git)/(log)/commit/components/changes-tree.js",
  "/assets/pages/(review-workspace)/(git)/compare/page.css",
  "/assets/pages/(review-workspace)/(git)/compare/page.js",
  "/assets/components/git-compare-browser.css",
  "/assets/components/git-compare-browser.js",
  "/assets/components/git-compare-browser/compare-tree.css",
  "/assets/components/git-compare-browser/compare-tree.js",
  "/assets/pages/(review-workspace)/(github)/layout.css",
  "/assets/pages/(review-workspace)/(github)/layout.js",
  "/assets/pages/(review-workspace)/(github)/components/markdown.js",
  "/assets/pages/(review-workspace)/(github)/(issues)/layout.css",
  "/assets/pages/(review-workspace)/(github)/(issues)/layout.js",
  "/assets/pages/(review-workspace)/(github)/(issues)/list/page.css",
  "/assets/pages/(review-workspace)/(github)/(issues)/list/page.js",
  "/assets/pages/(review-workspace)/(github)/(issues)/detail/page.css",
  "/assets/pages/(review-workspace)/(github)/(issues)/detail/page.js",
  "/assets/pages/(review-workspace)/(github)/(pulls)/layout.css",
  "/assets/pages/(review-workspace)/(github)/(pulls)/layout.js",
  "/assets/pages/(review-workspace)/(github)/(pulls)/list/page.css",
  "/assets/pages/(review-workspace)/(github)/(pulls)/list/page.js",
  "/assets/pages/(review-workspace)/(github)/(pulls)/detail/page.css",
  "/assets/pages/(review-workspace)/(github)/(pulls)/detail/page.js",
  "/assets/pages/(review-workspace)/(github)/(pulls)/files/page.css",
  "/assets/pages/(review-workspace)/(github)/(pulls)/files/page.js",
  "/assets/pages/(review-workspace)/(github)/(pulls)/files/components/tree.css",
  "/assets/pages/(review-workspace)/(github)/(pulls)/files/components/tree.js",
  "/assets/components/code-viewer.css",
  "/assets/components/code-viewer.js",
  "/assets/components/diff-viewer.css",
  "/assets/components/diff-viewer.js",
  "/assets/components/dom.js",
  "/assets/components/file-viewer.css",
  "/assets/components/file-viewer.js",
  "/assets/components/icons.js",
  "/assets/components/pagination.css",
  "/assets/components/pagination.js",
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
    url.pathname === "/settings" ||
    url.pathname === "/tasks" ||
    url.pathname.startsWith("/tasks/") ||
    url.pathname === "/files" ||
    url.pathname === "/git" ||
    url.pathname.startsWith("/git/") ||
    url.pathname === "/github" ||
    url.pathname.startsWith("/github/")
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
