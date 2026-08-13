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

const APP_SHELL_ASSETS = [
  "/",
  "/assets/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/app.js",
  "/assets/build-info.js",
  "/assets/api.js",
  "/assets/file-status.js",
  "/assets/fonts.js",
  "/assets/navigation-routes.js",
  "/assets/settings.js",
  "/assets/theme.js",
  "/assets/fonts/D2Coding-Regular.woff2",
  "/assets/fonts/D2Coding-Bold.woff2",
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
  "/assets/pages/layout.css",
  "/assets/pages/layout.js",
  "/assets/pages/components/build-mismatch-alert.css",
  "/assets/pages/components/build-mismatch-alert.js",
  "/assets/pages/components/pwa-update-lifecycle.js",
  "/assets/pages/components/update-dialog.css",
  "/assets/pages/components/update-dialog.js",
  "/assets/components/file-tree.css",
  "/assets/components/file-tree.js",
  "/assets/components/file-navigator.css",
  "/assets/components/file-navigator.js",
  "/assets/components/file-navigator/list.css",
  "/assets/components/file-navigator/list.js",
  "/assets/components/review-panel-resizer.css",
  "/assets/components/review-panel-resizer.js",
  "/assets/components/review-responsive.js",
  "/assets/watch.js",
  "/assets/pages/(task-workspace)/settings/appearance/page.css",
  "/assets/pages/(task-workspace)/settings/appearance/page.js",
  "/assets/pages/(task-workspace)/settings/notifications/page.css",
  "/assets/pages/(task-workspace)/settings/notifications/page.js",
  "/assets/pages/(task-workspace)/settings/notifications/lifecycle.js",
  "/assets/pages/(task-workspace)/layout.css",
  "/assets/pages/(task-workspace)/layout.js",
  "/assets/pages/(task-workspace)/components/navigation.css",
  "/assets/pages/(task-workspace)/components/navigation.js",
  "/assets/pages/(task-workspace)/components/workspace-brand.css",
  "/assets/pages/(task-workspace)/components/workspace-brand.js",
  "/assets/pages/(task-workspace)/codex-status.js",
  "/assets/pages/(task-workspace)/codex-status/model.js",
  "/assets/pages/(task-workspace)/codex-status/lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/runtime-restart-lifecycle.js",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.css",
  "/assets/pages/(task-workspace)/codex-status/components/runtime-restart-dialog.js",
  "/assets/pages/(task-workspace)/settings/layout.css",
  "/assets/pages/(task-workspace)/settings/layout.js",
  "/assets/pages/(task-workspace)/settings/navigator.css",
  "/assets/pages/(task-workspace)/settings/navigator.js",
  "/assets/pages/(task-workspace)/settings/codex/page.css",
  "/assets/pages/(task-workspace)/settings/codex/page.js",
  "/assets/pages/(task-workspace)/settings/about/page.css",
  "/assets/pages/(task-workspace)/settings/about/page.js",
  "/assets/pages/(task-workspace)/tasks/controls.css",
  "/assets/pages/(task-workspace)/tasks/page.css",
  "/assets/pages/(task-workspace)/tasks/page.js",
  "/assets/pages/(task-workspace)/tasks/runtime-state.js",
  "/assets/pages/(task-workspace)/tasks/stream.js",
  "/assets/pages/(task-workspace)/tasks/task-events.js",
  "/assets/pages/(task-workspace)/tasks/task-format.js",
  "/assets/pages/(task-workspace)/tasks/task-list-model.js",
  "/assets/pages/(task-workspace)/tasks/components/composer.css",
  "/assets/pages/(task-workspace)/tasks/components/composer.js",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.css",
  "/assets/pages/(task-workspace)/tasks/components/task-turn-options.js",
  "/assets/pages/(task-workspace)/tasks/components/directory-picker.css",
  "/assets/pages/(task-workspace)/tasks/components/directory-picker.js",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-delete-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/image-preview-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/voice-level-meter.css",
  "/assets/pages/(task-workspace)/tasks/components/voice-level-meter.js",
  "/assets/pages/(task-workspace)/tasks/components/voice-recorder.js",
  "/assets/pages/(task-workspace)/tasks/components/voice-worklet.js",
  "/assets/pages/(task-workspace)/tasks/components/detail.css",
  "/assets/pages/(task-workspace)/tasks/components/detail.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/stream.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/git.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/git.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/github.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/github.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/info.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/summary/info.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/command-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/markdown.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/render.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/work-details.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/conversation/work-details.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/review.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/review.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/review/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/review/changes-tree.js",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/active-task-list.js",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.css",
  "/assets/pages/(task-workspace)/tasks/components/archived-task-list.js",
  "/assets/pages/(task-workspace)/tasks/components/recovery.css",
  "/assets/pages/(task-workspace)/tasks/components/recovery.js",
  "/assets/pages/(task-workspace)/tasks/components/codex-readiness-recovery.css",
  "/assets/pages/(task-workspace)/tasks/components/codex-readiness-recovery.js",
  "/assets/pages/(task-workspace)/tasks/components/navigator.css",
  "/assets/pages/(task-workspace)/tasks/components/navigator.js",
  "/assets/pages/(task-workspace)/tasks/components/task-new.css",
  "/assets/pages/(task-workspace)/tasks/components/task-new.js",
  "/assets/pages/(task-workspace)/tasks/components/task-status.css",
  "/assets/pages/(task-workspace)/tasks/components/task-status.js",
  "/assets/pages/(task-workspace)/tasks/components/task-transport-overlay.css",
  "/assets/pages/(task-workspace)/tasks/components/task-transport-overlay.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/layout.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/layout.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/components/controls.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/components/controls.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/layout.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/(log)/commit/components/changes-tree.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/compare/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(git)/compare/page.js",
  "/assets/components/git-compare-browser.css",
  "/assets/components/git-compare-browser.js",
  "/assets/components/git-compare-browser/compare-tree.css",
  "/assets/components/git-compare-browser/compare-tree.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/layout.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/layout.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/markdown.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-issue.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/components/task-start-dialog/github-pull.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/layout.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(issues)/detail/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/layout.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/list/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/detail/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/page.js",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.css",
  "/assets/pages/(task-workspace)/tasks/components/detail/(github)/(pulls)/files/components/tree.js",
  "/assets/components/code-viewer.css",
  "/assets/components/code-viewer.js",
  "/assets/components/diff-viewer.css",
  "/assets/components/diff-viewer.js",
  "/assets/components/dom.js",
  "/assets/components/file-viewer.css",
  "/assets/components/file-viewer.js",
  "/assets/components/file-viewer-presentation.js",
  "/assets/components/icons.js",
  "/assets/components/pagination.css",
  "/assets/components/pagination.js",
];

