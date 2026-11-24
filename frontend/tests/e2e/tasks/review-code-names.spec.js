import { expect, test } from "@playwright/test";
import {
  actionHintDialog,
  badgeAtRowEndMiddle,
  popoverActionHintDialog,
  waitForActionHintTarget,
} from "../support/action-hints.js";
import { installBrowserDefaults } from "../support/browser-defaults.js";
import { installTaskLoopFixture } from "../support/task-loop-fixture.js";
import { installTaskReviewFixture } from "../support/task-review-fixture.js";
import { captureReviewScreenshot } from "../support/task-fixtures.js";

// example.rs as the fixture home holds it; its first line is
// `pub fn sample(name: &str) -> String {`.
const SAMPLE = { line: 1, character: 7 };

const DEEP_FOLDER =
  "generated/deep/review/folders/that/keep/going/past-the-width-of-the-list/with-a-long-review-name";

const PLANNER_DEFINITION = {
  path: "src/planner.rs",
  name: "planner.rs",
  line: 1,
  character: 7,
  length: 21,
  text: "pub fn planned_review_fixture() -> &'static str {",
};

test.beforeEach(async ({ page }) => {
  await installBrowserDefaults(page);
});

// Answers the Task root's language servers with one Rust server and every
// question about a name with the places the test prepared. Looking again
// leaves the server as it is, or `found` once looked for.
async function installLanguageServers(
  page,
  { enabled = true, state = "ready", progress, found, places = {} } = {},
) {
  const asked = [];
  const lookedAgain = [];
  let current = state;
  const answer = () => ({
    path: "src",
    enabled,
    servers: [
      {
        repositoryPath: "src",
        language: "rust",
        languageName: "Rust",
        extensions: ["rs"],
        serverName: "rust-analyzer",
        state: current,
        ...(progress ? { progress } : {}),
      },
    ],
  });
  await page.route(
    (url) => url.pathname === "/api/language-servers/repository",
    (route) => route.fulfill({ json: answer() }),
  );
  await page.route(
    (url) => url.pathname === "/api/language-servers/repository/check",
    (route) => {
      lookedAgain.push(route.request().postDataJSON().path);
      current = found ?? current;
      return route.fulfill({ json: answer() });
    },
  );
  await page.route(
    (url) => /^\/api\/language-servers\/(definition|references)$/.test(url.pathname),
    (route) => {
      const kind = new URL(route.request().url()).pathname.split("/").at(-1);
      asked.push({ kind, ...route.request().postDataJSON() });
      return route.fulfill({ json: { places: places[kind] ?? [] } });
    },
  );
  return { asked, lookedAgain };
}

async function openSource(page, file = "example.rs") {
  await installTaskReviewFixture(page);
  const taskScenario = await installTaskLoopFixture(page);
  await taskScenario.seedCompletedTask();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=${file}`,
  );
  const taskReview = page.locator("caffold-tasks-page caffold-task-review");
  await expect(
    taskReview.locator("caffold-code-viewer .code-row").first(),
  ).toBeVisible();
  return { threadId: taskScenario.threadId, taskReview };
}

function codeName(taskReview, line, text) {
  return taskReview
    .locator(`caffold-code-viewer .code-row[data-line-number="${line}"] .code-name`)
    .filter({ hasText: new RegExp(`^${text}$`) });
}

test("a pressed name opens its menu, and one definition opens at its line in Source", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  const { asked } = await installLanguageServers(page, {
    places: { definition: [PLANNER_DEFINITION] },
  });
  const { threadId, taskReview } = await openSource(page);
  const sample = codeName(taskReview, 1, "sample");

  await sample.click();
  const menu = taskReview.locator("caffold-code-name-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveText([
    "Go to definition",
    "Find references",
  ]);
  // The name stays underlined while its menu is open, with the pointer away
  // from it as after a touch.
  await page.mouse.move(0, 0);
  await expect(sample).toHaveCSS("text-decoration-line", "underline");
  await captureReviewScreenshot(page, testInfo, "review-code-name-menu");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(sample).toHaveCSS("text-decoration-line", "none");
  await sample.click();

  await menu.getByRole("button", { name: "Go to definition" }).click();
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=planner.rs&line=1`,
  );
  await expect(menu).toBeHidden();
  expect(asked).toEqual([
    { kind: "definition", path: "src/example.rs", ...SAMPLE },
  ]);
});

