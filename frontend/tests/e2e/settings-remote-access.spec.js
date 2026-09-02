import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  activateActionHint,
  enterActionHints,
} from "./support/action-hints.js";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import {
  captureReviewScreenshot,
  mockAgentModels,
} from "./support/task-fixtures.js";

const TAILNET_URL = "https://caffold-review-host.long-tailnet-name.ts.net/";
const REPLACEMENT_TAILNET_URL =
  "https://caffold-replacement-host.long-tailnet-name.ts.net/";

function tailscaleStatus(state, overrides = {}) {
  return {
    state,
    reasonCode: `${state}Reason`,
    diagnosticMessage: `${state} diagnostic from the Caffold server.`,
    tailnetUrl: state === "ready" ? TAILNET_URL : null,
    canManage: true,
    ...overrides,
  };
}

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
  await mockAgentModels(page);
});

test("presents every canonical Tailscale state with only its available action", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let state = "notInstalled";
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(tailscaleStatus(state)),
    }),
  );
  const cases = [
    ["notInstalled", "Tailscale is not installed", null],
    ["disconnected", "Tailscale is disconnected", null],
    ["serveOff", "Ready to enable", "Enable"],
    ["configuring", "Configuring private access", null],
    ["disabling", "Turning private access off", null],
    ["ready", "Private access is ready", "Disable"],
    ["unavailable", "Remote access is unavailable", "Retry"],
    ["failed", "Remote access setup failed", "Retry"],
  ];

  for (const [nextState, heading, action] of cases) {
    state = nextState;
    await page.goto("/settings/remote-access");
    const remoteAccess = page.locator("caffold-settings-remote-access-page");
    await expect(remoteAccess.getByRole("heading", { name: heading })).toBeVisible();
    await expect(remoteAccess.locator(".settings-remote-status")).toHaveAttribute(
      "data-state",
      nextState,
    );
    for (const label of ["Enable", "Disable", "Retry"]) {
      const button = remoteAccess.getByRole("button", { name: label });
      if (label === action) {
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
      } else {
        await expect(button).toBeHidden();
      }
    }
    await expect(remoteAccess).not.toContainText(/public URL/i);
  }
});

test("enables, retries, and disables only Caffold's Serve mapping", { tag: "@all-viewports" }, async ({
  page,
}) => {
  let current = tailscaleStatus("serveOff");
  let releaseFirstUpdate;
  const firstUpdateGate = new Promise((resolve) => {
    releaseFirstUpdate = resolve;
  });
  const requestedStates = [];
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(current),
    }),
  );
  await page.route(/\/api\/tailscale\/serve(?:\?|$)/, async (route) => {
    expect(route.request().method()).toBe("PUT");
    const body = route.request().postDataJSON();
    expect(Object.keys(body)).toEqual(["enabled"]);
    requestedStates.push(body.enabled);
    if (requestedStates.length === 1) {
      current = tailscaleStatus("configuring");
      await firstUpdateGate;
      current = tailscaleStatus("failed", {
        reasonCode: "serveEnableFailed",
      });
    } else {
      current = tailscaleStatus(body.enabled ? "ready" : "serveOff");
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(current),
    });
  });

  await page.goto("/settings/remote-access");
  const remoteAccess = page.locator("caffold-settings-remote-access-page");
  await revealActionTarget(
    page,
    remoteAccess.getByRole("button", { name: "Enable" }),
  );
  await activateActionHint(page, /Enable$/);
  await expect(
    remoteAccess.getByRole("heading", { name: "Configuring private access" }),
  ).toBeVisible();
  releaseFirstUpdate();
  await expect(
    remoteAccess.getByRole("heading", { name: "Remote access setup failed" }),
  ).toBeVisible();

  await revealActionTarget(
    page,
    remoteAccess.getByRole("button", { name: "Retry" }),
  );
  await activateActionHint(page, /Retry$/);
  await expect(
    remoteAccess.getByRole("heading", { name: "Private access is ready" }),
  ).toBeVisible();
  await revealActionTarget(
    page,
    remoteAccess.getByRole("button", { name: "Disable" }),
  );
  await activateActionHint(page, /Disable$/);
  await expect(
    remoteAccess.getByRole("heading", { name: "Ready to enable" }),
  ).toBeVisible();
  expect(requestedStates).toEqual([true, true, false]);
});

