import { expect } from "@playwright/test";

export function actionHintDialog(page) {
  return page.locator("caffold-action-hint-dialog > dialog");
}

export async function enterActionHints(page) {
  await page.locator(".task-workspace-surface").focus();
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function activateActionHint(page, accessibleName) {
  await expect.poll(async () => {
    const labels = await page.locator("caffold-task-workspace").evaluate(
      (workspace) => workspace.actionHintScope().targets.map((target) => target.label),
    );
    return labels.some((label) => accessibleName instanceof RegExp
      ? accessibleName.test(label)
      : label === accessibleName);
  }).toBe(true);
  const dialog = await enterActionHints(page);
  const badge = dialog.getByLabel(accessibleName);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await page.keyboard.type(code.toLowerCase());
  await expect(dialog).toBeHidden();
  return code;
}
