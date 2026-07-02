const CACHE_NAME = "caffold-shell-v6";

const APP_SHELL_ASSETS = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/app.js",
  "/assets/api.js",
  "/assets/navigation-routes.js",
  "/assets/icons/caffold.svg",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/maskable-192.png",
  "/assets/icons/maskable-512.png",
  "/assets/icons/apple-touch-icon.png",
  "/assets/brand/git-logomark-light.svg",
  "/assets/brand/git-logomark-dark.svg",
  "/assets/brand/github-invertocat-light.svg",
  "/assets/brand/github-invertocat-dark.svg",
  "/assets/components/app-shell.css",
  "/assets/components/app-shell.js",
  "/assets/components/changes-tree.css",
  "/assets/components/changes-tree.js",
  "/assets/components/code-viewer.css",
  "/assets/components/code-viewer.js",
  "/assets/components/commit-changes-tree.css",
  "/assets/components/commit-changes-tree.js",
  "/assets/components/compare-tree.css",
  "/assets/components/compare-tree.js",
  "/assets/components/diff-viewer.css",
  "/assets/components/diff-viewer.js",
  "/assets/components/dom.js",
  "/assets/components/file-list.css",
  "/assets/components/file-list.js",
  "/assets/components/file-viewer.css",
  "/assets/components/file-viewer.js",
  "/assets/components/github-issue-viewer.css",
  "/assets/components/github-issue-viewer.js",
  "/assets/components/github-issues-list.css",
  "/assets/components/github-issues-list.js",
  "/assets/components/github-markdown.js",
  "/assets/components/github-pull-files-tree.css",
  "/assets/components/github-pull-files-tree.js",
  "/assets/components/github-pull-viewer.css",
  "/assets/components/github-pull-viewer.js",
  "/assets/components/github-pulls-list.css",
  "/assets/components/github-pulls-list.js",
  "/assets/components/header-actions.css",
  "/assets/components/header-actions.js",
  "/assets/components/icons.js",
  "/assets/components/log-list.css",
  "/assets/components/log-list.js",
  "/assets/components/pagination.css",
  "/assets/components/pagination.js",
  "/assets/components/pathbar.css",
  "/assets/components/pathbar.js",
  "/assets/components/project-switcher.css",
  "/assets/components/project-switcher.js",
  "/assets/components/review-workspace.css",
  "/assets/components/review-workspace.js",
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
