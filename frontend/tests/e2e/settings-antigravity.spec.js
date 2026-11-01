import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import { captureReviewScreenshot } from "./support/task-fixtures.js";
import {
  activateActionHint,
  actionHintDialog,
  workspaceTargets,
} from "./support/action-hints.js";

const base = () => ({
  runtime: { restarting: false, running: true, pid: 4301, version: "0.7.2", sessions: 2, idleTimeoutSecs: 600, error: null },
  installation: {
    phase: "idle",
    supported: true,
    version: "1.4.5",
    installed: true,
    executable:
      "/Users/server/Library/Application Support/Caffold/data/antigravity/versions/1.4.5/agy_acp_server.par",
    error: null,
  },
  auth: {
    phase: "idle",
    requestId: null,
    authorizationUrl: null,
    verified: null,
    error: null,
  },
  usage: { windows: [], error: null },
  refreshing: false,
  modelsAvailable: false,
  modelsError: null,
});

test(
  "remote Google handoff keeps its job across navigation and exposes keyboard actions",
  { tag: "@all-viewports" },
  async ({ page }, info) => {
    await installBrowserDefaults(page);
    let status = base(),
      actions = [],
      callbacks = [];
    await page.route("**/api/antigravity/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "GET")
        return route.fulfill({ json: status });
      actions.push(path);
      if (path.endsWith("/login"))
        status = {
          ...status,
          auth: {
            ...status.auth,
            phase: "awaitingCallback",
            requestId: "fixture-login",
            authorizationUrl:
              "https://accounts.google.com/o/oauth2/auth?state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F",
          },
        };
      if (path.endsWith("/callback")) {
        callbacks.push(route.request().postDataJSON());
        status = {
          ...status,
          auth: {
            phase: "idle",
            requestId: null,
            authorizationUrl: null,
            verified: {
              authenticated: true,
              tier: { id: "g1-pro-tier", name: "Google AI Pro" },
              verifiedAtMs: 1234,
            },
            error: null,
          },
        };
      }
      if (path.endsWith("/refresh"))
        status = { ...status, modelsAvailable: true };
      return route.fulfill({ json: status });
    });
    await page.goto("/settings/antigravity");
    const owner = page.locator("caffold-settings-antigravity-page");
    await expect(owner).toBeVisible();
    await expect(owner).toContainText("Not checked");
    await expect.poll(() => actions).toEqual(["/api/antigravity/refresh"]);
    await expect(owner.getByRole("link", { name: "Service status" })).toHaveAttribute("href", "https://aistudio.google.com/status");
    await expect(owner.getByRole("button", { name: "Sign out", exact: true })).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Sign in", exact: true })
      .scrollIntoViewIfNeeded();
    await activateActionHint(page, "Sign in");
    await expect(
      owner.getByRole("link", { name: "Continue with Google" }),
    ).toHaveAttribute("target", "_blank");
    await page.goto("/settings/appearance");
    await page.goto("/settings/antigravity");
    await expect(
      owner.getByLabel("Google completion URL", { exact: true }),
    ).toBeVisible();
    await owner
      .getByLabel("Google completion URL", { exact: true })
      .scrollIntoViewIfNeeded();
    const targets = await workspaceTargets(page, "settings:antigravity:");
    expect(targets.map((t) => t[1])).toContain("Google completion URL");
    await captureReviewScreenshot(page, info, "antigravity-remote-login");
    await owner
      .getByLabel("Google completion URL", { exact: true })
      .fill("http://127.0.0.1:43123/?state=fixture&code=fixture-only");
    await owner
      .getByRole("button", { name: "Finish sign-in", exact: true })
      .click();
    await expect(owner).toContainText("Google AI Pro");
    await expect(owner.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(owner.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    expect(callbacks).toEqual([
      {
        requestId: "fixture-login",
        url: "http://127.0.0.1:43123/?state=fixture&code=fixture-only",
      },
    ]);
    expect(actions.filter((a) => a.endsWith("/cancel"))).toEqual([]);
    await owner
      .getByRole("button", { name: "Refresh", exact: true })
      .click();
    await expect(owner).toContainText("Available");
    await captureReviewScreenshot(page, info, "antigravity-settings");
    await expect(owner.locator(".settings-content-scroll")).toHaveJSProperty(
      "scrollWidth",
      await owner
        .locator(".settings-content-scroll")
        .evaluate((e) => e.clientWidth),
    );
  },
);

test(
  "unknown installation inspection and long errors stay unavailable",
  { tag: "@all-viewports" },
  async ({ page }, info) => {
    await installBrowserDefaults(page);
    const status = base();
    status.installation.installed = null;
    status.installation.executable = null;
    status.installation.error =
      "Could not inspect /Users/server/Library/Application Support/" +
      "long-directory/".repeat(15) +
      ": permission denied";
    await page.route("**/api/antigravity/status", (route) =>
      route.fulfill({ json: status }),
    );
    await page.goto("/settings/antigravity");
    const owner = page.locator("caffold-settings-antigravity-page");
    await expect(owner).toContainText("Unavailable");
    await expect(
      owner.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    await captureReviewScreenshot(page, info, "antigravity-inspection-error");
    expect(
      await owner
        .locator(".settings-content-scroll")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
  },
);

test("failed initial inspection retries one refresh and presents structured quota", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let reads = 0;
  const status = base();
  status.auth.verified = { authenticated: true, tier: null, verifiedAtMs: 1 };
  status.usage.windows = [{ group: "Gemini", period: "weekly", percent: 9, resetsAt: "2026-11-07T08:00:00Z" }];
  await page.route("**/api/antigravity/status", route => {
    reads++;
    return reads === 1 ? route.fulfill({ status: 503, json: { error: { message: "Inspection unavailable" } } }) : route.fulfill({ json: status });
  });
  await page.route("**/api/antigravity/refresh", route => route.fulfill({ json: status }));
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  await expect(owner).toContainText("Inspection unavailable");
  await owner.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(owner).toContainText("9% used · resets");
  await expect(owner).toContainText("Signed in");
  await expect(owner.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
});

test("one refresh updates native quota and the official icon uses existing themes", { tag: "@all-viewports" }, async ({ page }, info) => {
  await installBrowserDefaults(page);
  const status = base();
  status.auth.verified = { authenticated: true, tier: { id: "pro", name: "Google AI Pro" }, verifiedAtMs: 1 };
  status.modelsAvailable = true;
  status.usage.windows = [
    { group: "Gemini", period: "weekly", percent: 9, resetsAt: "2026-11-07T08:50:00Z" },
    { group: "Gemini", period: "fiveHours", percent: 3, resetsAt: "2026-11-01T08:24:00Z" },
    { group: "Claude / GPT", period: "weekly", percent: 0, resetsAt: "2026-11-08T05:30:00Z" },
    { group: "Claude / GPT", period: "fiveHours", percent: 0, resetsAt: "2026-11-01T10:30:00Z" },
    { group: "Gemini 4 Argon", period: "weekly", percent: 1, resetsAt: "2026-11-07T03:18:00Z" },
  ];
  const actions = [];
  await page.route("**/api/antigravity/**", route => {
    if (route.request().method() === "POST") actions.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: status });
  });
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  await expect(owner.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh"]);
  await expect(owner.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await activateActionHint(page, "Refresh");
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh", "/api/antigravity/refresh"]);
  const quota = owner.locator('section[aria-labelledby="agy-usage-title"]');
  await expect(quota.locator("dl > div")).toHaveCount(5);
  await expect(quota).toContainText("Gemini · 5 hours");
  await expect(quota).toContainText("Claude / GPT · Weekly");
  await expect(quota).toContainText("9% used · resets");
  await expect(quota).not.toContainText("Remaining");
  await expect(quota).not.toContainText("**");
  const icon = page.locator('img[src="/assets/brand/antigravity-icon.svg"]');
  await expect(icon).toHaveJSProperty("naturalWidth", 180);
  const filters = [];
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    filters.push(await icon.evaluate(element => getComputedStyle(element).filter));
    await captureReviewScreenshot(page, info, `antigravity-quota-${colorScheme}`);
    expect(await owner.locator(".settings-content-scroll").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(filters[0]).not.toEqual(filters[1]);
});

test("refresh requiring login offers explicit sign-in and preserves a running refresh across navigation", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let status = base();
  let finishRefresh;
  const held = new Promise(resolve => { finishRefresh = resolve; });
  const actions = [];
  await page.route("**/api/antigravity/**", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: status });
    const path = new URL(route.request().url()).pathname;
    actions.push(path);
    if (path.endsWith("/refresh")) {
      status = { ...status, refreshing: true };
      await held;
      return route.fulfill({ json: status });
    }
    return route.fulfill({ json: status });
  });
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh"]);
  await page.goto("/settings/appearance");
  await page.goto("/settings/antigravity");
  await expect(owner.getByRole("button", { name: /Refresh/ })).toBeDisabled();
  status = { ...status, refreshing: false, auth: { ...status.auth, verified: { authenticated: false, tier: null, verifiedAtMs: 2 } }, usage: { windows: [], error: "Sign in to Antigravity in Settings" }, modelsError: "Sign in to Antigravity in Settings" };
  finishRefresh();
  await expect(owner).toContainText("Signed out");
  await expect(owner.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(owner.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh"]);
});

test("entry refreshes once and only a new activation refreshes again", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await page.clock.install();
  let refreshes = 0;
  const status = base();
  await page.route("**/api/antigravity/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/refresh")) {
      refreshes++;
      status.usage.windows = [{ group: "Gemini", period: "weekly", percent: refreshes, resetsAt: "2026-11-07T08:00:00Z" }];
    }
    return route.fulfill({ json: status });
  });
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  await expect(owner).toContainText("1% used");
  await owner.evaluate(async element => {
    element.activate();
    await element.reconcile();
  });
  await page.clock.runFor(60000);
  expect(refreshes).toBe(1);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(owner).not.toBeVisible();
  await page.getByRole("button", { name: "Antigravity", exact: true }).click();
  await expect(owner).toContainText("2% used");
  expect(refreshes).toBe(2);
});

