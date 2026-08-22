export function usageWindowLabel(window) {
  // The window names the agent reports, in the Settings page's words.
  if (window?.model) {
    return `Weekly · ${window.model}`;
  }
  switch (window?.kind) {
    case "session":
      return "Session";
    case "weekly_all":
      return "Weekly";
    default:
      return window?.kind ?? "";
  }
}

/** One window as its row reads: how much is used, and when it lets go. */
export function usageWindowValue(window, formatReset = formatResetTime) {
  const percent = Number.isFinite(window?.percent)
    ? `${Math.round(window.percent)}% used`
    : "";
  const reset = window?.resetsAt ? formatReset(window.resetsAt) : "";
  return reset ? `${percent} · resets ${reset}` : percent;
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

/** The runner's idle timeout as its row reads — never "0 min" for a real one. */
export function idleTimeoutValue(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.round(seconds / 60)} min`;
}
