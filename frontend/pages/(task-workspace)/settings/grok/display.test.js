import assert from "node:assert/strict";
import test from "node:test";

import {
  onDemandValue,
  prepaidValue,
  usagePeriodLabel,
  usagePeriodValue,
} from "./display.js";

test("usage periods read in this page's words, and unknown types in their own", () => {
  assert.equal(usagePeriodLabel({ type: "USAGE_PERIOD_TYPE_WEEKLY" }), "Weekly");
  assert.equal(usagePeriodLabel({ type: "USAGE_PERIOD_TYPE_MONTHLY" }), "Monthly");
  assert.equal(usagePeriodLabel({ type: "USAGE_PERIOD_TYPE_ALL_MODELS" }), "All Models");
  assert.equal(usagePeriodLabel({ type: "weekly" }), "weekly");
  assert.equal(usagePeriodLabel({}), "Usage");
  assert.equal(usagePeriodLabel(undefined), "Usage");
});

test("the plan row is used percent and the period's end, never a remaining figure", () => {
  const value = usagePeriodValue(
    {
      percent: 8,
      period: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-14T06:12:36.569711+00:00" },
    },
    () => "Sep 14, 3:12 AM",
  );
  assert.equal(value, "8% used · resets Sep 14, 3:12 AM");
  assert.equal(usagePeriodValue({ percent: 8.4 }, () => ""), "8% used");
  assert.equal(
    usagePeriodValue({ period: { end: "not-a-time" } }, () => ""),
    "",
  );
  assert.equal(
    usagePeriodValue({ period: { end: "2026-09-14T06:12:36.569711+00:00" } }, () => "Sep 14"),
    "resets Sep 14",
  );
});

test("on-demand and prepaid rows only format the meters they were given", () => {
  assert.equal(onDemandValue({ used: 25, cap: 100 }), "25 used · cap 100");
  assert.equal(onDemandValue({ used: 5 }), "5 used");
  assert.equal(onDemandValue({ cap: 40 }), "cap 40");
  assert.equal(prepaidValue({ balance: 12 }), "12");
  assert.equal(prepaidValue({}), "");
});