test("leaving during the entry inspection cannot start a late refresh", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let release;
  const inspection = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const actions = [];
  await page.route("**/api/antigravity/**", async route => {
    if (route.request().method() === "GET") {
      reads++;
      await inspection;
    } else actions.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: base() });
  });
  await page.goto("/settings/antigravity");
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.locator("caffold-settings-antigravity-page")).not.toBeVisible();
  release();
  await page.getByRole("button", { name: "Antigravity", exact: true }).click();
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh"]);
  expect(reads).toBe(2);
});

for (const installation of [
  { installed: false, phase: "idle", label: "Not installed" },
  { installed: true, phase: "downloading", label: "Downloading…" },
]) {
  test(`entry does not refresh while installation is ${installation.label}`, { tag: "@viewport-independent" }, async ({ page }) => {
    await installBrowserDefaults(page);
    await page.clock.install();
    const status = base();
    Object.assign(status.installation, { installed: installation.installed, phase: installation.phase });
    const actions = [];
    await page.route("**/api/antigravity/**", route => {
      if (route.request().method() !== "GET") actions.push(new URL(route.request().url()).pathname);
      return route.fulfill({ json: status });
    });
    await page.goto("/settings/antigravity");
    await expect(page.locator("caffold-settings-antigravity-page")).toContainText(installation.label);
    await page.clock.runFor(5000);
    expect(actions).toEqual([]);
  });
}

