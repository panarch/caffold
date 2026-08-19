import { createServer } from "node:net";

export const PLAYWRIGHT_SERVER_HOST = "127.0.0.1";

export function parsePlaywrightServerPort(value, environmentVariable) {
  if (!/^[1-9]\d*$/.test(value ?? "")) {
    throw new Error(
      `${environmentVariable} must be an integer from 1 to 65535`,
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error(
      `${environmentVariable} must be an integer from 1 to 65535`,
    );
  }
  return port;
}

function probeAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(
      { exclusive: true, host: PLAYWRIGHT_SERVER_HOST, port },
      () => {
        const address = server.address();
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(address.port);
          }
        });
      },
    );
  });
}

export async function selectPlaywrightServerPort(
  environmentVariable,
  environment = process.env,
) {
  const override = environment[environmentVariable];
  if (override === undefined) {
    return probeAvailablePort(0);
  }

  const port = parsePlaywrightServerPort(override, environmentVariable);
  try {
    return await probeAvailablePort(port);
  } catch (cause) {
    throw new Error(
      `${environmentVariable} port ${port} is unavailable on ${PLAYWRIGHT_SERVER_HOST}`,
      { cause },
    );
  }
}

export function playwrightServerOrigin(port) {
  return `http://${PLAYWRIGHT_SERVER_HOST}:${port}`;
}
