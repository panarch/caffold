import { expect, test } from "@playwright/test";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import {
  installTaskApiFixture,
  taskDetailFixture,
} from "../support/task-api-fixture.js";

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

test("scales visible Task controls without shrinking their touch targets", async ({
  page,
}) => {
  await installScalingTask(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "caffold:settings",
      JSON.stringify({
        appearanceVersion: 3,
        typefacePreset: "d2-coding",
        interfaceScalePercent: 90,
        conversationTextPx: 15,
        codeTextPx: 13,
      }),
    );
  });

  await page.goto("/tasks/thread-1");
  await expect(
    page.locator(
      "caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden])",
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    const composer = document.querySelector(
      "caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden])",
    );
    composer.stateFor().images = [
      {
        id: "scale-audit-image",
        name: "scale-audit.png",
        dataUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      },
    ];
    composer.render();
  });
  const compactAttachment = await attachmentRemoveMetrics(page);
  await page.getByRole("button", { name: /Task details/ }).click();
  await page
    .locator(
      ".task-detail-popover:popover-open .task-detail-archive-action .task-secondary-button",
    )
    .scrollIntoViewIfNeeded();
  const compact = await taskInterfaceMetrics(page);

  await page.evaluate(async () => {
    const { setAppearanceSetting } = await import("/assets/settings.js");
    setAppearanceSetting("interfaceScalePercent", 120);
  });
  const detailsPopover = page.locator(".task-detail-popover");
  if (await detailsPopover.evaluate((element) => element.matches(":popover-open"))) {
    await detailsPopover.evaluate((element) => element.hidePopover());
  }
  const spaciousAttachment = await attachmentRemoveMetrics(page);
  if (!(await detailsPopover.evaluate((element) => element.matches(":popover-open")))) {
    await page.getByRole("button", { name: /Task details/ }).click();
  }
  await page
    .locator(
      ".task-detail-popover:popover-open .task-detail-archive-action .task-secondary-button",
    )
    .scrollIntoViewIfNeeded();
  const spacious = await taskInterfaceMetrics(page);
  const interfaceRatio = spacious.rootFontSize / compact.rootFontSize;
  expect(interfaceRatio).toBeCloseTo(4 / 3, 2);

  for (const key of [
    "closeHeight",
    "closeIconSize",
    "infoHeight",
    "newTaskVisualHeight",
    "archiveHeight",
    "modelHeight",
    "permissionHeight",
    "sendHeight",
    "popoverLabelFontSize",
    "popoverValueFontSize",
    "worktreeGuideHeadingFontSize",
    "worktreeGuideBodyFontSize",
  ]) {
    if (compact[key] === 0 || spacious[key] === 0) {
      continue;
    }
    expect(
      spacious[key] / compact[key],
      `${key} must follow Interface scale`,
    ).toBeCloseTo(interfaceRatio, 1);
  }
  expect(
    spaciousAttachment.visualHeight / compactAttachment.visualHeight,
    "attachment remove X must follow Interface scale",
  ).toBeCloseTo(interfaceRatio, 1);
  expect(
    spaciousAttachment.iconSize / compactAttachment.iconSize,
    "attachment remove icon must follow Interface scale",
  ).toBeCloseTo(interfaceRatio, 1);
  for (const metrics of [compact, spacious]) {
    expect(
      metrics.popoverValueFontSize,
      "task detail values must use the compact Interface metadata tier",
    ).toBeCloseTo(metrics.popoverLabelFontSize, 1);
    expect(
      metrics.worktreeGuideHeadingFontSize,
      "the worktree guide heading must use the Interface heading tier",
    ).toBeCloseTo(metrics.rootFontSize, 1);
    expect(
      metrics.worktreeGuideBodyFontSize,
      "the worktree guide body must stay slightly quieter than Interface text",
    ).toBeCloseTo(metrics.rootFontSize * 0.875, 1);
  }

  for (const metrics of [compact, spacious]) {
    expect(metrics.horizontalOverflow).toBe(false);
    expect(metrics.headerActionGaps.gitToGithub).toBeCloseTo(
      metrics.headerActionGap,
      1,
    );
    if (metrics.headerActionGaps.githubToInfo !== null) {
      expect(metrics.headerActionGaps.githubToInfo).toBeCloseTo(
        metrics.headerGroupGap,
        1,
      );
    }
    if (metrics.targetFloor >= 40) {
      for (const [name, covered] of Object.entries(metrics.hitTargets)) {
        expect(
          covered,
          `${name} must retain a 40px touch target: ${JSON.stringify(metrics.hitDebug[name])}`,
        ).toBe(true);
      }
    }
  }
  for (const metrics of [compactAttachment, spaciousAttachment]) {
    if (metrics.targetFloor >= 40) {
      expect(metrics.hitTarget).toBe(true);
    }
  }
});

