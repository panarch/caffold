import assert from "node:assert/strict";
import test from "node:test";

import {
  REVIEW_SINGLE_PANE_MAX_WIDTH_PX,
  REVIEW_SINGLE_PANE_MEDIA_QUERY,
} from "./review-responsive.js";

test("defines one canonical review single-pane boundary", () => {
  assert.equal(REVIEW_SINGLE_PANE_MAX_WIDTH_PX, 860);
  assert.equal(REVIEW_SINGLE_PANE_MEDIA_QUERY, "(max-width: 860px)");
});
