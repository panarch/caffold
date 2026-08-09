import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const runtimeRoot = resolve(process.env.CAFFOLD_LIVE_RUNTIME_ROOT ?? "");
const ownedTargetRoot = resolve(process.cwd(), "target");
if (!runtimeRoot.startsWith(`${ownedTargetRoot}${sep}`)) {
  throw new Error(
    `CAFFOLD_LIVE_RUNTIME_ROOT must be an owned directory below ${ownedTargetRoot}`,
  );
}

const child = spawn(
  "cargo",
  [
    "run",
    "--quiet",
    "--",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "55178",
    "--data-dir",
    join(runtimeRoot, "data"),
    "--worktree-root",
    join(runtimeRoot, "worktrees"),
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  },
);

let forwardedSignal = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardedSignal = signal;
    child.kill(signal);
  });
}

child.on("error", (error) => {
  rmSync(runtimeRoot, { recursive: true, force: true });
  throw error;
});

child.on("exit", (code, signal) => {
  rmSync(runtimeRoot, { recursive: true, force: true });
  if (forwardedSignal) {
    process.exitCode = 0;
  } else if (code !== null) {
    process.exitCode = code;
  } else {
    process.exitCode = signal ? 1 : 0;
  }
});
