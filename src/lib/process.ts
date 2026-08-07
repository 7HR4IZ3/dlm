import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export function writePidFile(path: string): void {
  writeFileSync(path, String(process.pid), { mode: 0o600 });
}

export function readPidFile(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
}

export function removeFileIfExists(path: string): void {
  rmSync(path, { force: true });
}

