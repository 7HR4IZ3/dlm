#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ApiClient } from "../api/client";
import { startApiServer } from "../api/server";
import { DaemonService } from "../daemon/service";
import { Logger } from "../lib/logger";
import { getAppPaths } from "../lib/paths";
import { readPidFile, removeFileIfExists, writePidFile } from "../lib/process";

const paths = getAppPaths();
const logger = new Logger(paths.logPath);

async function main(): Promise<void> {
  const [command = "start"] = Bun.argv.slice(2);

  switch (command) {
    case "start":
      await startDaemon();
      return;
    case "status":
      await printStatus();
      return;
    case "stop":
      await stopDaemon();
      return;
    case "logs":
      printLogs();
      return;
    default:
      console.log("dlmd start|status|stop|logs");
  }
}

async function startDaemon(): Promise<void> {
  removeFileIfExists(paths.socketPath);
  const service = new DaemonService(paths, logger);
  await service.init();
  service.startBackgroundLoops();
  writePidFile(paths.pidPath);
  const server = startApiServer(service, paths.socketPath);
  logger.info("Daemon started", { socket: paths.socketPath, pid: process.pid });

  const shutdown = () => {
    logger.info("Daemon shutting down");
    service.stopBackgroundLoops();
    server.stop(true);
    removeFileIfExists(paths.socketPath);
    removeFileIfExists(paths.pidPath);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
}

async function printStatus(): Promise<void> {
  const pid = readPidFile(paths.pidPath);
  const client = new ApiClient(paths.socketPath);
  const ok = await client.health().catch(() => false);
  if (!ok) {
    console.log(JSON.stringify({ ok: false, pid }, null, 2));
    return;
  }
  console.log(JSON.stringify({ ...(await client.daemonStatus()), pid }, null, 2));
}

async function stopDaemon(): Promise<void> {
  const client = new ApiClient(paths.socketPath);
  await client.shutdown().catch(() => {});
  removeFileIfExists(paths.socketPath);
  removeFileIfExists(paths.pidPath);
}

function printLogs(): void {
  try {
    const content = readFileSync(paths.logPath, "utf8");
    const lines = content.trim().split("\n");
    console.log(lines.slice(-200).join("\n"));
  } catch {
    console.log(`No log file at ${basename(paths.logPath)}`);
  }
}

await main();

