import {
  PLAYWRIGHT_SERVER_HOST,
  parsePlaywrightServerPort,
  playwrightServerOrigin,
  selectPlaywrightServerPort,
} from "./playwright-server-port.mjs";

async function selectInvocationPort({
  environment,
  overrideVariable,
  selectedVariable,
}) {
  const selected = environment[selectedVariable];
  if (selected !== undefined) {
    return parsePlaywrightServerPort(selected, selectedVariable);
  }

  const port = await selectPlaywrightServerPort(
    overrideVariable,
    environment,
  );
  environment[selectedVariable] = String(port);
  return port;
}

export async function createRegularPlaywrightServer(
  environment = process.env,
) {
  const port = await selectInvocationPort({
    environment,
    overrideVariable: "CAFFOLD_E2E_PORT",
    selectedVariable: "CAFFOLD_E2E_SELECTED_PORT",
  });
  const baseURL = playwrightServerOrigin(port);
  return {
    baseURL,
    webServer: {
      command: `cargo run -- serve --host ${PLAYWRIGHT_SERVER_HOST} --port ${port} --root tests/fixtures/home --data-dir tests/fixtures/.caffold-data --worktree-root tests/fixtures/home/.caffold-worktrees`,
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  };
}

export async function createLivePlaywrightServer({
  codexBin,
  environment = process.env,
  execPath = process.execPath,
  runtimeRoot,
  serverScript,
}) {
  const port = await selectInvocationPort({
    environment,
    overrideVariable: "CAFFOLD_LIVE_PORT",
    selectedVariable: "CAFFOLD_LIVE_SELECTED_PORT",
  });
  const baseURL = playwrightServerOrigin(port);
  return {
    baseURL,
    webServer: {
      command: `${JSON.stringify(execPath)} ${JSON.stringify(serverScript)}`,
      url: `${baseURL}/api/health`,
      env: {
        ...environment,
        CAFFOLD_CODEX_BIN: codexBin,
        CAFFOLD_LIVE_PORT: String(port),
        CAFFOLD_LIVE_RUNTIME_ROOT: runtimeRoot,
      },
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  };
}
