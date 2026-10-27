import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_SUBMISSION_EVENT as EVENT,
  PROMPT_SUBMISSION_NODE as NODE,
  nextPromptSubmissionNode,
} from "./prompt-submission.js";

const ALLOWED = [
  [NODE.IDLE, EVENT.SUBMIT, NODE.SENDING],
  [NODE.IDLE, EVENT.SUBMIT_WITH_FILES, NODE.UPLOADING],
  [NODE.UPLOADING, EVENT.FILE_UPLOADED, NODE.UPLOADING],
  [NODE.UPLOADING, EVENT.FILES_UPLOADED, NODE.SENDING],
  [NODE.UPLOADING, EVENT.UPLOAD_FAILED, NODE.IDLE],
  [NODE.UPLOADING, EVENT.STOP, NODE.IDLE],
  [NODE.SENDING, EVENT.PROMPT_ACCEPTED, NODE.ACCEPTED],
  [NODE.SENDING, EVENT.PROMPT_REJECTED, NODE.IDLE],
  [NODE.SENDING, EVENT.PROMPT_OUTCOME_UNKNOWN, NODE.IDLE],
  [NODE.ACCEPTED, EVENT.CANONICAL_CONFIRMED, NODE.IDLE],
  [NODE.ACCEPTED, EVENT.SUBMIT, NODE.SENDING],
  [NODE.ACCEPTED, EVENT.SUBMIT_WITH_FILES, NODE.UPLOADING],
];

test("every allowed edge leads where the pending prompt goes next", () => {
  for (const [node, event, next] of ALLOWED) {
    assert.equal(nextPromptSubmissionNode(node, event), next, `${node} --${event}-->`);
  }
});

test("every other event is refused where it does not belong", () => {
  const allowed = new Set(ALLOWED.map(([node, event]) => `${node}:${event}`));
  const refused = Object.values(NODE).flatMap((node) =>
    Object.values(EVENT)
      .filter((event) => !allowed.has(`${node}:${event}`))
      .map((event) => [node, event]),
  );

  for (const [node, event] of refused) {
    assert.equal(nextPromptSubmissionNode(node, event), null, `${node} --${event}-->`);
  }
  // The ones a reader would reach for first.
  assert.equal(nextPromptSubmissionNode(NODE.UPLOADING, EVENT.SUBMIT), null);
  assert.equal(nextPromptSubmissionNode(NODE.SENDING, EVENT.SUBMIT_WITH_FILES), null);
  assert.equal(nextPromptSubmissionNode(NODE.SENDING, EVENT.STOP), null);
  assert.equal(nextPromptSubmissionNode(NODE.ACCEPTED, EVENT.STOP), null);
  assert.equal(nextPromptSubmissionNode(NODE.IDLE, EVENT.UPLOAD_FAILED), null);
});

test("an upload that ends after a stop, or a late answer, is stale", () => {
  const stopped = nextPromptSubmissionNode(NODE.UPLOADING, EVENT.STOP);

  assert.equal(nextPromptSubmissionNode(stopped, EVENT.FILES_UPLOADED), null);
  assert.equal(nextPromptSubmissionNode(stopped, EVENT.UPLOAD_FAILED), null);
  assert.equal(nextPromptSubmissionNode(stopped, EVENT.PROMPT_ACCEPTED), null);
  assert.equal(nextPromptSubmissionNode("unknown", EVENT.SUBMIT), null);
});
