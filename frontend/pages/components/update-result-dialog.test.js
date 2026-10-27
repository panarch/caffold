import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const { updateResultNotice } = await import("./update-result-dialog.js");
after(() => registry.restore());

test("tells a rollback with the reason the attempt recorded", () => {
  assert.deepEqual(
    updateResultNotice({
      outcome: "rolledBack",
      fromVersion: "0.18.2",
      toVersion: "0.18.3",
      reason: "0.18.3 could not start",
    }),
    {
      title: "Caffold update was rolled back",
      description:
        "0.18.3 could not start, so Caffold 0.18.2 was restored. See Settings → About Caffold for details.",
    },
  );
  assert.deepEqual(
    updateResultNotice({
      outcome: "rolledBack",
      fromVersion: "0.18.2",
      reason: "Caffold did not quit",
    }).description,
    "Caffold did not quit, so Caffold 0.18.2 was restored. See Settings → About Caffold for details.",
  );
});

test("tells a restore that failed as a failed update", () => {
  assert.deepEqual(
    updateResultNotice({
      outcome: "restoreFailed",
      fromVersion: "0.18.2",
      toVersion: "0.18.3",
      reason: "0.18.3 could not start, and 0.18.2 could not be restored",
    }),
    {
      title: "Caffold update failed",
      description:
        "0.18.3 could not start, and 0.18.2 could not be restored. See Settings → About Caffold for details.",
    },
  );
});

test("leaves every other outcome to other surfaces", () => {
  for (const outcome of [
    "running",
    "succeeded",
    "upToDate",
    "homebrewFailed",
    "interrupted",
  ]) {
    assert.equal(updateResultNotice({ outcome, fromVersion: "0.18.2" }), null);
  }
  assert.equal(updateResultNotice(null), null);
});
