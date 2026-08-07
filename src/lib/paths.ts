import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  appRoot: string;
  dbPath: string;
  downloadsDir: string;
  logsDir: string;
  logPath: string;
  socketDir: string;
  socketPath: string;
  pidPath: string;
}

export function getAppPaths(): AppPaths {
  const home = homedir();
  const appRoot =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "dlm")
      : join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "dlm");

  const runtimeRoot =
    process.platform === "darwin"
      ? join(process.env.TMPDIR ?? tmpdir(), "dlm")
      : join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "dlm");

  return {
    appRoot,
    dbPath: join(appRoot, "state.db"),
    downloadsDir: join(appRoot, "downloads"),
    logsDir: join(appRoot, "logs"),
    logPath: join(appRoot, "logs", "daemon.log"),
    socketDir: runtimeRoot,
    socketPath: join(runtimeRoot, "dlm.sock"),
    pidPath: join(runtimeRoot, "dlmd.pid"),
  };
}

export function ensureAppPaths(paths: AppPaths): void {
  for (const dir of [paths.appRoot, paths.downloadsDir, paths.logsDir, paths.socketDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    chmodSync(dir, 0o700);
  }
}

