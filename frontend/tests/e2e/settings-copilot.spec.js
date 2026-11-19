import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "./support/browser-defaults.js";
import {
  activateActionHint,
  actionHintDialog,
} from "./support/action-hints.js";
import { copilotSettings as signedIn } from "./support/copilot-settings.js";

const runtime = signedIn.runtime;

test("Copilot settings show the signed-in account, available models and a fresh sign-in check", { tag: "@server-changes" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let authenticated = true;
  await page.route("**/api/copilot/status", (route) =>
    route.fulfill({
      json: {
        ...signedIn,
        authenticated,
        login: authenticated ? signedIn.login : null,
        usage: authenticated ? signedIn.usage : null,
        models: authenticated ? signedIn.models : [],
        error: authenticated ? null : "Sign in to GitHub with copilot login.",
      },
    }),
  );

  await page.goto("/settings/copilot");
  const settings = page.locator("caffold-settings-copilot-page");
  await expect(settings).toBeVisible();
  await expect(settings).toContainText("octocat");
  await expect(settings).toContainText("MAI Code 2");
  await expect(settings).toContainText("1.0.114");
  await expect(
    settings.getByRole("heading", { name: "Models (1)" }),
  ).toBeVisible();
  await expect(settings.getByRole("region", { name: "Usage" })).toContainText(
    "87.5% remaining",
  );
  await expect(settings.locator('[data-key="chat"] dd')).toHaveText(
    "Unlimited",
  );
  await expect(settings.locator('[data-key="completions"] dd')).toHaveText(
    "Unlimited",
  );
  await expect(settings.locator('[data-key="plan"] dd')).toHaveText(
    "Copilot Pro",
  );
  await expect(settings.locator('[data-key="cliPath"] code')).toHaveText(
    "/usr/local/bin/copilot",
  );
  authenticated = false;
  await activateActionHint(page, "Refresh");
  await expect(settings).toContainText("Signed out");
  await expect(settings.getByRole("status")).toContainText("copilot login");
  await expect(settings).not.toContainText("octocat");
  await expect(settings).not.toContainText("Copilot Pro");
  await expect(
    settings.getByRole("region", { name: "Models", exact: true }),
  ).toContainText("Signed out");
  await expect(
    settings.getByRole("region", { name: "Usage" }),
  ).not.toContainText("87.5%");
});

test("Copilot runtime restart requires confirmation and survives leaving Settings", { tag: "@server-changes" }, async ({ page }) => {
  await installBrowserDefaults(page);
  const status = { ...signedIn };
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/copilot/status", (route) =>
    route.fulfill({ json: status }),
  );
  await page.route("**/api/copilot/restart", async (route) => {
    expect(route.request().method()).toBe("POST");
    posts += 1;
    await gate;
    status.runtime = { ...runtime, pid: 4202, sessions: 0 };
    await route.fulfill({ json: status });
  });

  await page.goto("/settings/copilot");
  const owner = page.locator("caffold-settings-copilot-page");
  const restart = owner.getByRole("button", {
    name: "Restart runtime",
    exact: true,
  });
  const dialog = page.getByRole("dialog", { name: "Restart Copilot runtime?" });
  await expect(restart).toBeEnabled();
  await activateActionHint(page, /Restart runtime$/);
  await expect(dialog).toContainText("ends every running Copilot turn");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(restart).toBeFocused();
  expect(posts).toBe(0);

  await restart.click();
  await page.keyboard.press("f");
  const confirm = actionHintDialog(page).getByRole("button", {
    name: / — Restart Copilot$/,
  });
  await expect(confirm).toBeVisible();
  const code = await confirm.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());
  await expect.poll(() => posts).toBe(1);
  await expect(
    owner.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeDisabled();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(owner).toBeHidden();
  await nav
    .getByRole("button", { name: "GitHub Copilot", exact: true })
    .click();
  await expect(
    owner.getByRole("button", { name: "Restarting…" }),
  ).toBeDisabled();
  release();

  await expect(owner).toContainText("Copilot runner restarted.");
  await expect(owner).toContainText("Running · pid 4202");
  await expect(restart).toBeEnabled();
  expect(posts).toBe(1);
});

test("Copilot Settings follows a restart confirmed in another window", { tag: "@server-changes" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let current = { ...runtime, restarting: true };
  let accountReads = 0;
  await page.route("**/api/copilot/status", (route) => {
    accountReads++;
    return route.fulfill({ json: { ...signedIn, runtime: current } });
  });
  await page.route("**/api/copilot/runtime", (route) =>
    route.fulfill({ json: current }),
  );
  await page.goto("/settings/copilot");
  const owner = page.locator("caffold-settings-copilot-page");
  await expect(
    owner.getByRole("button", { name: "Restarting…" }),
  ).toBeDisabled();

  current = { ...runtime, pid: 4202, sessions: 0 };
  await expect(owner).toContainText("Running · pid 4202");
  expect(accountReads).toBe(1);
  await expect(
    owner.getByRole("button", { name: "Restart runtime" }),
  ).toBeEnabled();
});