test("puts each menu badge at the middle of its item's end", { tag: "@server-steady" }, async ({ page }) => {
  await installLanguageServers(page);
  const { taskReview } = await openSource(page);
  await codeName(taskReview, 1, "sample").click();
  const menu = taskReview.locator("caffold-code-name-menu");
  await expect(menu.getByRole("button", { name: "Go to definition" })).toBeEnabled();

  await page.keyboard.press("f");
  const hint = popoverActionHintDialog(page);
  await expect(hint).toBeVisible();
  for (const name of ["Go to definition", "Find references"]) {
    await expect.poll(() => badgeAtRowEndMiddle(
      hint.getByRole("button", { name: new RegExp(` — ${name}$`) }),
      menu.getByRole("button", { name, exact: true }),
    )).toEqual({ atEnd: true, middle: true });
  }
});

test("Cmd or Ctrl and a click go straight to the definition", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page, {
    places: { definition: [PLANNER_DEFINITION] },
  });
  const { threadId, taskReview } = await openSource(page);

  await codeName(taskReview, 1, "sample").click({ modifiers: ["ControlOrMeta"] });
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=planner.rs&line=1`,
  );
  await expect(taskReview.locator("caffold-code-name-menu")).toBeHidden();
});

test("a name with no definition says so at the name", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page, { places: { definition: [] } });
  const { threadId, taskReview } = await openSource(page);

  await codeName(taskReview, 1, "sample").click({ modifiers: ["ControlOrMeta"] });
  const menu = taskReview.locator("caffold-code-name-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("status")).toHaveText("No definition found.");
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=example.rs`,
  );
});

test("a definition outside the folder Caffold serves is named at the name", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page, {
    places: {
      definition: [{ path: null, name: "time.rs", line: 224, character: 11 }],
    },
  });
  const { taskReview } = await openSource(page);

  await codeName(taskReview, 1, "sample").click();
  const menu = taskReview.locator("caffold-code-name-menu");
  await menu.getByRole("button", { name: "Go to definition" }).click();
  await expect(menu.getByRole("status")).toHaveText(
    "Defined in time.rs, line 224, outside the folder Caffold serves.",
  );
});

test("while the server gets ready the menu says so and keeps its actions off", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  await installLanguageServers(page, {
    state: "starting",
    progress: "Indexing 1/2 (core)",
  });
  const { taskReview } = await openSource(page);

  await codeName(taskReview, 1, "sample").click();
  const menu = taskReview.locator("caffold-code-name-menu");
  await expect(menu.getByRole("status")).toHaveText(
    "Getting ready · Indexing 1/2 (core)",
  );
  await expect(menu.getByRole("button", { name: "Go to definition" })).toBeDisabled();
  await expect(menu.getByRole("button", { name: "Find references" })).toBeDisabled();
  await captureReviewScreenshot(page, testInfo, "review-code-name-menu-starting");
});

test("showing the repository looks again for a failed server, so one installed meanwhile answers", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { lookedAgain } = await installLanguageServers(page, {
    state: "failed",
    found: "ready",
  });
  const { taskReview } = await openSource(page);

  await expect(codeName(taskReview, 1, "sample")).toBeVisible();
  expect(lookedAgain).toHaveLength(1);
});

test("names stay plain where the repository's servers are off", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page, { enabled: false });
  const { taskReview } = await openSource(page);

  await expect(
    taskReview.locator("caffold-code-viewer .code-row").first(),
  ).toContainText("pub fn sample");
  await expect(taskReview.locator("caffold-code-viewer .code-name")).toHaveCount(0);
});

