// What TypeScript modules use from task-list-model.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export function taskThreadId(
  task: { threadId?: string | null; id?: string | null } | null | undefined,
): string;