test("Copilot restart failure leaves the last observed runner and allows a retry", { tag: "@server-steady" }, async ({ page }) => {
  await installBrowserDefaults(page);
  await page.route("**/api/copilot/status", (route) =>
    route.fulfill({ json: signedIn }),
  );
  await page.route("**/api/copilot/restart", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "copilot_runtime_busy",
          message: "Wait for the current Copilot runtime operation to finish.",
        },
      },
    }),
  );
  await page.goto("/settings/copilot");
  const owner = page.locator("caffold-settings-copilot-page");
  const restart = owner.getByRole("button", { name: "Restart runtime" });
  await restart.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Restart Copilot", exact: true })
    .click();
  await expect(owner).toContainText(
    "Wait for the current Copilot runtime operation to finish.",
  );
  await expect(owner).toContainText("Running · pid 4201");
  await expect(restart).toBeEnabled();
});

test("Copilot refresh replaces the account, usage and catalog independently", { tag: "@server-changes" }, async ({ page }) => {
  await installBrowserDefaults(page);
  let status = signedIn;
  let release;
  const initial = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/copilot/status", async (route) => {
    await initial;
    await route.fulfill({ json: status });
  });
  await page.goto("/settings/copilot");
  const owner = page.locator("caffold-settings-copilot-page");
  await expect(
    owner.getByRole("region", { name: "Models", exact: true }),
  ).toContainText("Loading…");
  release();
  await expect(owner.getByText("Copilot Pro", { exact: true })).toBeVisible();

  status = {
    ...signedIn,
    login: "avery",
    models: [],
    modelsError: "Model catalog unavailable.",
    usage: {
      plan: "Copilot Free",
      quotas: [
        {
          ...signedIn.usage.quotas[0],
          used: 100,
          remainingPercentage: 0,
          resetEstimated: true,
        },
      ],
      errors: [],
    },
  };
  const refresh = owner.getByRole("button", { name: "Refresh", exact: true });
  await refresh.click();
  await expect(owner.locator('[data-key="account"] dd')).toHaveText("avery");
  await expect(owner.locator('[data-key="plan"] dd')).toHaveText(
    "Copilot Free",
  );
  const usage = owner.getByRole("region", { name: "Usage" });
  await expect(usage).toContainText(
    "100 of 100 used · 0% remaining · estimated reset",
  );
  await expect(
    owner.getByRole("region", { name: "Models", exact: true }),
  ).toContainText("Model catalog unavailable.");

  status = {
    ...status,
    modelsError: null,
    usage: {
      plan: "Copilot Free",
      quotas: [],
      errors: ["Could not read account allowances."],
    },
  };
  await refresh.click();
  await expect(usage).toContainText("Could not read account allowances.");
  await expect(usage).not.toContainText("0% remaining");
  await expect(owner.getByRole("region", { name: "Models (0)" })).toContainText(
    "No models available.",
  );
  status = {
    ...status,
    usage: { plan: null, quotas: [], errors: [] },
    models: signedIn.models,
  };
  await refresh.click();
  await expect(usage).toContainText("No usage reported.");
  await expect(
    owner.getByRole("region", { name: "Models (1)" }).getByRole("listitem"),
  ).toHaveText("MAI Code 2");
});

test(
  "Copilot models follow SDK order and wrap inside the Settings panel",
  { tag: "@all-viewports" },
  async ({ page }, testInfo) => {
    await installBrowserDefaults(page);
    const names = [
      "Auto",
      "ModelWithAnUnbrokenDisplayName".repeat(5),
      ...Array.from({ length: 14 }, (_, i) => `Catalog model ${i + 3}`),
    ];
    await page.route("**/api/copilot/status", (route) =>
      route.fulfill({
        json: {
          ...signedIn,
          models: names.map((displayName, i) => ({
            model: `model-${i}`,
            displayName,
          })),
        },
      }),
    );
    await page.goto("/settings/copilot");
    const owner = page.locator("caffold-settings-copilot-page");
    const models = owner.getByRole("region", { name: "Models (16)" });
    await expect(models.getByRole("listitem")).toHaveText(names);
    const list = models.getByRole("list");
    const checkGrid = async (width) => {
      const layout = await list.evaluate((ul) => {
        const rows = [...ul.children].map((li) =>
          li.getBoundingClientRect().toJSON(),
        );
        return {
          columns: getComputedStyle(ul).gridTemplateColumns.split(" ").length,
          rows,
          fits: ul.scrollWidth === ul.clientWidth,
          line: parseFloat(getComputedStyle(ul.children[1]).lineHeight),
        };
      });
      const columns = width <= 520 ? 1 : 2;
      expect(layout.columns).toBe(columns);
      expect(layout.fits).toBe(true);
      expect(layout.rows[1].height).toBeGreaterThan(layout.line * 2);
      expect(layout.rows[columns].top).toBeGreaterThan(layout.rows[0].top);
      if (columns === 2)
        expect(layout.rows[1].left).toBeGreaterThan(layout.rows[0].left);
    };
    await checkGrid(await owner.evaluate((el) => el.clientWidth));
    if (testInfo.project.name === "desktop") {
      for (const width of [520, 521]) {
        await owner.evaluate((el, px) => (el.style.width = `${px}px`), width);
        await checkGrid(width);
      }
    }
  },
);
