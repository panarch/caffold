# Follow a conversation

A Task's **Conversation** shows the agent's conversation as it happens: your
prompts, the agent's messages, the work it does, and the approvals it asks
for.

![A finished Task: the prompt, the agent's answer, and its plan above the Composer](../assets/screenshots/task-conversation-desktop.png)

## What the conversation shows

- **Your prompts**, as you sent them, with their
  [attached files](start-a-task.md#attach-files).
- **The agent's messages**, formatted as Markdown. While a turn runs, its
  progress messages appear as they arrive.
- **The work**: commands with their output, changed files, reasoning
  summaries, and tool calls. When a turn finishes, its work folds into one
  **Worked for** line with the number of updates; choose it to unfold the work.
- **Approval requests** and how each was answered. See
  [Approvals](approvals.md).
- **How each turn ended**: completed, interrupted, or failed, with the error
  the agent reported.

![The same turn with its work unfolded: a progress message, the test command, and the changed files](../assets/screenshots/task-work-details-desktop.png)

**View output** on a command opens its full output. **View details** on a tool
call shows what the agent passed the tool and what came back.

## Read a diagram

A Mermaid code block in the agent's answer has a **Preview Mermaid** button.
Choose it to open the diagram in a dialog, and scroll the dialog to read a large
diagram. **Copy code** on the block copies the Mermaid source.

If the diagram cannot be drawn, the dialog shows why, with the source. Choose
**Retry** to try again.

## Copy an answer

Every message from the agent has a **Copy message** button, which copies the
message as Markdown.

## Earlier history

Scroll to the top of the conversation, or choose **Load older messages**, to
load earlier turns.

## Coming back to a Task

The Task list shows where each Task stands:

- a spinner while a turn is running;
- an alert when the Task is waiting for your approval, a question mark when it
  is waiting for your answer, and a warning when its turn failed;
- a dashed circle when its turn has finished but the agent still has work
  running in the background;
- a dot when a turn finished since you last opened the Task;
- otherwise, how long ago its last turn finished.

To be told when a turn ends or an approval is waiting, turn on
[Notifications](../get-started/notifications.md).
