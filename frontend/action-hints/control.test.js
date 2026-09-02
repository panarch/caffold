import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_HINT_ACTIVATE_EVENT,
  ACTION_HINT_CANCEL_EVENT,
} from "./control.js";

test("keeps Action Hint presentation events inside the Action Hint boundary", () => {
  assert.equal(ACTION_HINT_ACTIVATE_EVENT, "caffold:action-hint-activate");
  assert.equal(ACTION_HINT_CANCEL_EVENT, "caffold:action-hint-cancel");
});
