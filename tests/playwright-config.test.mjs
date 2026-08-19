import assert from "node:assert/strict";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { caffoldLiveServerArguments } from "../frontend/tests/live/caffold-live-server.mjs";
import {
  createLivePlaywrightServer,
  createRegularPlaywrightServer,
} from "../frontend/tests/playwright-local-server.mjs";
import {
  PLAYWRIGHT_SERVER_HOST,
  playwrightServerOrigin,
  selectPlaywrightServerPort,
} from "../frontend/tests/playwright-server-port.mjs";

const repoRoot = resolve(import.meta.dirname, "..");

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(
      { exclusive: true, host: PLAYWRIGHT_SERVER_HOST, port },
      () => resolveListen(server.address().port),
    );
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

test("keeps independently selected server ownership isolated", async (t) => {
  const firstPort = await selectPlaywrightServerPort("UNSET_PORT", {});
  const firstServer = createServer();
  await listen(firstServer, firstPort);
  t.after(() => (firstServer.listening ? close(firstServer) : undefined));

  const secondPort = await selectPlaywrightServerPort("UNSET_PORT", {});
  const secondServer = createServer();
  await listen(secondServer, secondPort);
  t.after(() => (secondServer.listening ? close(secondServer) : undefined));

  assert.notEqual(secondPort, firstPort);
  await close(firstServer);
  assert.equal(secondServer.listening, true);
});

test("rejects an explicit port already owned by another process", async (t) => {
  const server = createServer();
  const port = await listen(server, 0);
  t.after(() => close(server));

  await assert.rejects(
    selectPlaywrightServerPort("CAFFOLD_E2E_PORT", {
      CAFFOLD_E2E_PORT: String(port),
    }),
    (error) => {
      assert.match(
        error.message,
        new RegExp(`CAFFOLD_E2E_PORT port ${port} is unavailable`),
      );
      assert.equal(error.cause?.code, "EADDRINUSE");
      return true;
    },
  );
});

test("regular config derives command, health URL, and base URL from one port", async () => {
  const port = await selectPlaywrightServerPort("UNSET_PORT", {});
  const origin = playwrightServerOrigin(port);
  const environment = {
    CAFFOLD_E2E_PORT: String(port),
  };
  const config = await createRegularPlaywrightServer(environment);

  assert.match(config.webServer.command, new RegExp(`--port ${port}(?: |$)`));
  assert.equal(config.webServer.url, `${origin}/api/health`);
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.baseURL, origin);
  assert.equal(environment.CAFFOLD_E2E_SELECTED_PORT, String(port));
});

test("reuses the invocation port when Playwright reloads its config", async (t) => {
  const environment = {};
  const firstConfig = await createRegularPlaywrightServer(environment);
  const port = Number(new URL(firstConfig.baseURL).port);
  const server = createServer();
  await listen(server, port);
  t.after(() => close(server));

  const workerConfig = await createRegularPlaywrightServer(environment);
  assert.equal(workerConfig.baseURL, firstConfig.baseURL);
  assert.equal(workerConfig.webServer.url, firstConfig.webServer.url);
  assert.equal(
    workerConfig.webServer.command,
    firstConfig.webServer.command,
  );
});

test("live config passes one selected port into its server helper", async () => {
  const port = await selectPlaywrightServerPort("UNSET_PORT", {});
  const origin = playwrightServerOrigin(port);
  const config = await createLivePlaywrightServer({
    codexBin: process.execPath,
    environment: { CAFFOLD_LIVE_PORT: String(port) },
    runtimeRoot: resolve(repoRoot, "target", "test-runtime"),
    serverScript: resolve(repoRoot, "tests", "live", "caffold-live-server.mjs"),
  });

  assert.equal(config.webServer.env.CAFFOLD_LIVE_PORT, String(port));
  assert.equal(config.webServer.url, `${origin}/api/health`);
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.baseURL, origin);

  const args = caffoldLiveServerArguments({
    port,
    runtimeRoot: resolve(repoRoot, "target", "test-runtime"),
  });
  assert.equal(args[args.indexOf("--port") + 1], String(port));
});
