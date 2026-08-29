import { expect, test } from "@playwright/test";

import { installBrowserDefaults } from "./support/browser-defaults.js";

test(
  "multiplexes three logical channels per tab without blocking REST fetches",
  { tag: "@desktop" },
  async ({ context, page }) => {
    const secondPage = await context.newPage();
    await installBrowserDefaults(page);
    await installBrowserDefaults(secondPage);
    const liveRequests = new Map([
      [page, 0],
      [secondPage, 0],
    ]);
    for (const candidate of [page, secondPage]) {
      candidate.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/live") {
          liveRequests.set(candidate, liveRequests.get(candidate) + 1);
        }
      });
    }

    await Promise.all([page.goto("/"), secondPage.goto("/")]);
    for (const candidate of [page, secondPage]) {
      await expect
        .poll(() =>
          candidate.evaluate(() =>
            document.querySelector("caffold-task-workspace")?.liveUpdates?.node
          )
        )
        .toBe("connected");
      await candidate.evaluate(() => {
        const gateway = document.querySelector(
          "caffold-task-workspace",
        ).liveUpdates;
        window.__livePoolProbe = [
          gateway.subscribeTaskList({}),
          gateway.subscribeTaskDetail("connection-pool-probe", {}),
          gateway.subscribeWatch("", {}),
        ];
      });
      await expect
        .poll(() =>
          candidate.evaluate(() => {
            const desired = document.querySelector(
              "caffold-task-workspace",
            ).liveUpdates.desiredSubscriptions();
            return {
              detail: Boolean(desired.taskDetail),
              list: Boolean(desired.taskList),
              watches: desired.watches.length,
            };
          })
        )
        .toEqual({ detail: true, list: true, watches: 1 });
    }

    await page.waitForTimeout(250);
    expect(liveRequests.get(page)).toBe(1);
    expect(liveRequests.get(secondPage)).toBe(1);

    const health = await page.evaluate(async () => {
      const requests = Promise.all(
        Array.from({ length: 8 }, async () => {
          const response = await fetch("/api/health", { cache: "no-store" });
          return response.status;
        }),
      ).then((statuses) => ({ statuses, timedOut: false }));
      const timeout = new Promise((resolve) => {
        setTimeout(() => resolve({ statuses: [], timedOut: true }), 5_000);
      });
      return Promise.race([requests, timeout]);
    });
    expect(health.timedOut).toBe(false);
    expect(health.statuses).toEqual(Array(8).fill(200));

    for (const candidate of [page, secondPage]) {
      await candidate.evaluate(() => {
        for (const binding of window.__livePoolProbe ?? []) {
          binding.close();
        }
        delete window.__livePoolProbe;
      });
    }
    await secondPage.close();
  },
);
