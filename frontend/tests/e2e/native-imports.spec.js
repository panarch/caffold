import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { installTaskLoopFixture } from "./support/task-loop-fixture.js";

const installedLitHtml = JSON.parse(
  readFileSync(new URL("../../node_modules/lit-html/package.json", import.meta.url), "utf8"),
).version;

test("native import aliases share module identity with asset URLs and register their consumers", { tag: "@viewport-independent" }, async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installBrowserDefaults(page);
  await installTaskLoopFixture(page);
  await page.goto("/");
  await expect(page.locator("caffold-tasks-page")).toHaveAttribute("data-tasks-view", "home");

  const result = await page.evaluate(async () => {
    const modules = [
      ["#app/api.js", "/assets/api.js"],
      ["#app/scoped-style.js", "/assets/scoped-style.js"],
      ["#components/dom.js", "/assets/components/dom.js"],
      ["#tasks/task-format.js", "/assets/pages/(task-workspace)/tasks/task-format.js"],
    ];
    const identities = await Promise.all(modules.map(async ([alias, url]) => {
      const [aliased, direct] = await Promise.all([import(alias), import(url)]);
      return { alias, sameModule: aliased === direct };
    }));
    const consumers = [
      ["#tasks/components/task-create/components/directory-field.js", "caffold-task-directory-field"],
      ["#tasks/(detail)/(section)/components/conversation-shortcuts/components/fork-dialog.js", "caffold-conversation-fork-dialog"],
      ["#tasks/(detail)/(github)/components/task-start-dialog.js", "caffold-github-task-start-dialog"],
    ];
    const registrations = await Promise.all(consumers.map(async ([alias, tag]) => {
      await import(alias);
      return { tag, registered: Boolean(customElements.get(tag)) };
    }));
    return { identities, registrations };
  });

  expect(result.identities).toEqual([
    { alias: "#app/api.js", sameModule: true },
    { alias: "#app/scoped-style.js", sameModule: true },
    { alias: "#components/dom.js", sameModule: true },
    { alias: "#tasks/task-format.js", sameModule: true },
  ]);
  expect(result.registrations.every(({ registered }) => registered)).toBe(true);
  expect(errors).toEqual([]);
});

test("Lit loads by its package name, one module per package, served and precached by Caffold", { tag: "@viewport-independent" }, async ({ page }) => {
  const errors = [];
  const litRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/(?:lit|lit-html|lit-element|@lit)\//.test(new URL(request.url()).pathname)) {
      litRequests.push(new URL(request.url()));
    }
  });
  await installBrowserDefaults(page);
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();

  const result = await page.evaluate(async () => {
    const [named, direct, directive] = await Promise.all([
      import("lit"),
      import("/assets/lit/index.js"),
      import("lit/directives/unsafe-html.js"),
    ]);
    await navigator.serviceWorker.ready;
    const shell = (await caches.keys()).find((name) => name.startsWith("caffold-shell-"));
    const cache = await caches.open(shell);
    const precached = await Promise.all([
      "/assets/lit/index.js",
      "/assets/lit-html/lit-html.js",
      "/assets/lit-element/lit-element.js",
      "/assets/@lit/reactive-element/reactive-element.js",
    ].map(async (path) => Boolean(await cache.match(path))));
    return {
      sameModule: named === direct,
      litElement: typeof named.LitElement,
      directive: typeof directive.unsafeHTML,
      versions: globalThis.litHtmlVersions,
      precached,
    };
  });

  expect(result).toEqual({
    sameModule: true,
    litElement: "function",
    directive: "function",
    versions: [installedLitHtml],
    precached: [true, true, true, true],
  });
  const origin = new URL(page.url()).origin;
  expect(litRequests.length).toBeGreaterThan(0);
  expect(litRequests.every((url) => url.origin === origin && url.pathname.startsWith("/assets/"))).toBe(true);
  expect(errors).toEqual([]);
});

test("compiled modules take their helpers from tslib, served and precached by Caffold", { tag: "@viewport-independent" }, async ({ page }) => {
  const errors = [];
  const tslibRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/assets/tslib/")) {
      tslibRequests.push(new URL(request.url()));
    }
  });
  await installBrowserDefaults(page);
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();

  const result = await page.evaluate(async () => {
    const [named, direct] = await Promise.all([
      import("tslib"),
      import("/assets/tslib/tslib.es6.mjs"),
    ]);
    await navigator.serviceWorker.ready;
    const shell = (await caches.keys()).find((name) => name.startsWith("caffold-shell-"));
    const cache = await caches.open(shell);
    return {
      sameModule: named === direct,
      helper: typeof named.__esDecorate,
      precached: Boolean(await cache.match("/assets/tslib/tslib.es6.mjs")),
    };
  });

  expect(result).toEqual({ sameModule: true, helper: "function", precached: true });
  const origin = new URL(page.url()).origin;
  expect(tslibRequests.length).toBeGreaterThan(0);
  expect(tslibRequests.every((url) => url.origin === origin)).toBe(true);
  expect(errors).toEqual([]);
});

test("TypeScript modules are served as the JavaScript tsc writes, with source maps outside the shell cache", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await page.goto("/");
  await expect(page.locator("caffold-task-workspace")).toBeVisible();

  const result = await page.evaluate(async () => {
    const [response, mapResponse, sourcePath] = await Promise.all([
      fetch("/assets/components/pagination.js"),
      fetch("/assets/components/pagination.js.map"),
      fetch("/assets/components/pagination.ts"),
    ]);
    const source = await response.text();
    const map = await mapResponse.json();
    await customElements.whenDefined("caffold-pagination");
    await navigator.serviceWorker.ready;
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      defined: source.includes('customElement("caffold-pagination")'),
      typed: /@property\(|firstLabel: string/.test(source),
      mapUrl: source.endsWith("//# sourceMappingURL=pagination.js.map"),
      registered: Boolean(customElements.get("caffold-pagination")),
      map: {
        status: mapResponse.status,
        contentType: mapResponse.headers.get("content-type"),
        source: `${map.sourceRoot}${map.sources[0]}`,
        typed: /@property\(/.test(map.sourcesContent[0]),
        precached: Boolean(await caches.match("/assets/components/pagination.js.map")),
      },
      sourcePathStatus: sourcePath.status,
    };
  });

  expect(result).toEqual({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    defined: true,
    typed: false,
    mapUrl: true,
    registered: true,
    map: {
      status: 200,
      contentType: "application/json; charset=utf-8",
      source: "/assets/components/pagination.ts",
      typed: true,
      precached: false,
    },
    sourcePathStatus: 404,
  });
});
