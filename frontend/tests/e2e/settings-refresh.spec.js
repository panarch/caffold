import { expect, test } from "@playwright/test";
import {
  installBrowserDefaults,
  mockClaudeStatus,
  mockCodexStatus,
  mockGrokStatus,
  mockCaffoldUpdate,
} from "./support/browser-defaults.js";
import { activeTaskProjection, installEventSourceMock, mockAgentModels } from "./support/task-fixtures.js";

const reports = [
  ["claude", "/api/claude/status", mockClaudeStatus],
  ["codex", "/api/codex/status", mockCodexStatus],
  ["grok", "/api/grok/status", mockGrokStatus],
  ["about", "/api/caffold/update", mockCaffoldUpdate],
];

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
  await installEventSourceMock(page, { autoOpen: true });
  await page.route(/\/api\/tasks(?:\?|$)/, route => route.fulfill({ json: activeTaskProjection([]) }));
});

for (const [section, endpoint, report] of reports) {
  test(`${section} stops while hidden and reads again even after a short return`, { tag: "@viewport-independent" }, async ({ page }) => {
    let reads = 0;
    await page.addInitScript(() => {
      window.settingsVisibility = "visible";
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.settingsVisibility });
    });
    await page.route(`**${endpoint}`, route => {
      const json = report();
      const version = `99.0.${++reads}`;
      if (section === "about") json.version = version;
      else if (section === "codex") json.readiness.runningAppServerVersion = version;
      else json.executable.version = version;
      return route.fulfill({ json });
    });
    await page.clock.install();
    await page.goto(`/settings/${section}`);
    const settings = page.locator(`caffold-settings-${section}-page`);
    await expect(page.locator("caffold-app-shell")).toHaveAttribute("data-foreground-recovery-trigger", "bootstrap");
    await expect(settings).toContainText(`99.0.${reads}`);
    const before = reads;
    for (const hiddenTime of [120_000, 1_000]) {
      await page.evaluate(() => {
        window.settingsVisibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const hidden = reads;
      await page.clock.runFor(hiddenTime);
      expect(reads).toBe(hidden);
      await page.evaluate(() => {
        window.settingsVisibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(settings).toContainText(`99.0.${hidden + 1}`);
      expect(reads).toBe(hidden + 1);
    }
    expect(reads).toBe(before + 2);
  });

  test(`${section} stays idle while visible and refreshes after Tasks, Notes and reconnection`, { tag: "@viewport-independent" }, async ({ page }) => {
    let reads = 0;
    let expensiveChecks = 0;
    await page.route(`**${endpoint}`, route => {
      const json = report();
      const version = `99.0.${++reads}`;
      if (section === "about") json.version = version;
      else if (section === "codex") json.readiness.runningAppServerVersion = version;
      else json.executable.version = version;
      return route.fulfill({ json });
    });
    await page.route("**/api/codex/updates", async route => {
      expensiveChecks += 1;
      await route.fallback();
    });
    await page.route("**/api/caffold/update/check", route => {
      expensiveChecks += 1;
      return route.fulfill({ json: mockCaffoldUpdate() });
    });
    await page.clock.install();
    await page.goto(`/settings/${section}`);
    const settings = page.locator(`caffold-settings-${section}-page`);
    await expect(page.locator("caffold-app-shell")).toHaveAttribute("data-foreground-recovery-trigger", "bootstrap");
    await expect(settings).toContainText(`99.0.${reads}`);
    const initial = reads;
    const initialExpensive = expensiveChecks;
    await page.clock.runFor(120_001);
    await expect(settings).toContainText(`99.0.${initial}`);
    expect(reads).toBe(initial);
    expect(expensiveChecks).toBe(initialExpensive);

    for (const mode of ["tasks", "notes"]) {
      await page.locator(`caffold-task-workspace-navigation button[data-workspace-mode="${mode}"]`).click();
      await expect(settings).toBeHidden();
      const away = reads;
      await page.clock.runFor(60_001);
      expect(reads).toBe(away);
      await page.locator('caffold-task-workspace-navigation button[data-workspace-mode="settings"]').click();
      await expect(settings).toBeVisible();
      await expect(settings).toContainText(`99.0.${away + 1}`);
      expect(reads).toBe(away + 1);
    }
    const beforeDisconnect = reads;
    await page.locator("caffold-app-shell").evaluate(shell => {
      window.detachedSettingsShell = shell;
      shell.remove();
    });
    await page.clock.runFor(60_001);
    expect(reads).toBe(beforeDisconnect);
    await page.evaluate(() => document.body.append(window.detachedSettingsShell));
    await expect(settings).toContainText(`99.0.${beforeDisconnect + 1}`);
    expect(reads).toBe(beforeDisconnect + 1);
  });
}

test("a Codex foreground refresh preserves the page's rows, focus, selection and scroll", { tag: "@all-viewports" }, async ({ page }) => {
  let reads = 0;
  await page.addInitScript(() => {
    window.settingsVisibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.settingsVisibility });
  });
  await page.route("**/api/codex/status", route => {
    reads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.goto("/settings/codex");
  const settings = page.locator("caffold-settings-codex-page");
  await expect(page.locator("caffold-app-shell")).toHaveAttribute("data-foreground-recovery-trigger", "bootstrap");
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  const initial = reads;
  const before = await settings.evaluate(element => {
    const root = element.shadowRoot;
    const row = root.querySelector("caffold-settings-detail-list").shadowRoot.querySelector("dd");
    const focus = root.querySelector("a.settings-service-status");
    const scroll = root.querySelector(".settings-content-scroll");
    focus.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(row);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    scroll.scrollTop = scroll.scrollHeight;
    window.settingsRetainedNodes = { row, focus, scroll };
    return { scrollTop: scroll.scrollTop, selection: selection.toString() };
  });
  expect(before.scrollTop).toBeGreaterThan(0);
  expect(before.selection.length).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.settingsVisibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    window.settingsVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reads).toBe(initial + 1);
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  const after = await settings.evaluate(element => {
    const { row, focus, scroll } = window.settingsRetainedNodes;
    return {
      connected: row.isConnected && focus.isConnected && scroll.isConnected,
      focused: element.shadowRoot.activeElement === focus,
      scrollTop: scroll.scrollTop,
      selection: window.getSelection().toString(),
    };
  });
  expect(after).toEqual({ ...before, connected: true, focused: true });
});

test("a failed manual Codex refresh cannot authorize runtime actions from retained readiness", { tag: "@viewport-independent" }, async ({ page }) => {
  let reads = 0;
  await page.route("**/api/codex/status", route => {
    reads += 1;
    return reads === 2
      ? route.fulfill({ status: 503, json: { error: "Status unavailable" } })
      : route.fulfill({ json: mockCodexStatus() });
  });
  await page.goto("/settings/codex");
  const settings = page.locator("caffold-settings-codex-page");
  const restart = settings.getByRole("button", { name: "Restart runtime…", exact: true });
  await expect(restart).toBeEnabled();
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(settings).toContainText("Status unavailable");
  await expect(restart).toBeDisabled();
  await expect(settings.getByRole("button", { name: "Update Codex…", exact: true })).toBeDisabled();
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(restart).toBeEnabled();
  expect(reads).toBe(3);
});

test("a Codex restart completed while hidden requires a fresh report on immediate return", { tag: "@viewport-independent" }, async ({ page }) => {
  let reads = 0;
  let release;
  const restarted = new Promise(resolve => { release = resolve; });
  await page.addInitScript(() => {
    window.settingsVisibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.settingsVisibility });
  });
  await page.route("**/api/codex/status", route => {
    reads += 1;
    return route.fulfill({ json: mockCodexStatus() });
  });
  await page.route("**/api/codex/restart", async route => {
    await restarted;
    return route.fulfill({ json: { status: "restarted" } });
  });
  await page.goto("/settings/codex");
  const settings = page.locator("caffold-settings-codex-page");
  await expect(page.locator("caffold-app-shell")).toHaveAttribute("data-foreground-recovery-trigger", "bootstrap");
  await settings.getByRole("button", { name: "Restart runtime…", exact: true }).click();
  await page.getByRole("dialog", { name: "Restart Codex runtime?" }).getByRole("button", { name: "Restart Codex", exact: true }).click();
  await expect.poll(() => settings.evaluate(element => element.runtimeAction)).toBe("restarting");
  await page.evaluate(() => {
    window.settingsVisibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => settings.evaluate(element => element.active)).toBe(false);
  release();
  await expect.poll(() => settings.evaluate(element => element.runtimeAction)).toBe("idle");
  expect(reads).toBe(1);
  await page.evaluate(() => {
    window.settingsVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => reads).toBe(2);
  await expect(settings.getByRole("button", { name: "Restart runtime…", exact: true })).toBeEnabled();
});

test("Claude rejects a response superseded by re-entry and retries a failure on manual Refresh", { tag: "@viewport-independent" }, async ({ page }) => {
  let reads = 0;
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  await page.route("**/api/claude/status", async route => {
    const read = ++reads;
    if (read === 2) await slow;
    if (read === 4) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    return route.fulfill({ json: mockClaudeStatus({ executable: { version: `version-${read}`, path: "/claude" } }) });
  });
  await page.goto("/settings/claude");
  const settings = page.locator("caffold-settings-claude-page");
  await expect(settings).toContainText("version-1");
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(settings).toContainText("version-1");
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
  await page.locator('caffold-settings-navigator button[data-settings-section="appearance"]').click();
  await page.locator('caffold-settings-navigator button[data-settings-section="claude"]').click();
  await expect(settings).toContainText("version-3");
  expect(reads).toBe(3);
  const oldResponse = page.waitForResponse(response => response.url().endsWith("/api/claude/status") && response.status() === 200);
  release();
  await (await oldResponse).finished();
  await expect(settings).toContainText("version-3");
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(settings).toContainText("Unavailable");
  await expect(settings.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  expect(reads).toBe(4);
  await settings.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(settings).toContainText("version-5");
});
