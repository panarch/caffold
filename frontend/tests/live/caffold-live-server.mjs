import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { repositoryRoot } from "../repository-paths.mjs";
import { pathToFileURL } from "node:url";

import { parsePlaywrightServerPort } from "../playwright-server-port.mjs";

export function caffoldLiveServerArguments({ port, runtimeRoot }) {
  return [
    "run",
    "--quiet",
    "--",
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--data-dir",
    join(runtimeRoot, "data"),
    "--worktree-root",
    join(runtimeRoot, "worktrees"),
  ];
}

export function runCaffoldLiveServer({
  cwd = repositoryRoot,
  environment = process.env,
} = {}) {
  const runtimeRoot = resolve(environment.CAFFOLD_LIVE_RUNTIME_ROOT ?? "");
  const ownedTargetRoot = resolve(cwd, "target");
  if (!runtimeRoot.startsWith(`${ownedTargetRoot}${sep}`)) {
    throw new Error(
      `CAFFOLD_LIVE_RUNTIME_ROOT must be an owned directory below ${ownedTargetRoot}`,
    );
  }

  const port = parsePlaywrightServerPort(
    environment.CAFFOLD_LIVE_PORT,
    "CAFFOLD_LIVE_PORT",
  );
  const child = spawn(
    "cargo",
    caffoldLiveServerArguments({ port, runtimeRoot }),
    {
      cwd,
      env: environment,
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

  return child;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runCaffoldLiveServer();
}