const APP_SHELL_ASSET_PATHS = new Set(APP_SHELL_ASSETS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS)),
  );
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
  event.waitUntil(showTerminalNotification(event.data));
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

async function showTerminalNotification(data) {
  const payload = parseTerminalPushPayload(data);
  if (!payload) {
    return;
  }
  const route = taskRoute(payload.threadId);
  if (!route) {
    return;
  }
  const status = terminalStatusCopy(payload.status);
  const title = payload.taskName || "Caffold";
  const body = payload.taskName ? status : `Task ${status.toLowerCase()}`;
  await self.registration.showNotification(title, {
    body,
    tag: payload.tag,
    icon: "/assets/icons/icon-192.png",
    badge: "/assets/icons/favicon-32.png",
    data: { route, threadId: payload.threadId },
  });
}

function parseTerminalPushPayload(data) {
  let payload;
  try {
    payload = data?.json();
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const threadId = typeof payload.threadId === "string" ? payload.threadId : "";
  const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
  const taskName = typeof payload.taskName === "string" && payload.taskName.trim()
    ? [...payload.taskName.trim()].slice(0, 120).join("")
    : "";
  const tag = typeof payload.tag === "string" ? payload.tag : "";
  if (
    !safeTaskId(threadId) ||
    !safeTaskId(turnId) ||
    !["completed", "failed", "interrupted"].includes(payload.status) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(tag) ||
    [...taskName].some((character) => isControlCharacter(character))
  ) {
    return null;
  }
  return { threadId, turnId, status: payload.status, taskName, tag };
}

async function openNotificationRoute(route) {
  const safeRoute = safeNotificationRoute(route);
  if (!safeRoute) {
    return;
  }
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const matching = windows.find((client) => clientShowsTask(client.url, safeRoute));
  if (matching) {
    try {
      await matching.focus();
      return;
    } catch {
      // The client may have closed between enumeration and focus.
    }
  }
  for (const caffoldClient of windows.filter((client) => sameOriginClient(client.url))) {
    try {
      const navigated = await caffoldClient.navigate(safeRoute);
      await (navigated ?? caffoldClient).focus();
      return;
    } catch {
      // Try another Caffold client, then fall back to a new window.
    }
  }
  try {
    await self.clients.openWindow(safeRoute);
  } catch {
    // Notification navigation is best-effort.
  }
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
