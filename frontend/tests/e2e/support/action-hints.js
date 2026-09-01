import { expect } from "@playwright/test";

export function actionHintDialog(page) {
  return page.locator("caffold-action-hint-dialog > dialog:modal");
}

export function actionHintBadgePresentation(badge) {
  return badge.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.cssText = `
      position: fixed;
      visibility: hidden;
      background: var(--primary-control-bg);
      color: var(--text-inverse);
    `;
    document.body.append(probe);
    const style = getComputedStyle(element);
    const expected = getComputedStyle(probe);
    const result = {
      backgroundMatches: style.backgroundColor === expected.backgroundColor,
      borderVisible: Number.parseFloat(style.borderTopWidth) > 0,
      colorMatches: style.color === expected.color,
      hasBlockPadding: Number.parseFloat(style.paddingTop) > 0,
      position: style.position,
    };
    probe.remove();
    return result;
  });
}

export async function enterActionHints(page) {
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function waitForActionHintTarget(page, accessibleName) {
  await expect.poll(async () => {
    const labels = await page.locator("caffold-task-workspace").evaluate(
      (workspace) => workspace.actionHintScope().targets.map((target) => target.label),
    );
    return labels.some((label) => accessibleName instanceof RegExp
      ? accessibleName.test(label)
      : label === accessibleName);
  }).toBe(true);
}

export async function activateActionHint(page, accessibleName) {
  await waitForActionHintTarget(page, accessibleName);
  const dialog = await enterActionHints(page);
  const badge = dialog.getByLabel(accessibleName);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await page.keyboard.type(code.toLowerCase());
  await expect(dialog).toBeHidden();
  return code;
}
