import assert from "node:assert/strict";
import test from "node:test";
import { quotaRow } from "./usage.js";

const allowance = {
  key: "premium_interactions", unit: "aiCredits", unlimited: false,
  used: 0.0000001, entitlement: 2, remainingPercentage: 99.99,
  resetsAt: null, resetEstimated: false,
};

test("Copilot formats the reported unit, fractional usage and zero independently", () => {
  const row = quotaRow(allowance);
  assert.equal(row.label, "AI credits");
  const amount = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 15 }).format(allowance.used);
  assert.ok(row.value.startsWith(`${amount} of 2 used`));
  assert.equal(quotaRow({ ...allowance, unit: "requests", used: 2, remainingPercentage: 0 }).value,
    "2 of 2 requests used · 0% remaining");
  assert.equal(quotaRow({ ...allowance, key: "other_quota", unit: null, used: 0, remainingPercentage: 100 }).value,
    "0 of 2 used · 100% remaining");
  assert.equal(quotaRow({ ...allowance, entitlement: 0, unlimited: true }).value, "Unlimited");
});

test("a date-only Copilot reset keeps its calendar day and has no invented time", () => {
  const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date("2027-01-01"));
  assert.ok(quotaRow({ ...allowance, resetsAt: "2027-01-01" }).value.endsWith(`resets ${day}`));
  assert.ok(quotaRow({ ...allowance, resetsAt: "2027-01-01", resetEstimated: true }).value.endsWith(`estimated reset ${day}`));
});
