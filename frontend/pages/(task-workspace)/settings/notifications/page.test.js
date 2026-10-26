import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.ts");
const notifications = registry.element(
  "caffold-settings-notifications-page",
).prototype;
after(() => registry.restore());

test("notification permission is requested only by the explicit Enable action", () => {
  const pagePath = fileURLToPath(new URL("./page.ts", import.meta.url));
  const source = readFileSync(pagePath, "utf8");
  const enable = source.slice(
    source.indexOf("private enable() {"),
    source.indexOf("private async subscribe("),
  );
  assert.equal(source.match(/Notification\.requestPermission\(\)/g)?.length, 1);
  assert.match(enable, /^private enable\(\) \{\n\s+const permissionRequest = Notification\.requestPermission\(\);/);
  assert.match(source, /@click=\$\{this\.enable\}/);
});