test("Diff offers the names of the new side only", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page);
  await installTaskReviewFixture(page);
  const taskScenario = await installTaskLoopFixture(page);
  await taskScenario.seedCompletedTask();
  await page.goto(`/tasks/${taskScenario.threadId}/review?file=planner.rs`);
  const diff = page.locator("caffold-tasks-page caffold-task-review caffold-diff-viewer");

  await expect(diff.locator(".diff-row-added .code-name")).toHaveText([
    "new",
    "planner",
    "behavior",
  ]);
  await expect(diff.locator(".diff-row-removed")).toContainText("old planner behavior");
  await expect(diff.locator(".diff-row-removed .code-name")).toHaveCount(0);
});

test("Find references lists the places in the navigator's place until closed", { tag: "@all-viewports" }, async ({
  page,
}, testInfo) => {
  await installLanguageServers(page, {
    places: {
      references: [
        { path: "src/example.rs", name: "example.rs", line: 1, character: 7, length: 6, text: "pub fn sample(name: &str) -> String {" },
        { path: "src/planner/mod.rs", name: "mod.rs", line: 12, character: 4, length: 6, text: "    sample(\"planner\")" },
        { path: "src/planner/mod.rs", name: "mod.rs", line: 30, character: 8, length: 6, text: "        sample(\"a much longer line that keeps going past the width of the list so it scrolls sideways\")" },
        { path: `src/${DEEP_FOLDER}/deep.rs`, name: "deep.rs", line: 4, character: 0, length: 6, text: "sample(\"deep\")" },
      ],
    },
  });
  const { threadId, taskReview } = await openSource(page);
  const sourceUrl = `/tasks/${threadId}/review?nav=files&view=source&file=example.rs`;
  const findAt = "find=references&at=example.rs%3A1%3A8";
  const sample = codeName(taskReview, 1, "sample");

  // A touch, which leaves no hover, still underlines the name while its menu
  // is open.
  if (testInfo.project.use.hasTouch) {
    await sample.tap();
  } else {
    await sample.click();
  }
  await expect(sample).toHaveCSS("text-decoration-line", "underline");
  await taskReview
    .locator("caffold-code-name-menu")
    .getByRole("button", { name: "Find references" })
    .click();
  const places = taskReview.locator("caffold-review-places");
  await expect(places).toBeVisible();
  await expect(places.getByRole("heading", { level: 2 })).toHaveText("References");
  await expect(places.locator(".review-places-meta")).toHaveText("sample · 4");
  await expect(places.locator(".review-places-file-heading")).toHaveText([
    /example\.rs\s*1/,
    /mod\.rs\s*planner\s*2/,
    /deep\.rs\s*generated\/.*with-a-long-review-name\s*1/,
  ]);
  // A long folder wraps inside the pane and keeps the count in view.
  const deepHeading = places.locator(".review-places-file-heading").last();
  const paneWidth = await places.evaluate((element) => element.getBoundingClientRect().width);
  const headingBox = await deepHeading.boundingBox();
  expect(headingBox.width).toBeLessThanOrEqual(paneWidth + 0.5);
  await expect(deepHeading.locator(".review-places-count")).toBeInViewport();
  await expect(places.locator(".review-places-line strong").first()).toHaveText("sample");
  await expect(taskReview.locator("caffold-file-navigator")).toBeHidden();
  if (testInfo.project.name === "phone") {
    // The phone shows the list in place of the file.
    await expect(page).toHaveURL(`/tasks/${threadId}/review?nav=files&view=source&${findAt}`);
  } else {
    await expect(page).toHaveURL(`${sourceUrl}&${findAt}`);
    await expect(taskReview.locator("caffold-code-viewer")).toBeVisible();
  }
  // The file is open at no particular line, so no place is the one shown.
  await expect(places.locator('.review-places-line[aria-current="true"]')).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "review-references");

  await places.locator('.review-places-line[data-line="30"]').click();
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=planner%2Fmod.rs&line=30&${findAt}`,
  );
  await expect(taskReview.locator("caffold-code-viewer")).toBeVisible();
  if (testInfo.project.name !== "phone") {
    await expect(
      places.locator('.review-places-line[data-line="30"]'),
    ).toHaveAttribute("aria-current", "true");
  }

  if (testInfo.project.name === "phone") {
    await page.goBack();
    await expect(places).toBeVisible();
  } else if (testInfo.project.name === "foldable") {
    await taskReview.locator("caffold-split-view .split-view-strip").click();
    await expect(places).toBeVisible();
  }
  // Close is an X.
  const close = places.getByRole("button", { name: "Close references" });
  await expect(close.locator("svg")).toHaveCount(1);
  await expect(close).toHaveText("Close references");
  const closeSquare = await taskReview.evaluate((review) => {
    const pane = review.shadowRoot
      .querySelector(".task-review-navigator-pane")
      .getBoundingClientRect();
    const places = review.shadowRoot.querySelector("caffold-review-places").shadowRoot;
    const button = places.querySelector(".review-places-close");
    const outset = Number.parseFloat(getComputedStyle(button, "::before").top);
    const box = button.getBoundingClientRect();
    const host = getComputedStyle(places.host);
    return {
      top: box.top + outset - pane.top,
      right: pane.right - (box.right - outset),
      height: box.height - 2 * outset,
      header: places.querySelector(".review-places-header").getBoundingClientRect().height,
      edge: [
        host.borderRightWidth,
        host.borderRightWidth === "0px" ? null : host.borderRightColor,
        host.borderBottomWidth,
        host.backgroundColor,
      ],
    };
  });
  await close.click();
  await expect(places).toBeHidden();
  // Its drawn square stood where the navigator's own control stands, in a
  // header as tall as the navigator's.
  const navigatorControl = await taskReview.evaluate((review) => {
    const root = review.shadowRoot;
    const pane = root.querySelector(".task-review-navigator-pane").getBoundingClientRect();
    const control = root
      .querySelector(".task-review-navigator-axis > caffold-segmented-control")
      .getBoundingClientRect();
    return {
      top: control.top - pane.top,
      right: pane.right - control.right,
      height: control.height,
      // The axis spans the header's height.
      header: root.querySelector(".task-review-navigator-axis").getBoundingClientRect().height,
    };
  });
  for (const edge of ["top", "right", "height", "header"]) {
    expect(Math.abs(closeSquare[edge] - navigatorControl[edge]), edge).toBeLessThan(0.1);
  }
  // Its edge toward the file is the file list's.
  const fileListEdge = await taskReview.evaluate((review) => {
    const list = review.shadowRoot
      .querySelector("caffold-file-navigator")
      .shadowRoot.querySelector("caffold-file-list");
    const style = getComputedStyle(list);
    return [
      style.borderRightWidth,
      style.borderRightWidth === "0px" ? null : style.borderRightColor,
      style.borderBottomWidth,
      style.backgroundColor,
    ];
  });
  expect(closeSquare.edge).toEqual(fileListEdge);
  if (testInfo.project.name !== "phone") {
    expect(fileListEdge[0]).toBe("1px");
  }
  await expect(page).not.toHaveURL(/find=/);
  await expect(taskReview.locator("caffold-file-navigator")).toBeVisible();
});

test("several definitions open the Definitions list", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page, {
    places: {
      definition: [
        { path: "src/example.rs", name: "example.rs", line: 1, character: 14, length: 4, text: "pub fn sample(name: &str) -> String {" },
        { path: "src/planner.rs", name: "planner.rs", line: 1, character: 7, length: 4, text: "pub fn name() {}" },
      ],
    },
  });
  const { threadId, taskReview } = await openSource(page);

  await codeName(taskReview, 2, "format").click({ modifiers: ["ControlOrMeta"] });
  const places = taskReview.locator("caffold-review-places");
  await expect(places.getByRole("heading", { level: 2 })).toHaveText("Definitions");
  await expect(places.locator(".review-places-meta")).toHaveText("format · 2");
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=example.rs&find=definitions&at=example.rs%3A2%3A5`,
  );
});

