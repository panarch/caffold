import type { SectionDirectory } from "#app/api.js";

// One owner accepts path checks, explicit submission, and lifecycle changes.
// Directory observations and the child folder browser remain separate data.
// Complete control edges:
// - inactive -> checking: activate
// - checking -> editing: checked or failed
// - editing -> checking: recheck
// - editing -> submitting: submit with a verified missing path and candidate
// - editing -> editing: choose
// - submitting -> checking: reconnected
// - submitting -> editing: failed
// - any node -> inactive: deactivate
// All other events, including stale completions, leave the node unchanged.
export interface RecoveryState {
  phase: "inactive" | "checking" | "editing" | "submitting";
  generation: number;
  directory: SectionDirectory | null;
  candidate: string | null;
  error: string;
}

export type RecoveryEvent =
  | { type: "activate" | "deactivate" | "recheck" | "submit" }
  | { type: "choose"; path: string }
  | {
      type: "checked" | "reconnected";
      generation: number;
      directory: SectionDirectory;
    }
  | { type: "failed"; generation: number; message: string };

export const initialRecoveryState = (): RecoveryState => ({
  phase: "inactive",
  generation: 0,
  directory: null,
  candidate: null,
  error: "",
});

export function reduceRecovery(
  state: RecoveryState,
  event: RecoveryEvent,
): RecoveryState {
  switch (event.type) {
    case "deactivate":
      return { ...initialRecoveryState(), generation: state.generation + 1 };
    case "activate":
      return state.phase === "inactive"
        ? { ...state, phase: "checking", generation: state.generation + 1 }
        : state;
    case "recheck":
      return state.phase === "editing"
        ? {
            ...state,
            phase: "checking",
            error: "",
            generation: state.generation + 1,
          }
        : state;
    case "choose":
      return state.phase === "editing"
        ? { ...state, candidate: event.path, error: "" }
        : state;
    case "submit":
      return state.phase === "editing" &&
        state.candidate !== null &&
        state.directory?.directory.status === "missing" &&
        !state.directory.reconnectUnavailableReason
        ? {
            ...state,
            phase: "submitting",
            error: "",
            generation: state.generation + 1,
          }
        : state;
    case "checked":
      return state.phase === "checking" && event.generation === state.generation
        ? { ...state, phase: "editing", directory: event.directory, error: "" }
        : state;
    case "reconnected":
      return state.phase === "submitting" &&
        event.generation === state.generation
        ? {
            ...state,
            phase: "checking",
            directory: event.directory,
            generation: state.generation + 1,
          }
        : state;
    case "failed":
      return ["checking", "submitting"].includes(state.phase) &&
        event.generation === state.generation
        ? { ...state, phase: "editing", error: event.message }
        : state;
  }
}
