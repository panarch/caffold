import { execFile, spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { ws as WebSocket } from "playwright-core/lib/utilsBundle";

import { resolveCodexBin } from "./codex-bin.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

async function daemonSocketPath() {
  const { stdout } = await execFileAsync(
    resolveCodexBin(),
    ["app-server", "daemon", "start"],
    { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS },
  );
  const daemon = JSON.parse(stdout);
  if (typeof daemon.socketPath !== "string" || !daemon.socketPath) {
    throw new Error(`Codex daemon did not report socketPath: ${stdout}`);
  }
  return daemon.socketPath;
}

function waitForEvent(target, name, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(name, resolveEvent);
      target.removeEventListener("error", rejectEvent);
    };
    const resolveEvent = (event) => {
      cleanup();
      resolve(event);
    };
    const rejectEvent = (event) => {
      cleanup();
      reject(event.error ?? new Error("WebSocket connection failed"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket ${name}`));
    }, timeoutMs);
    target.addEventListener(name, resolveEvent, { once: true });
    target.addEventListener("error", rejectEvent, { once: true });
  });
}

export class CodexDaemonClient {
  static async connect() {
    const socketPath = await daemonSocketPath();
    const child = spawn(
      resolveCodexBin(),
      ["app-server", "proxy", "--sock", socketPath],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const stream = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    try {
      const socket = new WebSocket("ws://localhost/", {
        createConnection: () => stream,
        perMessageDeflate: false,
      });
      await waitForEvent(socket, "open");
      const client = new CodexDaemonClient({
        child,
        stream,
        socket,
        stderr: () => stderr,
      });
      await client.request("initialize", {
        clientInfo: {
          name: "caffold-live-daemon-client",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
        title: "Caffold live daemon client",
      });
      client.notify("initialized", {});
      return client;
    } catch (error) {
      stream.destroy();
      child.kill("SIGTERM");
      const diagnostic = stderr.trim();
      throw new Error(
        `Failed to connect a second client to the Codex daemon: ${error.message}${diagnostic ? `\n${diagnostic}` : ""}`,
        { cause: error },
      );
    }
  }

  constructor({ child, stream, socket, stderr }) {
    this.child = child;
    this.stream = stream;
    this.socket = socket;
    this.stderr = stderr;
    this.nextId = 100;
    this.pending = new Map();
    this.closed = false;
    this.socket.addEventListener("message", (event) => this.handleMessage(event));
    this.socket.addEventListener("close", () => {
      this.rejectPending(new Error("Codex daemon proxy connection closed"));
    });
    this.socket.addEventListener("error", () => {
      this.rejectPending(new Error("Codex daemon proxy connection failed"));
    });
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new Error("Codex daemon client is closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex ${method} response`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method, params) {
    if (this.closed) {
      throw new Error("Codex daemon client is closed");
    }
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async resumeThread(threadId) {
    return await this.request("thread/resume", {
      threadId,
      serviceTier: null,
      excludeTurns: true,
      initialTurnsPage: {
        limit: 8,
        sortDirection: "desc",
        itemsView: "full",
      },
    });
  }

  async startTurn({ threadId, cwd, prompt, model, effort }) {
    return await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd,
      runtimeWorkspaceRoots: [cwd],
      model,
      effort,
      serviceTier: null,
    });
  }

  handleMessage(event) {
    let message;
    try {
      const text =
        typeof event.data === "string"
          ? event.data
          : Buffer.from(event.data).toString("utf8");
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method || message.id == null) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new Error(`Codex ${pending.method} failed: ${JSON.stringify(message.error)}`),
      );
      return;
    }
    pending.resolve(message.result);
  }

  rejectPending(error) {
    const diagnostic = this.stderr().trim();
    const rejection = diagnostic
      ? new Error(`${error.message}\n${diagnostic}`, { cause: error })
      : error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(rejection);
    }
    this.pending.clear();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectPending(new Error("Codex daemon client closed"));
    this.socket.close();
    this.stream.destroy();
    if (this.child.exitCode !== null) {
      return;
    }
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      }),
    ]);
  }
}