test("a reloaded list asks the server again", { tag: "@server-steady" }, async ({
  page,
}) => {
  const { asked } = await installLanguageServers(page, {
    places: {
      references: [
        { path: "src/example.rs", name: "example.rs", line: 1, character: 7, length: 6, text: "pub fn sample(name: &str) -> String {" },
      ],
    },
  });
  await installTaskReviewFixture(page);
  const taskScenario = await installTaskLoopFixture(page);
  await taskScenario.seedCompletedTask();
  await page.goto(
    `/tasks/${taskScenario.threadId}/review?nav=files&view=source&file=example.rs&find=references&at=example.rs%3A1%3A8`,
  );
  const places = page.locator("caffold-tasks-page caffold-review-places");

  await expect(places.locator(".review-places-meta")).toHaveText("sample · 1");
  expect(asked).toEqual([
    { kind: "references", path: "src/example.rs", ...SAMPLE },
  ]);
});

test("G marks the names in view, and a code opens the menu on Go to definition", { tag: "@server-steady" }, async ({
  page,
}, testInfo) => {
  await installLanguageServers(page, {
    places: { definition: [PLANNER_DEFINITION] },
  });
  const { threadId, taskReview } = await openSource(page);
  await waitForActionHintTarget(page, "sample, line 1");

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("g");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-look", "names");
  await expect(dialog.getByLabel(/, line \d+$/).first()).toBeVisible();
  await expect(dialog.getByLabel(/^[A-Z]+ — Show /)).toHaveCount(0);
  await captureReviewScreenshot(page, testInfo, "review-code-name-hints");

  const badge = dialog.getByLabel(/ — sample, line 1$/);
  const code = await badge.getAttribute("data-action-hint-code");
  await page.keyboard.type(code.toLowerCase());
  const goToDefinition = taskReview
    .locator("caffold-code-name-menu")
    .getByRole("button", { name: "Go to definition" });
  await expect(goToDefinition).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    `/tasks/${threadId}/review?nav=files&view=source&file=planner.rs&line=1`,
  );
});

