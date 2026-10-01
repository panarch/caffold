import { expect } from "@playwright/test";

export function actionHintDialog(page) {
  return page.locator("caffold-action-hint-dialog > dialog:modal");
}

export function popoverActionHintDialog(page) {
  return page.locator(
    ":popover-open caffold-action-hint-dialog > dialog:modal",
  );
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
  const surface = page.locator(".task-workspace-surface");
  await surface.evaluate((element) => element.focus({ preventScroll: true }));
  await expect(surface).toBeFocused();
  await page.keyboard.press("f");
  const dialog = actionHintDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function waitForActionHintTarget(page, accessibleName) {
  await expect.poll(async () => {
    const labels = await page.locator("caffold-app-shell").evaluate(
      (shell) => shell.actionHintScope().targets.map((target) => target.label),
    );
    return labels.some((label) => accessibleName instanceof RegExp
      ? accessibleName.test(label)
      : label === accessibleName);
  }).toBe(true);
}

// Independently classify the owner-declared controls from their actual painted
// rectangles, so browser expectations do not call the production visibility model.
export async function workspaceOcclusionTargets(page, ownerSelector) {
  return page.evaluate((selector) => {
    const owner = document.querySelector(selector);
    const panel = document.querySelector("caffold-task-workspace-navigation").getBoundingClientRect();
    const viewport = window.visualViewport;
    const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      right: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
      bottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) };
    const result = { covered: [], clear: [] };
    for (const target of document.querySelector("caffold-app-shell").actionHintScope().targets) {
      if (!owner.contains(target.anchor) || !target.isActionable()) continue;
      const anchor = target.anchor.getBoundingClientRect();
      const clips = [bounds, anchor, ...target.clipRoots.map((root) => root.getBoundingClientRect())];
      const left = Math.max(...clips.map((rect) => rect.left));
      const top = Math.max(...clips.map((rect) => rect.top));
      const right = Math.min(...clips.map((rect) => rect.right));
      const bottom = Math.min(...clips.map((rect) => rect.bottom));
      const x = (anchor.left + anchor.right) / 2, y = (anchor.top + anchor.bottom) / 2;
      if (right <= left || bottom <= top || x < left || x > right || y < top || y > bottom) continue;
      const covered = Math.min(right, panel.right) > Math.max(left, panel.left) &&
        Math.min(bottom, panel.bottom) > Math.max(top, panel.top);
      result[covered ? "covered" : "clear"].push(target.label);
    }
    return result;
  }, ownerSelector);
}

export async function activateActionHint(page, accessibleName) {
  const { code, dialog } = await typeActionHintCode(page, accessibleName);
  await expect(dialog).toBeHidden();
  await expectActionHintActivated(page, code);
  return code;
}

export async function activateActionHintIntoPopover(page, accessibleName) {
  const { code } = await typeActionHintCode(page, accessibleName);
  await expect(popoverActionHintDialog(page)).toBeVisible();
  await expectActionHintActivated(page, code);
  return code;
}

async function typeActionHintCode(page, accessibleName) {
  await waitForActionHintTarget(page, accessibleName);
  const dialog = await enterActionHints(page);
  const badge = dialog.getByLabel(accessibleName);
  await expect(badge).toBeVisible();
  const code = await badge.getAttribute("data-action-hint-code");
  expect(code).toMatch(/^[A-Z]+$/);
  await page.keyboard.type(code.toLowerCase());
  return { code, dialog };
}

async function expectActionHintActivated(page, code) {
  await expect(page.locator("caffold-app-shell")).toHaveAttribute(
    "data-action-hint-last-exit",
    `activated:${code}`,
  );
}