test("hands off one exact private URL while remote management stays read-only", { tag: "@all-viewports" }, async ({
  context,
  page,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let serveUpdates = 0;
  let tailnetUrl = TAILNET_URL;
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(tailscaleStatus("ready", {
        canManage: false,
        tailnetUrl,
      })),
    }),
  );
  await page.route(/\/api\/tailscale\/serve(?:\?|$)/, (route) => {
    serveUpdates += 1;
    return route.fulfill({ status: 500 });
  });
  await context.route(`${TAILNET_URL}**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Caffold</title>" }),
  );

  await page.goto("/settings/remote-access");
  const remoteAccess = page.locator("caffold-settings-remote-access-page");
  await expect(remoteAccess.getByRole("status", { name: "Ready" })).toBeVisible();
  await expect(remoteAccess.getByText("Serve settings are read-only")).toBeVisible();
  await expect(remoteAccess.getByRole("button", { name: "Disable" })).toBeHidden();
  await expect(remoteAccess.locator("[data-tailnet-address]")).toHaveText(TAILNET_URL);
  const open = remoteAccess.getByRole("link", { name: "Open link" });
  await expect(open).toHaveAttribute("href", TAILNET_URL);
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  const qr = remoteAccess.locator("img[data-qr-code]");
  await expect(qr).toHaveAttribute("data-tailnet-url", TAILNET_URL);
  await expect(qr).toHaveAttribute(
    "src",
    "/api/tailscale/qr.svg?url=https%3A%2F%2Fcaffold-review-host.long-tailnet-name.ts.net%2F",
  );
  await expect.poll(() => qr.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  await revealActionTarget(
    page,
    remoteAccess.getByRole("button", { name: "Copy link" }),
  );
  await activateActionHint(page, /Copy link$/);
  await expect(remoteAccess.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    TAILNET_URL,
  );

  const popupPromise = page.waitForEvent("popup");
  await revealActionTarget(page, open);
  await activateActionHint(
    page,
    /Open private access address in a new tab$/,
  );
  const popup = await popupPromise;
  await expect.poll(() => popup.url()).toBe(TAILNET_URL);
  await popup.close();
  expect(serveUpdates).toBe(0);

  const geometry = await remoteAccess.evaluate((element) => {
    const content = element.querySelector(".settings-remote-handoff > div:first-child")
      .getBoundingClientRect();
    const figure = element.querySelector("figure").getBoundingClientRect();
    const scroller = element.querySelector(".settings-content-scroll");
    return {
      sideBySide: figure.left >= content.right - 1,
      stacked: figure.top >= content.bottom - 1,
      noHorizontalOverflow: scroller.scrollWidth <= scroller.clientWidth + 1,
    };
  });
  expect(geometry.noHorizontalOverflow).toBe(true);
  if (testInfo.project.name === "desktop") {
    expect(geometry.sideBySide).toBe(true);
  } else {
    expect(geometry.stacked).toBe(true);
  }
  await captureReviewScreenshot(page, testInfo, "settings-remote-access-ready");
  await remoteAccess.locator(".settings-content-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(qr).toBeVisible();
  await captureReviewScreenshot(page, testInfo, "settings-remote-access-qr");

  await revealActionTarget(page, open);
  const hint = await enterActionHints(page);
  await expect(
    hint.getByLabel(/Open private access address in a new tab$/),
  ).toBeVisible();
  tailnetUrl = REPLACEMENT_TAILNET_URL;
  await remoteAccess.evaluate((element) => element.lifecycle.refresh());
  await expect(open).toHaveAttribute("href", REPLACEMENT_TAILNET_URL);
  await expect(actionHintDialog(page)).toBeHidden();
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    "snapshot-invalidated",
  );
  expect(serveUpdates).toBe(0);
});

test("keeps canonical local status when a refresh request fails", { tag: "@desktop" }, async ({
  page,
}) => {
  let requestCount = 0;
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(tailscaleStatus("ready")),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Tailscale status is temporarily unavailable." } }),
    });
  });

  await page.goto("/settings/remote-access");
  const remoteAccess = page.locator("caffold-settings-remote-access-page");
  await expect(
    remoteAccess.getByRole("heading", { name: "Private access is ready" }),
  ).toBeVisible();
  await remoteAccess.getByRole("button", { name: "Refresh" }).click();
  await expect(remoteAccess.getByRole("alert")).toContainText(
    "Tailscale status is temporarily unavailable.",
  );
  await expect(
    remoteAccess.getByRole("heading", { name: "Private access is ready" }),
  ).toBeVisible();
  await expect(remoteAccess.getByText("Serve settings are read-only")).toBeHidden();
  await expect(remoteAccess.getByRole("button", { name: "Disable" })).toBeHidden();
  await expect(remoteAccess.locator("[data-tailnet-address]")).toHaveText(TAILNET_URL);
  await expect(remoteAccess.getByRole("button", { name: "Retry" })).toBeEnabled();
});

test("presents an initial status request failure without inventing read-only state", { tag: "@desktop" }, async ({
  page,
}) => {
  await page.route(/\/api\/tailscale\/status(?:\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "The Caffold host is unavailable." } }),
    }),
  );

  await page.goto("/settings/remote-access");
  const remoteAccess = page.locator("caffold-settings-remote-access-page");
  await expect(
    remoteAccess.getByRole("heading", { name: "Remote access status is unavailable" }),
  ).toBeVisible();
  await expect(remoteAccess.getByText("Serve settings are read-only")).toBeHidden();
  await expect(remoteAccess.getByRole("button", { name: "Retry" })).toBeEnabled();
});

async function revealActionTarget(page, target) {
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  ));
}