test("G sits each badge over the start of its name, on the name's own line", { tag: "@server-steady" }, async ({ page }) => {
  await installLanguageServers(page);
  const { taskReview } = await openSource(page);
  await waitForActionHintTarget(page, "sample, line 1");

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("g");
  const badge = actionHintDialog(page).getByLabel(/ — sample, line 1$/);
  await expect(badge).toBeVisible();
  const name = codeName(taskReview, SAMPLE.line, "sample");
  await expect.poll(async () => {
    const [badgeBox, nameBox] = await Promise.all([badge.boundingBox(), name.boundingBox()]);
    return {
      atStart: Math.abs(badgeBox.x - nameBox.x) <= 0.5,
      onLine:
        Math.abs(badgeBox.y + badgeBox.height / 2 - (nameBox.y + nameBox.height / 2)) <= 0.5,
    };
  }).toEqual({ atStart: true, onLine: true });
});

test("F leaves the names to G", { tag: "@server-steady" }, async ({ page }) => {
  await installLanguageServers(page);
  await openSource(page);
  await waitForActionHintTarget(page, "sample, line 1");

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-look", "actions");
  await expect(dialog.getByLabel(/ — sample, line 1$/)).toHaveCount(0);
});

test("G does nothing with keyboard navigation off", { tag: "@server-steady" }, async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("caffold:settings", JSON.stringify({ actionHintsEnabled: false }));
  });
  await installLanguageServers(page);
  await openSource(page);
  await waitForActionHintTarget(page, "sample, line 1");

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press("g");
  await expect(actionHintDialog(page)).toBeHidden();
});

test("G reads the physical key, so a Korean input source opens it too", { tag: "@server-steady" }, async ({
  page,
}) => {
  await installLanguageServers(page);
  await openSource(page);
  await waitForActionHintTarget(page, "sample, line 1");

  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => {
    element.focus({ preventScroll: true });
    // A Korean input source types ㅎ on the G key.
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ㅎ",
        code: "KeyG",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  });
  await expect(actionHintDialog(page)).toHaveAttribute("data-look", "names");
});
