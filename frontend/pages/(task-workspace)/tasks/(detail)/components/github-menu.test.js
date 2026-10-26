import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./github-menu.ts");
const githubMenu = registry.element("caffold-task-detail-github").prototype;
after(() => registry.restore());

test("closes its popover when the bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    open: true,
    matches() {
      return this.open;
    },
    hidePopover() {
      hidden += 1;
      this.open = false;
    },
  };
  const owner = Object.create(githubMenu, Object.getOwnPropertyDescriptors({
    githubPopover: { value: popover },
  }));

  githubMenu.handleDismiss.call(owner, { target: {} });
  assert.equal(hidden, 0);
  githubMenu.handleDismiss.call(owner, { target: popover });
  assert.equal(hidden, 1);
});
