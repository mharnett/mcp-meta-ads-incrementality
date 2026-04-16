// ============================================
// CROSS-PLATFORM DISPATCH HELPERS
// ============================================

import envPaths from "env-paths";
import openModule from "open";
import { createServer } from "net";
import { platform } from "os";
import path from "path";

const paths = envPaths("mcp-meta-ads", { suffix: "nodejs" });

export const configDir = paths.config;
export const credentialsFilePath = path.join(paths.config, "credentials.json");

export async function openBrowser(url: string): Promise<void> {
  await openModule(url);
}

const LOOPBACK_PORT_RANGE_START = 8085;
const LOOPBACK_PORT_RANGE_END = 8199;

export async function findFreeLoopbackPort(): Promise<number> {
  for (let port = LOOPBACK_PORT_RANGE_START; port <= LOOPBACK_PORT_RANGE_END; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free port found in range ${LOOPBACK_PORT_RANGE_START}-${LOOPBACK_PORT_RANGE_END}.`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
