import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const threadId = process.argv[2];
if (!threadId || threadId === "--help" || threadId === "-h") {
  const stream = threadId ? process.stdout : process.stderr;
  stream.write("usage: node scripts/dev/probe-codex-app-server.mjs THREAD_ID\n");
  process.exitCode = threadId ? 0 : 2;
} else {
  await probeThread(threadId);
}

async function probeThread(targetThreadId) {
  const child = spawn("codex", ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      process.stderr.write(`invalid app-server JSON: ${error.message}\n`);
      return;
    }
    if (message.id == null) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });

  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  function request(method, params, timeoutMs = 120_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timeout);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function measured(label, operation) {
    const startedAt = performance.now();
    const value = await operation();
    const elapsed = Math.round(performance.now() - startedAt);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    process.stdout.write(`${label}: ${elapsed}ms, ${bytes} bytes\n`);
    return value;
  }

  try {
    await request("initialize", {
      clientInfo: { name: "caffold-probe", version: "0" },
      capabilities: { experimentalApi: true },
      title: "Caffold probe",
    });
    notify("initialized", {});

    await measured("resume metadata", () =>
      request("thread/resume", { threadId: targetThreadId, excludeTurns: true }),
    );
    await measured("read metadata after resume", () =>
      request("thread/read", { threadId: targetThreadId, includeTurns: false }),
    );
    await measured("latest 1 full", () =>
      request("thread/turns/list", {
        threadId: targetThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
    await measured("latest 8 summary", () =>
      request("thread/turns/list", {
        threadId: targetThreadId,
        limit: 8,
        sortDirection: "desc",
        itemsView: "summary",
      }),
    );
    await measured("latest 8 full", () =>
      request("thread/turns/list", {
        threadId: targetThreadId,
        limit: 8,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
    await measured("second resume metadata", () =>
      request("thread/resume", { threadId: targetThreadId, excludeTurns: true }),
    );
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
