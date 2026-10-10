import { commandResult, isCommandEvent } from "../../command-runs.js";

// The one line a folded group shows: how many commands ran, and how many of
// them did not succeed, since those are what a reader opens the group for.
// The thinking folded in with them is not counted.
export function commandGroupPresentation(events = []) {
  const commands = events.filter(isCommandEvent);
  const results = commands.map(commandResult);
  const failed = results.filter((result) => result === "failed").length;
  const declined = results.filter((result) => result === "declined").length;
  return {
    label: `Ran ${commands.length} commands`,
    failed: failed ? `${failed} failed` : "",
    declined: declined ? `${declined} declined` : "",
  };
}
