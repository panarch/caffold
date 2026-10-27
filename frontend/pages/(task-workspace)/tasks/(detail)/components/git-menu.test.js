import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./git-menu.js");
const gitMenu = registry.element("caffold-task-detail-git").prototype;
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
  const owner = Object.create(gitMenu, Object.getOwnPropertyDescriptors({
    gitPopover: { value: popover },
  }));

  gitMenu.handleDismiss.call(owner, { target: {} });
  assert.equal(hidden, 0);
  gitMenu.handleDismiss.call(owner, { target: popover });
  assert.equal(hidden, 1);
});