test("keeps AGY Settings gutters and header alignment consistent with the other agents", { tag: "@all-viewports" }, async ({ page }, info) => {
  await installBrowserDefaults(page);
  await page.route("**/api/antigravity/**", route => route.fulfill({ json: base() }));
  const layouts = [];
  for (const name of ["codex", "claude", "grok", "antigravity"]) {
    await page.goto(`/settings/${name}`);
    const owner = page.locator(`caffold-settings-${name}-page`);
    await expect(owner.locator(".settings-content-section > header")).toBeVisible();
    await expect(owner.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    layouts.push(await owner.locator(".settings-content-scroll").evaluate(scroll => {
      const rect = element => element.getBoundingClientRect();
      const section = scroll.querySelector(".settings-content-section");
      const header = section.querySelector("header");
      const text = header.querySelector("div");
      const refresh = header.querySelector("caffold-settings-refresh-button");
      const style = getComputedStyle(scroll);
      return {
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        left: rect(section).left - rect(scroll).left,
        right: rect(scroll).right - rect(section).right,
        descriptionInset: rect(text).left - rect(section).left,
        stacked: rect(refresh).top >= rect(text).bottom - 1,
        refreshInset: rect(refresh).left - rect(section).left,
        overflow: scroll.scrollWidth > scroll.clientWidth,
      };
    }));
    await captureReviewScreenshot(page, info, `settings-${name}-gutters`);
  }
  await info.attach("settings-gutters", { body: JSON.stringify(layouts, null, 2), contentType: "application/json" });
  for (const layout of layouts) {
    expect(layout.padding).toEqual(layouts[0].padding);
    expect(layout.left).toBeCloseTo(layouts[0].left, 1);
    expect(layout.right).toBeCloseTo(layouts[0].right, 1);
    expect(layout.descriptionInset).toBeCloseTo(0, 1);
    if (layout.stacked) expect(layout.refreshInset).toBeCloseTo(0, 1);
    expect(layout.overflow).toBe(false);
  }
});

test("AGY runtime matches Claude and confirms restart through the modal keyboard scope", { tag: "@all-viewports" }, async ({ page }, info) => {
  await installBrowserDefaults(page);
  let status = base();
  status.runtime.version = `0.7.2-${"runtime-build-".repeat(8)}`;
  const actions = [];
  await page.route("**/api/antigravity/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") actions.push(path);
    if (path.endsWith("/restart")) status = { ...status, runtime: { ...status.runtime, pid: 4302, sessions: 0 } };
    return route.fulfill({ json: status });
  });
  const layouts = [];
  for (const agent of ["claude", "antigravity"]) {
    await page.goto(`/settings/${agent}`);
    const card = page.locator(`caffold-settings-${agent}-page caffold-settings-runtime`);
    await expect(card.getByRole("button", { name: "Restart runtime" })).toBeEnabled();
    await card.scrollIntoViewIfNeeded();
    layouts.push(await card.evaluate(element => {
      const root = element.shadowRoot;
      const box = root.querySelector(".settings-runtime-control");
      const button = root.querySelector("button");
      const style = getComputedStyle(box);
      const text = getComputedStyle(root.querySelector("p"));
      return { padding: style.padding, border: style.border, text: text.fontSize,
        buttonHeight: button.getBoundingClientRect().height,
        overflow: box.scrollWidth > box.clientWidth,
        buttonInside: button.getBoundingClientRect().right <= box.getBoundingClientRect().right };
    }));
  }
  expect(layouts[1]).toEqual(layouts[0]);
  expect(layouts[1].overflow).toBe(false);
  expect(layouts[1].buttonInside).toBe(true);
  const owner = page.locator("caffold-settings-antigravity-page");
  await expect(owner).toContainText("Running · pid 4301");
  await expect(owner).toContainText("10 min");
  await captureReviewScreenshot(page, info, "antigravity-runtime");
  await activateActionHint(page, /Restart runtime$/);
  const dialog = page.getByRole("dialog", { name: "Restart Antigravity runtime?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(actions).toEqual(["/api/antigravity/refresh"]);
  const restart = owner.getByRole("button", { name: "Restart runtime", exact: true });
  await expect(restart).toBeFocused();
  await restart.click();
  await page.keyboard.press("f");
  const hint = actionHintDialog(page);
  const confirm = hint.getByRole("button", { name: / — Restart Antigravity$/ });
  await expect(confirm).toBeVisible();
  const code = await confirm.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());
  await expect(owner).toContainText("Antigravity runner restarted.");
  await expect(owner).toContainText("Running · pid 4302");
  await expect(restart).toBeEnabled();
  expect(actions).toEqual(["/api/antigravity/refresh", "/api/antigravity/restart"]);
});

