// A Task's pending prompt, from Send until the agent's own history holds it.
//
// A Task holds at most one. Its files go up one at a time, then the prompt is
// sent; the agent's answer to the request names the message, and a canonical
// event carrying that name retires it. Stop, an upload's end, the prompt
// request's answer, and the canonical stream all arrive independently, so each
// is accepted only from the node it belongs to — anything else is a stale
// arrival for a pending prompt that has moved on.
//
// Idle is the absence of a pending prompt. An accepted prompt still waiting
// for its canonical event does not hold the Composer back: a new prompt may be
// sent, and it takes the old one's place.

export const PROMPT_SUBMISSION_NODE = Object.freeze({
  IDLE: "idle",
  UPLOADING: "uploading",
  SENDING: "sending",
  ACCEPTED: "accepted",
});

export const PROMPT_SUBMISSION_EVENT = Object.freeze({
  SUBMIT: "submit",
  SUBMIT_WITH_FILES: "submitWithFiles",
  FILE_UPLOADED: "fileUploaded",
  FILES_UPLOADED: "filesUploaded",
  UPLOAD_FAILED: "uploadFailed",
  STOP: "stop",
  PROMPT_ACCEPTED: "promptAccepted",
  PROMPT_REJECTED: "promptRejected",
  PROMPT_OUTCOME_UNKNOWN: "promptOutcomeUnknown",
  CANONICAL_CONFIRMED: "canonicalConfirmed",
});

const { IDLE, UPLOADING, SENDING, ACCEPTED } = PROMPT_SUBMISSION_NODE;
const EVENT = PROMPT_SUBMISSION_EVENT;

// Every allowed edge. An event missing from a node's row is refused there.
const EDGES = Object.freeze({
  [IDLE]: {
    [EVENT.SUBMIT]: SENDING,
    [EVENT.SUBMIT_WITH_FILES]: UPLOADING,
  },
  [UPLOADING]: {
    [EVENT.FILE_UPLOADED]: UPLOADING,
    [EVENT.FILES_UPLOADED]: SENDING,
    [EVENT.UPLOAD_FAILED]: IDLE,
    [EVENT.STOP]: IDLE,
  },
  [SENDING]: {
    [EVENT.PROMPT_ACCEPTED]: ACCEPTED,
    [EVENT.PROMPT_REJECTED]: IDLE,
    [EVENT.PROMPT_OUTCOME_UNKNOWN]: IDLE,
  },
  [ACCEPTED]: {
    [EVENT.CANONICAL_CONFIRMED]: IDLE,
    [EVENT.SUBMIT]: SENDING,
    [EVENT.SUBMIT_WITH_FILES]: UPLOADING,
  },
});

/** The node an event leads to from `node`, or null where it is refused. */
export function nextPromptSubmissionNode(node, event) {
  return EDGES[node]?.[event] ?? null;
}
