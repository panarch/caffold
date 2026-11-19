import type { CopilotQuota } from "#app/api.js";
import type { SettingsDetailRow } from "../components/detail-list.js";

export function quotaRow(quota: CopilotQuota): SettingsDetailRow {
  let label = quota.key.replaceAll("_", " ");
  if (quota.key === "premium_interactions") {
    label = quota.unit === "aiCredits" ? "AI credits" : "Premium interactions";
  } else if (quota.key === "completions") {
    label = "Code completions";
  } else {
    label = label.charAt(0).toUpperCase() + label.slice(1);
  }

  if (quota.unlimited) return { key: quota.key, label, value: "Unlimited" };

  const unit = quota.unit && units[quota.unit];
  const used = `${amounts.format(quota.used)} of ${amounts.format(quota.entitlement)}`;
  const details = [
    unit && unit !== label ? `${used} ${unit} used` : `${used} used`,
    `${amounts.format(quota.remainingPercentage)}% remaining`,
  ];
  if (quota.resetsAt) {
    const instant = new Date(quota.resetsAt);
    if (Number.isFinite(instant.getTime())) {
      // A date-only allowance has no reset hour or timezone to convert.
      const formatter = /^\d{4}-\d{2}-\d{2}$/.test(quota.resetsAt)
        ? days
        : dates;
      const reset = formatter.format(instant);
      details.push(
        quota.resetEstimated ? `estimated reset ${reset}` : `resets ${reset}`,
      );
    }
  }
  return { key: quota.key, label, value: details.join(" · ") };
}

const amounts = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 15,
});
const dates = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const days = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC",
});
const units = {
  aiCredits: "AI credits",
  requests: "requests",
  tokens: "tokens",
};
