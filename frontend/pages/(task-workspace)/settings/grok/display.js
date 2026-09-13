export function usagePeriodLabel(period) {
  const type = period?.type;
  if (!type) {
    return "Usage";
  }
  if (!type.startsWith("USAGE_PERIOD_TYPE_")) {
    return type;
  }
  return type
    .slice("USAGE_PERIOD_TYPE_".length)
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ") || "Usage";
}

/** The plan row: how much is used, and when the period lets go. */
export function usagePeriodValue(usage, formatReset = formatResetTime) {
  const percent = Number.isFinite(usage?.percent)
    ? `${Math.round(usage.percent)}% used`
    : "";
  const reset = usage?.period?.end ? formatReset(usage.period.end) : "";
  if (percent && reset) {
    return `${percent} · resets ${reset}`;
  }
  return reset ? `resets ${reset}` : percent;
}

export function onDemandValue(meter) {
  const parts = [];
  if (Number.isFinite(meter?.used)) {
    parts.push(`${meter.used} used`);
  }
  if (Number.isFinite(meter?.cap)) {
    parts.push(`cap ${meter.cap}`);
  }
  return parts.join(" · ");
}

export function prepaidValue(meter) {
  return Number.isFinite(meter?.balance) ? String(meter.balance) : "";
}

function formatResetTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const sameDay = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(undefined, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
