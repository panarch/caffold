import type { TaskEvent } from "#app/api.js";
import {
  commandResult,
  type FinishedRunKind,
  isCommandEvent,
} from "../../finished-runs.js";

// The one line a folded group shows: how many commands ran or tools were
// called, and how many of them did not succeed, since those are what a reader
// opens the group for. The thinking folded in with them is not counted.
export function runGroupPresentation(
  kind: FinishedRunKind,
  events: TaskEvent[] = [],
) {
  const results =
    kind === "command"
      ? events.filter(isCommandEvent).map(commandResult)
      : events
          .filter((event) => event.type === "tool_call")
          .map(toolCallResult);
  const failed = results.filter((result) => result === "failed").length;
  const declined = results.filter((result) => result === "declined").length;
  return {
    label:
      kind === "command"
        ? `Ran ${results.length} commands`
        : `Called ${results.length} tools`,
    failed: failed ? `${failed} failed` : "",
    declined: declined ? `${declined} declined` : "",
  };
}

// A tool call has no exit code; its status alone says how it ended.
function toolCallResult(event: TaskEvent) {
  return `${event.payload?.status ?? ""}`.trim();
}
