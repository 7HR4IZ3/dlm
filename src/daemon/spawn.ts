import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ApiClient } from "../api/client";
import type { AppPaths } from "../lib/paths";
import { sleep } from "../lib/time";

export async function ensureDaemon(paths: AppPaths): Promise<ApiClient> {
  const client = new ApiClient(paths.socketPath);
  if (await ping(client)) {
    return client;
  }

  const daemonEntry = resolve(new URL("../bin/dlmd.ts", import.meta.url).pathname);
  const bunBin = Bun.which("bun") ?? process.execPath;
  const cmd = existsSync(daemonEntry)
    ? [bunBin, "run", daemonEntry, "start", "--foreground"]
    : ["dlmd", "start", "--foreground"];

  const proc = Bun.spawn({
    cmd,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(250);
    if (await ping(client)) {
      return client;
    }
  }

  throw new Error("Unable to start daemon.");
}

async function ping(client: ApiClient): Promise<boolean> {
  try {
    return await client.health();
  } catch {
    return false;
  }
}