async function installScalingTask(page) {
  await installTaskApiFixture(page);
  const detail = taskDetailFixture();
  detail.task.title = "Scale audit";
  detail.task.cwd = "Users/taehoon/Workspace/rust/codger";
  detail.task.cwdPath = detail.task.cwd;
  detail.task.worktree = {
    rootPath: detail.task.cwd,
    branch: "main",
    headSha: "0123456789abcdef",
    relativeCwd: "",
    linked: false,
  };

  await page.route(/\/api\/tasks(?:\?|$)/, (route) =>
    route.fulfill({ json: { tasks: [detail.task], nextCursor: null } }),
  );
  await page.route(/\/api\/tasks\/thread-1(?:\?|$)/, (route) =>
    route.fulfill({ json: detail }),
  );
  await page.route("**/api/tasks/thread-1/stream*", (route) =>
    route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }),
  );
  await page.route("**/api/github/status*", (route) =>
    route.fulfill({
      json: {
        repository: {
          rootPath: detail.task.cwd,
          branch: "main",
          dirty: false,
        },
        github: {
          owner: "openai",
          name: "codger",
          nameWithOwner: "openai/codger",
          url: "https://github.com/openai/codger",
        },
        ghAvailable: true,
        authenticated: true,
        issuesAvailable: true,
        pullsAvailable: true,
        message: null,
      },
    }),
  );
}

function attachmentRemoveMetrics(page) {
  return page.evaluate(() => {
    const button = document.querySelector(
      "caffold-task-detail:not([hidden]) .task-composer-attachment-remove",
    );
    const icon = button.querySelector(".task-composer-attachment-remove-icon");
    const box = button.getBoundingClientRect();
    const inset = Number.parseFloat(
      getComputedStyle(button, "::before").top,
    );
    const centerX = box.left + box.width / 2;
    const centerY = box.top + box.height / 2;
    const hitAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit === button || button.contains(hit);
    };
    return {
      visualHeight: box.height - inset * 2,
      iconSize: icon.getBoundingClientRect().height,
      targetFloor:
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--interface-target-floor",
          ),
        ) || 0,
      hitTarget: [
        [centerX, centerY - 19],
        [centerX, centerY + 19],
        [centerX - 19, centerY],
        [centerX + 19, centerY],
      ].every(([x, y]) => hitAt(x, y)),
    };
  });
}