test("AGY runtime failure stays actionable without claiming a replacement", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await page.route("**/api/antigravity/**", route => new URL(route.request().url()).pathname.endsWith("/restart")
    ? route.fulfill({ status: 409, json: { error: { code: "antigravity_action_failed", message: "wait for the authentication action to finish" } } })
    : route.fulfill({ json: base() }));
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  const restart = owner.getByRole("button", { name: "Restart runtime" });
  await expect(restart).toBeEnabled();
  await restart.click();
  await page.getByRole("dialog", { name: "Restart Antigravity runtime?" }).getByRole("button", { name: "Restart Antigravity" }).click();
  await expect(owner).toContainText("wait for the authentication action to finish");
  await expect(owner).toContainText("Running · pid 4301");
  await expect(owner).not.toContainText("runner restarted.");
  await expect(restart).toBeEnabled();
});

test("AGY observes an accepted restart across navigation without another quota refresh or stale completion", { tag: "@viewport-independent" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await page.clock.install();
  let status = base();
  const actions = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route("**/api/antigravity/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") actions.push(path);
    if (path.endsWith("/restart")) {
      const response = { ...status, runtime: { ...status.runtime, pid: 4302, sessions: 0 } };
      status = { ...status, runtime: { ...status.runtime, restarting: true } };
      await pending;
      return route.fulfill({ json: response });
    }
    return route.fulfill({ json: status });
  });
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  const restart = owner.getByRole("button", { name: /^Restart/ });
  await expect(restart).toBeEnabled();
  await restart.click();
  await page.getByRole("dialog", { name: "Restart Antigravity runtime?" }).getByRole("button", { name: "Restart Antigravity" }).click();
  await expect.poll(() => actions).toEqual(["/api/antigravity/refresh", "/api/antigravity/restart"]);
  await expect(restart).toBeDisabled();
  const nav = page.locator('nav[aria-label="Settings sections"]');
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(owner).toBeHidden();
  await nav.getByRole("button", { name: "Antigravity", exact: true }).click();
  await expect(owner.getByRole("button", { name: "Restarting…" })).toBeDisabled();
  await expect(owner.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  // A newer backend observation wins over the old page request's result.
  status = { ...status, runtime: { ...status.runtime, restarting: false, pid: 4400, sessions: 0 } };
  await page.clock.runFor(1000);
  await expect(owner).toContainText("Running · pid 4400");
  const completion = page.waitForResponse(response => new URL(response.url()).pathname === "/api/antigravity/restart");
  release();
  await (await completion).finished();
  await expect(restart).toBeEnabled();
  await page.clock.runFor(5000);
  await expect(owner).toContainText("Running · pid 4400");
  await expect(owner).not.toContainText("runner restarted.");
  expect(actions).toEqual(["/api/antigravity/refresh", "/api/antigravity/restart"]);
});

test("AGY runtime inspection errors remain distinct from a stopped runner", { tag: "@all-viewports" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let status = base();
  const problem = `Permission denied reading /Users/server/${"long-directory-name/".repeat(18)}runner.sock`;
  status.runtime = { ...status.runtime, running: null, pid: null, error: problem };
  await page.route("**/api/antigravity/**", route => route.fulfill({ json: status }));
  await page.goto("/settings/antigravity");
  const owner = page.locator("caffold-settings-antigravity-page");
  const card = owner.locator("caffold-settings-runtime");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toContainText(`Unavailable — ${problem}`);
  await expect(card).not.toContainText("Not running");
  expect(await owner.locator(".settings-content-scroll").evaluate(scroll => scroll.scrollWidth > scroll.clientWidth)).toBe(false);
  status = { ...status, runtime: { ...status.runtime, running: false, error: null } };
  await owner.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card).toContainText("Not running");
  await expect(card).not.toContainText("Unavailable");
});