function taskInterfaceMetrics(page) {
  return page.evaluate(() => {
    const number = (value) => Number.parseFloat(value) || 0;
    const rootStyle = getComputedStyle(document.documentElement);
    const rootFontSize = number(rootStyle.fontSize);
    const tokenPixels = (name) =>
      number(rootStyle.getPropertyValue(name)) * rootFontSize;
    const activeComposer = document.querySelector(
      "caffold-task-detail:not([hidden]) caffold-task-composer:not([hidden])",
    );
    const activeDetail = document.querySelector(
      "caffold-task-detail:not([hidden])",
    );
    const controls = {
      close: document.querySelector(".task-workspace-close"),
      info: activeDetail.querySelector(".task-detail-info-button"),
      newTask: document.querySelector(
        "caffold-task-navigator .task-list-new-task",
      ),
      git: activeDetail.querySelectorAll(".task-brand-button")[0],
      github: activeDetail.querySelectorAll(".task-brand-button")[1],
      archive: activeDetail.querySelector(
        ".task-detail-popover:popover-open .task-detail-archive-action .task-secondary-button",
      ),
      model: activeComposer.querySelector(".task-model-button"),
      permission: activeComposer.querySelector(".task-permission-button"),
      send: activeComposer.querySelector(".task-primary-action-button"),
    };
    const boxHeight = (element) => element.getBoundingClientRect().height;
    const paintedHeight = (element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return 0;
      }
      return box.height - number(getComputedStyle(element, "::before").top) * 2;
    };
    const fontSize = (element) => number(getComputedStyle(element).fontSize);
    const hitAt = (element, x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit === element || element.contains(hit);
    };
    const verticalHitTarget = (element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return true;
      }
      const x = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      return (
        hitAt(element, x, centerY - 19) &&
        hitAt(element, x, centerY + 19)
      );
    };
    const squareHitTarget = (element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        return true;
      }
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      return (
        verticalHitTarget(element) &&
        hitAt(element, centerX - 19, centerY) &&
        hitAt(element, centerX + 19, centerY)
      );
    };
    const hitDebug = (element) => {
      const box = element.getBoundingClientRect();
      const parentBox = element.parentElement?.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      return {
        box: {
          left: box.left,
          right: box.right,
          width: box.width,
        },
        parentBox: parentBox
          ? {
              left: parentBox.left,
              right: parentBox.right,
              width: parentBox.width,
            }
          : null,
        viewportWidth: window.innerWidth,
        points: [
          [centerX, centerY - 19],
          [centerX, centerY + 19],
          [centerX - 19, centerY],
          [centerX + 19, centerY],
        ].map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return {
            x,
            y,
            tag: hit?.tagName,
            className: hit?.className?.baseVal ?? hit?.className ?? "",
          };
        }),
      };
    };
    const visualBounds = (element) => {
      const box = element.getBoundingClientRect();
      const paint = getComputedStyle(element, "::before");
      return {
        left: box.left + number(paint.left),
        right: box.right - number(paint.right),
        centerY: box.top + box.height / 2,
      };
    };
    const horizontalGap = (left, right) => {
      const leftBounds = visualBounds(left);
      const rightBounds = visualBounds(right);
      if (Math.abs(leftBounds.centerY - rightBounds.centerY) > 1) {
        return null;
      }
      return rightBounds.left - leftBounds.right;
    };
    const taskDetailActions = activeDetail.querySelector(".task-detail-actions");
    const taskDetailRight = activeDetail.querySelector(".task-detail-right");
    const compactInset = number(
      getComputedStyle(controls.git, "::before").left,
    );
    const popoverLabelFontSize = fontSize(
      document.querySelector(".task-detail-popover dt"),
    );
    const popoverValueFontSize = fontSize(
      document.querySelector(".task-detail-popover dd"),
    );
    const worktreeGuide = document.querySelector(
      "caffold-task-new .task-new-worktree-guide",
    );
    const worktreeGuideHeadingFontSize = fontSize(
      worktreeGuide.querySelector("h2"),
    );
    const worktreeGuideBodyFontSize = fontSize(worktreeGuide);
    const archiveHitTarget = verticalHitTarget(controls.archive);
    const archiveHitDebug = hitDebug(controls.archive);
    activeDetail
      .querySelector(".task-detail-popover:popover-open")
      ?.hidePopover();

    return {
      rootFontSize,
      targetFloor: number(
        rootStyle.getPropertyValue("--interface-target-floor"),
      ),
      closeHeight: tokenPixels("--interface-compact-visual-size"),
      closeIconSize: boxHeight(
        controls.close.querySelector(".task-workspace-close-icon"),
      ),
      infoHeight: tokenPixels("--interface-compact-visual-size"),
      newTaskVisualHeight: paintedHeight(controls.newTask),
      archiveHeight: tokenPixels("--interface-compact-visual-size"),
      modelHeight: boxHeight(controls.model),
      permissionHeight: boxHeight(controls.permission),
      sendHeight: tokenPixels("--interface-control-visual-size"),
      popoverLabelFontSize,
      popoverValueFontSize,
      worktreeGuideHeadingFontSize,
      worktreeGuideBodyFontSize,
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      headerActionGap: Math.max(
        tokenPixels("--interface-toolbar-gap"),
        compactInset * 2,
      ),
      headerGroupGap: Math.max(
        tokenPixels("--interface-space-5"),
        compactInset * 2,
      ),
      headerActionGaps: {
        gitToGithub: horizontalGap(controls.git, controls.github),
        githubToInfo: horizontalGap(controls.github, controls.info),
      },
      hitTargets: {
        close: squareHitTarget(controls.close),
        info: squareHitTarget(controls.info),
        newTask: squareHitTarget(controls.newTask),
        git: squareHitTarget(controls.git),
        github: squareHitTarget(controls.github),
        archive: archiveHitTarget,
        model: verticalHitTarget(controls.model),
        permission: verticalHitTarget(controls.permission),
        send: squareHitTarget(controls.send),
      },
      hitDebug: {
        ...Object.fromEntries(
          Object.entries(controls)
            .filter(([name]) => name !== "archive")
            .map(([name, element]) => [name, hitDebug(element)]),
        ),
        archive: archiveHitDebug,
      },
    };
  });
}
